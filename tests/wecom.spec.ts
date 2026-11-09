import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WecomConfigSchema } from '../src/sources/wecom.ts'
import { sendWecom, truncateWecom, WECOM_MARKDOWN_MAX_BYTES } from '../src/sources/wecom-channel.ts'
import { forgetWecom, rememberWecom, wecomThreadContext } from '../src/sources/wecom-read.ts'
import { wecomText, wecomTrigger, wecomTriggerId } from '../src/sources/wecom-trigger.ts'
import { setActiveWecom, WecomConnection, type SocketListener, type WecomFrame, type WecomSocketLike } from '../src/sources/wecom-ws.ts'

/** A scripted WebSocket: it records what the connection writes and replays frames on demand. */
class FakeSocket implements WecomSocketLike {
  readonly sent: string[] = []
  private readonly listeners = new Map<string, SocketListener[]>()
  send(data: string): void { this.sent.push(data) }
  close(): void { /* Nothing to release. */ }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: SocketListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: 'open' | 'message' | 'close' | 'error', event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }
  push(frame: unknown): void { this.emit('message', { data: JSON.stringify(frame) }) }
  frames(): WecomFrame[] { return this.sent.map(text => JSON.parse(text) as WecomFrame) }
  last(): WecomFrame { return this.frames().at(-1)! }
}
const robot = { botId: 'bot-1', secret: 'secret-1' }
const handlers = () => ({ onReady: vi.fn(), onMessage: vi.fn(), onEvent: vi.fn(), onError: vi.fn(), onClosed: vi.fn() })
const opened = (): { socket: FakeSocket; client: WecomConnection; h: ReturnType<typeof handlers> } => {
  const socket = new FakeSocket()
  const h = handlers()
  const client = new WecomConnection(robot, h, () => socket)
  client.start()
  socket.emit('open')
  socket.push({ headers: { req_id: socket.last().headers.req_id }, errcode: 0 })
  return { socket, client, h }
}
const message = (over: Record<string, unknown> = {}) => ({ msgid: 'm-1', chattype: 'single', from: { userid: 'user-1' }, msgtype: 'text',
  text: { content: 'Please fix the build' }, create_time: 1_767_225_600, ...over })
afterEach(() => { vi.useRealTimers(); setActiveWecom(undefined) })

describe('wecom trigger', () => {
  it('turns a direct message into a Trigger with a deterministic id and ISO time', () => {
    const trigger = wecomTrigger(message(), 'bot-1')!
    expect(trigger).toMatchObject({ id: wecomTriggerId('m-1'), source: 'wecom', addressed: 'direct', text: 'Please fix the build',
      actor: { source: 'wecom', id: 'user-1' }, channel: { address: { chatId: 'user-1', messageId: 'm-1', direct: 'true' } },
      threads: [{ source: 'wecom', id: 'wecom:user-1' }], meta: { chatId: 'user-1', chattype: 'single', direct: true } })
    expect(trigger.at).toBe('2026-01-01T00:00:00.000Z')
  })
  it('addresses a group message to its chat and treats it as a mention', () => {
    const trigger = wecomTrigger(message({ chattype: 'group', chatid: 'chat-1' }), 'bot-1')!
    expect(trigger).toMatchObject({ addressed: 'mention', channel: { address: { chatId: 'chat-1', messageId: 'm-1' } },
      threads: [{ id: 'wecom:chat-1' }] })
    expect(trigger.channel!.address).not.toHaveProperty('direct')
  })
  it('drops the bot\'s own and unreadable messages', () => {
    expect(wecomTrigger(message({ from: { userid: 'bot-1' } }), 'bot-1')).toBeUndefined()
    expect(wecomTrigger({ msgid: '' }, 'bot-1')).toBeUndefined()
    expect(wecomTrigger('not a frame', 'bot-1')).toBeUndefined()
  })
  it('accepts a callback that names the receiving bot in aibotid, as WeCom sends it', () => {
    expect(wecomTrigger(message({ aibotid: 'bot-1' }), 'bot-1')).toMatchObject({ text: 'Please fix the build', addressed: 'direct',
      threads: [{ source: 'wecom', id: 'wecom:user-1' }] })
  })
  it('shows media as markers and a voice message as its transcription', () => {
    expect(wecomText({ msgid: 'm', msgtype: 'image', from: { userid: 'u' }, chattype: 'single' } as never)).toBe('[图片]')
    expect(wecomText({ msgid: 'm', msgtype: 'voice', from: { userid: 'u' }, chattype: 'single', voice: { content: 'transcribed' } } as never)).toBe('transcribed')
    expect(wecomText({ msgid: 'm', msgtype: 'mixed', from: { userid: 'u' }, chattype: 'single',
      mixed: { msg_item: [{ msgtype: 'text', text: { content: 'look' } }, { msgtype: 'image' }] } } as never)).toBe('look\n[图片]')
    expect(wecomText({ msgid: 'm', msgtype: 'mixed', from: { userid: 'u' }, chattype: 'single',
      mixed: { msg_item: [{ msgtype: 'text', text: { content: 'look' } }, { msgtype: 'file' }] } } as never)).toBe('look\n[文件]')
  })
  it('keeps the quoted message as text, because WeCom sends no id for it', () => {
    const trigger = wecomTrigger(message({ quote: { msgtype: 'text', text: { content: 'the earlier request' } } }), 'bot-1')!
    expect(trigger.meta.quote).toBe('the earlier request')
  })
})

