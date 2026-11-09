/**
 * WeCom intelligent-robot (aibot) long connection: subscription, heartbeat, message callbacks and proactive replies.
 * The wire protocol is the documented one behind `@wecom/aibot-node-sdk`: `{ cmd, headers: { req_id }, body }` both ways,
 * an ack carrying `errcode`, and `aibot_msg_callback` / `aibot_event_callback` frames pushed by WeCom.
 */
import WebSocket from 'ws'
export const DEFAULT_WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'
/** How often the connection pings; WeCom drops a silent connection. */
export const WECOM_HEARTBEAT_MS = 30_000
/** How long an ack (subscription, heartbeat or sent message) may take before the connection treats it as lost. */
export const WECOM_ACK_TIMEOUT_MS = 15_000
/** Unanswered pings after which the connection is treated as dead, even if the socket still looks open. */
export const WECOM_MAX_MISSED_PONGS = 2

/** One WebSocket frame; `headers.req_id` ties a reply or an ack to the request that caused it. */
export interface WecomFrame { cmd?: string; headers: { req_id: string } & Record<string, unknown>; body?: unknown; errcode?: number; errmsg?: string }
/** The bot credentials the long connection authenticates with. */
export interface WecomRobot { botId: string; secret: string; wsUrl?: string | undefined }
/** What the connection reports; the Source loop turns these into health and Triggers. */
export interface WecomHandlers {
  /** WeCom acknowledged the subscription: messages for this bot now arrive here. */
  onReady(): void
  onMessage(frame: WecomFrame): void
  onEvent(frame: WecomFrame): void
  onError(error: Error): void
  /** The socket ended; `takenOver` is true when another connection subscribed with the same bot. */
  onClosed(reason: string, takenOver: boolean): void
}
export type SocketListener = (event: { data?: unknown; code?: number; reason?: string }) => void
/** The WebSocket surface the connection needs, so tests can drive it with a scripted socket. */
export interface WecomSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: SocketListener): void
}
/**
 * WeCom's gateway matches the handshake's `Connection`/`Upgrade` header names case-sensitively and answers anything else
 * with 404. Node's built-in WebSocket (undici) lower-cases header names, so it cannot connect; `ws` sends the canonical
 * names the gateway accepts.
 */
const defaultSocket = (url: string): WecomSocketLike => new WebSocket(url) as unknown as WecomSocketLike
/** An ack carrying a non-zero `errcode`; `code` is WeCom's error code. */
export class WecomAckError extends Error {
  constructor(message: string, readonly code: number) { super(message) }
}
let sequence = 0
const requestId = (prefix: string): string => `${prefix}-${Date.now()}-${sequence++}`
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))
/** The connection that is authenticated now, for Channels that reply outside the loop; one process runs one bot. */
let active: WecomConnection | undefined
export const activeWecom = (): WecomConnection | undefined => active
export const setActiveWecom = (connection: WecomConnection | undefined): void => { active = connection }

/**
 * One long connection attempt. It never reconnects on its own: the Source loop opens a new one after `onClosed`, so
 * backoff, health and the Source switch stay in one place.
 */
