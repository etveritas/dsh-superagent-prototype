/**
 * WeChat iLink bot HTTP API: the long poll that delivers messages and the text reply that answers them.
 * The wire format is the documented one behind `openclaw-weixin`: JSON POSTs authenticated with the bot token, a
 * `base_info` on every body, and the server's own error codes carried in `ret` / `errcode` (either may be `-14`,
 * which means the token is stale and the login must run again).
 */
export const WEIXIN_API_BASE = 'https://ilinkai.weixin.qq.com'
/** The client version the documented client announces; it fills `channel_version` and the client-version header. */
export const WEIXIN_CHANNEL_VERSION = '2.4.10'
/** `ret` / `errcode` value that means the bot token no longer authenticates. */
export const STALE_TOKEN_ERRCODE = -14
/** What a send that hangs may take before it counts as a transport failure the Outbox retries. */
const SEND_TIMEOUT_MS = 30_000
/** The `bot_agent` a request declares when the account does not override it; observation only. */
const BOT_AGENT = 'dsh-superagent'
/** The iLink account this Source connects with; `baseUrl` overrides the public API for a private deployment. */
export interface WeixinEndpoint { token: string; baseUrl?: string; botAgent?: string }
/** A failed iLink call; `ret` and `errcode` are the codes the response carried, either of which may mark a stale token. */
export class WeixinApiError extends Error {
  constructor(message: string, readonly ret?: number, readonly errcode?: number) { super(message) }
}
/** Whether `error` means the bot token is stale, which needs a new login rather than a retry. */
export const isStaleToken = (error: unknown): boolean =>
  error instanceof WeixinApiError && (error.ret === STALE_TOKEN_ERRCODE || error.errcode === STALE_TOKEN_ERRCODE)
/** Base64 of the decimal string of a random uint32, the per-request identifier the iLink API requires. */
const randomUin = (): string => Buffer.from(String(Math.floor(Math.random() * 0x1_0000_0000)), 'utf8').toString('base64')
/** `MM.NN.PP` as the decimal of `0x00MMNNPP`, the form `iLink-App-ClientVersion` carries. */
function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(part => Number.parseInt(part, 10) || 0)
  return (major << 16) | (minor << 8) | patch
}
/** The headers of an authenticated bot POST; `Authorization` is left out when no token is set. */
export function ilinkHeaders(token?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', ...token ? { Authorization: `Bearer ${token}` } : {},
    'X-WECHAT-UIN': randomUin(), 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(clientVersion(WEIXIN_CHANNEL_VERSION)) }
}
/** The API base of an endpoint without a trailing slash, so paths append cleanly. */
const apiBase = (endpoint: WeixinEndpoint): string => (endpoint.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, '')
/** `base_info` on every body; `bot_agent` is observation only, so a blank one falls back to this plugin's name. */
const baseInfo = (endpoint: WeixinEndpoint): { channel_version: string; bot_agent: string } =>
  ({ channel_version: WEIXIN_CHANNEL_VERSION, bot_agent: endpoint.botAgent || BOT_AGENT })
/** The documented `getupdates` response; fields the protocol does not guarantee are optional here. */
interface UpdatesBody { ret?: number; errcode?: number; errmsg?: string; msgs?: unknown[]; get_updates_buf?: string; longpolling_timeout_ms?: number }
/** Rejects with a `WeixinApiError` when a response reports failure in `ret` or `errcode`. */
const fail = (body: { ret?: number; errcode?: number; errmsg?: string }, what: string): void => {
  const ret = Number(body.ret ?? 0)
  const errcode = Number(body.errcode ?? 0)
  if (ret === 0 && errcode === 0) return
  throw new WeixinApiError(body.errmsg || `WeChat ${what} failed (${ret === 0 ? errcode : ret})`, ret, errcode)
}
/**
 * Long-polls for messages, returning the ones that arrived and the cursor to send with the next request.
 * A client-side timeout is not a failure: the server answers nothing when no message arrived, so an expired budget
 * resolves an empty round. The caller's own abort is thrown, which is how the Source loop ends.
 */
export async function getUpdates(endpoint: WeixinEndpoint, input: { buf: string; timeoutMs: number; signal: AbortSignal }):
Promise<{ messages: unknown[]; buf: string; timeoutMs: number }> {
  const timeout = AbortSignal.timeout(input.timeoutMs + 5_000)
  const signal = AbortSignal.any([input.signal, timeout])
  let body: UpdatesBody
  try {
    const response = await fetch(`${apiBase(endpoint)}/ilink/bot/getupdates`,
      { method: 'POST', headers: ilinkHeaders(endpoint.token), body: JSON.stringify({ get_updates_buf: input.buf, base_info: baseInfo(endpoint) }), signal })
    if (!response.ok) throw new WeixinApiError(`WeChat getUpdates failed with HTTP ${response.status}`)
    body = await response.json() as UpdatesBody
  } catch (error) {
    if (input.signal.aborted) throw error
    // Only the budget above fired: no message came this round, which is not a failure.
    if (timeout.aborted) return { messages: [], buf: input.buf, timeoutMs: input.timeoutMs }
    throw error
  }
  fail(body, 'getUpdates')
  const longPoll = body.longpolling_timeout_ms !== undefined && body.longpolling_timeout_ms > 0
    ? Math.min(Math.max(body.longpolling_timeout_ms, 1_000), 120_000) : input.timeoutMs
  return { messages: Array.isArray(body.msgs) ? body.msgs : [],
    buf: body.get_updates_buf ? body.get_updates_buf : input.buf, timeoutMs: longPoll }
}
/** A fresh `client_id`; the server deduplicates retries by it, so two sends never share one. */
const clientId = (): string => `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
/** Sends one text message to `peer`, echoing the `context_token` of the message it answers when one is known. */
export async function sendMessage(endpoint: WeixinEndpoint, message: { peer: string; text: string; contextToken?: string }): Promise<void> {
  const response = await fetch(`${apiBase(endpoint)}/ilink/bot/sendmessage`, { method: 'POST', headers: ilinkHeaders(endpoint.token),
    body: JSON.stringify({ msg: { from_user_id: '', to_user_id: message.peer, client_id: clientId(), message_type: 2, message_state: 2,
      ...message.contextToken ? { context_token: message.contextToken } : {}, item_list: [{ type: 1, text_item: { text: message.text } }] },
      base_info: baseInfo(endpoint) }),
    // A send must not hang the Outbox; an unanswered send is a transport failure it retries.
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
  if (!response.ok) throw new WeixinApiError(`WeChat sendMessage failed with HTTP ${response.status}`)
  const body = await response.json() as { ret?: number; errcode?: number; errmsg?: string }
  const ret = Number(body.ret ?? 0)
  // The documented send response carries no `errcode`; a non-zero `ret` is the failure it describes.
  if (ret !== 0) throw new WeixinApiError(body.errmsg || `WeChat refused the message (${ret})`, ret, body.errcode === undefined ? undefined : Number(body.errcode))
}