describe('wecom long connection', () => {
  it('subscribes with the bot identity and reports readiness only after the ack', () => {
    const socket = new FakeSocket()
    const h = handlers()
    const client = new WecomConnection(robot, h, () => socket)
    client.start()
    expect(h.onReady).not.toHaveBeenCalled()
    socket.emit('open')
    expect(socket.last()).toMatchObject({ cmd: 'aibot_subscribe', body: { secret: 'secret-1', bot_id: 'bot-1' } })
    socket.push({ headers: { req_id: socket.last().headers.req_id }, errcode: 0, errmsg: 'ok' })
    expect(client.isAuthenticated).toBe(true)
    expect(h.onReady).toHaveBeenCalledOnce()
    client.close('test')
  })
  it('reports a refused subscription with its error code and ends the attempt', () => {
    const socket = new FakeSocket()
    const h = handlers()
    const client = new WecomConnection(robot, h, () => socket)
    client.start()
    socket.emit('open')
    socket.push({ headers: { req_id: socket.last().headers.req_id }, errcode: 40001, errmsg: 'invalid credential' })
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 40001 }))
    expect(h.onClosed).toHaveBeenCalledOnce()
    expect(client.isAuthenticated).toBe(false)
  })
  it('passes messages to the Source and subscribes before any reply is accepted', async () => {
    const { socket, client, h } = opened()
    socket.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'callback-1' }, body: message({ chatid: 'chat-1' }) })
    expect(h.onMessage).toHaveBeenCalledOnce()
    const sending = client.send('chat-1', { msgtype: 'markdown', markdown: { content: 'Done.' } })
    expect(socket.last()).toMatchObject({ cmd: 'aibot_send_msg', body: { chatid: 'chat-1', msgtype: 'markdown' } })
    socket.push({ headers: { req_id: socket.last().headers.req_id }, errcode: 0 })
    await expect(sending).resolves.toMatchObject({ errcode: 0 })
    client.close('test')
  })
  it('rejects a reply with WeCom\'s error code so the Outbox can decide', async () => {
    const { socket, client } = opened()
    const sending = client.send('chat-1', { msgtype: 'markdown', markdown: { content: 'Done.' } })
    socket.push({ headers: { req_id: socket.last().headers.req_id }, errcode: 86003, errmsg: 'chat not found' })
    await expect(sending).rejects.toMatchObject({ code: 86003 })
    client.close('test')
  })
  it('stops when another connection subscribes with the same bot', () => {
    const { socket, client, h } = opened()
    socket.push({ cmd: 'aibot_event_callback', headers: { req_id: 'event-1' },
      body: { msgid: 'e-1', msgtype: 'event', event: { eventtype: 'disconnected_event' } } })
    expect(client.isTakenOver).toBe(true)
    expect(h.onClosed).toHaveBeenCalledWith(expect.any(String), true)
  })
  it('connects to a gateway that matches handshake header names case-sensitively, as WeCom does', async () => {
    const server = createServer()
    const gateway = new WebSocketServer({ noServer: true })
    // WeCom's gateway answers a lowercase `connection`/`upgrade` with 404; Node's built-in WebSocket sends them that way.
    server.on('upgrade', (request, socket, head) => {
      const names = new Set<string>()
      for (let index = 0; index < request.rawHeaders.length; index += 2) names.add(request.rawHeaders[index]!)
      if (!names.has('Connection') || !names.has('Upgrade')) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        return
      }
      gateway.handleUpgrade(request, socket, head, ws => { gateway.emit('connection', ws, request) })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    gateway.on('connection', socket => {
      socket.on('message', data => {
        const frame = JSON.parse(String(data)) as WecomFrame
        if (frame.cmd === 'aibot_subscribe') socket.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0 }))
      })
    })
    const h = handlers()
    const client = new WecomConnection({ botId: 'bot-1', secret: 'secret-1', wsUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` }, h)
    try {
      client.start()
      await vi.waitFor(() => expect(h.onReady).toHaveBeenCalledOnce(), { timeout: 3000 })
    } finally {
      client.close('test')
      await new Promise<void>(resolve => gateway.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('wecom channel', () => {
  it('sends the reply as markdown into the message\'s conversation', async () => {
    const { socket, client } = opened()
    setActiveWecom(client)
    const sending = sendWecom({} as never, { id: 'out-1', kind: 'reply', text: 'Done.',
      channel: { source: 'wecom', thread: 'wecom:chat-1', address: { chatId: 'chat-1', messageId: 'm-1' } } })
    expect(socket.last()).toMatchObject({ cmd: 'aibot_send_msg', body: { chatid: 'chat-1', msgtype: 'markdown', markdown: { content: 'Done.' } } })
    socket.push({ headers: { req_id: socket.last().headers.req_id }, errcode: 0 })
    await expect(sending).resolves.toBe('sent')
    client.close('test')
  })
  it('refuses to reply while no connection is open, so the Outbox retries later', async () => {
    setActiveWecom(undefined)
    await expect(sendWecom({} as never, { id: 'out-2', kind: 'reply', text: 'Done.',
      channel: { source: 'wecom', thread: 'wecom:chat-1', address: { chatId: 'chat-1', messageId: 'm-1' } } })).rejects.toThrow('not open')
  })
  it('truncates markdown to the byte limit WeCom accepts', () => {
    const truncated = truncateWecom('中'.repeat(WECOM_MARKDOWN_MAX_BYTES))
    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(WECOM_MARKDOWN_MAX_BYTES)
    expect(truncated.endsWith('…')).toBe(true)
    expect(truncateWecom('short')).toBe('short')
  })
})

describe('wecom thread context', () => {
  const read = (trigger: NonNullable<ReturnType<typeof wecomTrigger>>, part: 'thread' | 'root' | 'parent') =>
    wecomThreadContext.read({} as never, trigger, part, undefined, WecomConfigSchema.parse({}))
  afterEach(() => forgetWecom())
  it('reads the remembered window of the conversation', async () => {
    rememberWecom('chat-1', { id: 'm-1', from: 'user-1', at: '2026-01-01T00:00:00.000Z', text: 'first' })
    rememberWecom('chat-1', { id: 'm-2', from: 'user-2', at: '2026-01-01T00:01:00.000Z', text: 'second' })
    const trigger = wecomTrigger(message({ msgid: 'm-2', chattype: 'group', chatid: 'chat-1' }), 'bot-1')!
    const thread = await read(trigger, 'thread')
    expect(thread).toMatchObject({ status: 'available', messages: [{ id: 'm-1', text: 'first' }, { id: 'm-2', text: 'second' }] })
    const root = await read(trigger, 'root')
    expect(root).toMatchObject({ status: 'available', messages: [{ id: 'm-1' }] })
  })
  it('reads the quoted message, or says there is none', async () => {
    const plain = wecomTrigger(message({ msgid: 'm-3', chattype: 'group', chatid: 'chat-1' }), 'bot-1')!
    expect(await read(plain, 'parent')).toMatchObject({ status: 'no_parent', messages: [] })
    const quoted = wecomTrigger(message({ msgid: 'm-4', chattype: 'group', chatid: 'chat-1',
      quote: { msgtype: 'text', text: { content: 'earlier' } } }), 'bot-1')!
    expect(await read(quoted, 'parent')).toMatchObject({ status: 'available', messages: [{ text: 'earlier' }] })
  })
})