export class WecomConnection {
  private socket?: WecomSocketLike
  private readonly waiting = new Map<string, { resolve(frame: WecomFrame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private heartbeat?: ReturnType<typeof setInterval>
  private authTimer?: ReturnType<typeof setTimeout>
  private subscribeReq = ''
  private pingReq = ''
  private missedPongs = 0
  private authenticated = false
  private ended = false
  private takenOver = false
  constructor(private readonly robot: WecomRobot, private readonly handlers: WecomHandlers,
    private readonly socketOf: (url: string) => WecomSocketLike = defaultSocket) {}
  get isAuthenticated(): boolean { return this.authenticated && !this.ended }
  get isTakenOver(): boolean { return this.takenOver }
  /** Opens the socket and subscribes; every failure ends in `onClosed` so the caller can retry. */
  start(): void {
    let socket: WecomSocketLike
    try { socket = this.socketOf(this.robot.wsUrl || DEFAULT_WECOM_WS_URL) }
    catch (error) { this.handlers.onError(asError(error)); this.finish('The WebSocket could not be opened'); return }
    this.socket = socket
    socket.addEventListener('open', () => {
      this.subscribeReq = requestId('subscribe')
      this.write({ cmd: 'aibot_subscribe', headers: { req_id: this.subscribeReq }, body: { secret: this.robot.secret, bot_id: this.robot.botId } })
      this.authTimer = setTimeout(() => this.finish('WeCom did not acknowledge the subscription'), WECOM_ACK_TIMEOUT_MS)
    })
    socket.addEventListener('message', event => this.read(event.data))
    socket.addEventListener('close', () => this.finish('The WeCom connection closed'))
    socket.addEventListener('error', () => this.handlers.onError(new Error('The WeCom connection failed')))
  }
  /** Ends the attempt, rejecting pending replies with `reason`. */
  close(reason: string): void { this.finish(reason) }
  /** Sends a markdown reply into `chatid` (a group id, or the userid of a single chat) and waits for its ack. */
  async send(chatid: string, body: Record<string, unknown>): Promise<WecomFrame> {
    if (!this.isAuthenticated) throw new Error('The WeCom long connection is not authenticated')
    const reqId = requestId('send')
    const ack = new Promise<WecomFrame>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(reqId); reject(new Error('WeCom did not acknowledge the message in time')) }, WECOM_ACK_TIMEOUT_MS)
      this.waiting.set(reqId, { resolve, reject, timer })
    })
    this.write({ cmd: 'aibot_send_msg', headers: { req_id: reqId }, body: { chatid, ...body } })
    return ack
  }
  private write(frame: WecomFrame): void {
    try { this.socket?.send(JSON.stringify(frame)) }
    catch (error) { this.handlers.onError(asError(error)) }
  }
  private read(raw: unknown): void {
    let frame: WecomFrame
    try { frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as WecomFrame }
    catch { this.handlers.onError(new Error('WeCom sent a frame that is not JSON')); return }
    const reqId = frame?.headers?.req_id
    if (typeof reqId !== 'string') { this.handlers.onError(new Error('WeCom sent a frame without a request id')); return }
    if (frame.cmd === 'aibot_msg_callback') { this.handlers.onMessage(frame); return }
    if (frame.cmd === 'aibot_event_callback') { this.handleEvent(frame); return }
    if (reqId === this.subscribeReq) { this.handleSubscribe(frame); return }
    if (reqId === this.pingReq) { this.missedPongs = 0; return }
    this.handleAck(frame)
  }
  private handleSubscribe(frame: WecomFrame): void {
    const code = frame.errcode ?? 0
    if (code) { this.handlers.onError(new WecomAckError(frame.errmsg || `WeCom refused the subscription (${code})`, code)); this.finish('WeCom refused the subscription'); return }
    this.authenticated = true
    if (this.authTimer) clearTimeout(this.authTimer)
    this.startHeartbeat()
    this.handlers.onReady()
  }
  private handleEvent(frame: WecomFrame): void {
    const event = (frame.body as { event?: { eventtype?: string } } | undefined)?.event
    if (event?.eventtype === 'disconnected_event') {
      this.takenOver = true
      this.handlers.onEvent(frame)
      this.finish('Another connection subscribed with this bot')
      return
    }
    this.handlers.onEvent(frame)
  }
  private handleAck(frame: WecomFrame): void {
    const waiter = this.waiting.get(frame.headers.req_id)
    if (!waiter) return
    this.waiting.delete(frame.headers.req_id)
    clearTimeout(waiter.timer)
    const code = frame.errcode ?? 0
    if (code) waiter.reject(new WecomAckError(frame.errmsg || `WeCom refused the message (${code})`, code))
    else waiter.resolve(frame)
  }
  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.ended) return
      if (this.missedPongs >= WECOM_MAX_MISSED_PONGS) { this.finish('WeCom stopped answering heartbeats'); return }
      this.missedPongs += 1
      this.pingReq = requestId('ping')
      this.write({ cmd: 'ping', headers: { req_id: this.pingReq } })
    }, WECOM_HEARTBEAT_MS)
  }
  private finish(reason: string): void {
    if (this.ended) return
    this.ended = true
    if (this.authTimer) clearTimeout(this.authTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const [, waiter] of this.waiting) { clearTimeout(waiter.timer); waiter.reject(new Error(reason)) }
    this.waiting.clear()
    try { this.socket?.close() } catch { /* The socket may already be gone. */ }
    this.handlers.onClosed(reason, this.takenOver)
  }
}
