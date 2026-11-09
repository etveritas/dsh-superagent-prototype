/**
 * Interactive WeChat iLink QR login for the WeChat Source: asks the fixed iLink endpoint for a code, polls its
 * status until the phone confirms, and answers the bot token as the Source's credentials.
 * The panel drives it through `SourceLogin`; nothing here runs until an operator presses the button.
 *
 * Protocol notes (openclaw-weixin `docs/protocol_zh_CN.md`): login always starts at `https://ilinkai.weixin.qq.com`,
 * never at the Source's configurable API base, because the API base is itself a login result. `qrcode_img_content`
 * is the string to encode; `qrcode` is only the status handle.
 */
import qrcode from 'qrcode-generator'
import type { LoginView, SourceLogin } from './kind.ts'

const API_BASE = 'https://ilinkai.weixin.qq.com'
const START_PATH = '/ilink/bot/get_bot_qrcode?bot_type=3'
const STATUS_PATH = '/ilink/bot/get_qrcode_status'
/** The documented client version; the endpoint reads it as `0x00MMNNPP` in a decimal string. */
const CLIENT_VERSION = '2.4.10'
/** A status poll may wait on the server; aborting at this point is a network error the panel retries. */
const POLL_TIMEOUT_MS = 35_000
/** One attempt lives this long; a stale attempt is dropped instead of polling a code the server forgot. */
const ATTEMPT_TTL_MS = 5 * 60_000
/** A code expires quickly on the server; this many replacements keep one attempt usable before giving up. */
const MAX_REFRESHES = 3
/** A failure the panel cannot word from the status alone; routine statuses are localized by the panel itself. */
const BOUND = 'This WeChat bot is already bound to another account; unbind it there and scan again.'
/** Start answer; only the two fields the panel needs are read (the token is deliberately not part of a start response). */
interface QrStart { qrcode?: string; qrcode_img_content?: string }
/** Poll answer; every field is optional because a status the protocol adds later must not break polling. */
interface QrStatus {
  status?: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}
/** The live login attempt: its status handle, the SVG already built, the host to poll, and the remaining refreshes. */
interface Attempt {
  qrcode: string
  svg: string
  /** Poll target; the fixed base until `scaned_but_redirect` names another host. */
  host: string
  /** The code the phone displayed, sent with the next poll while the attempt needs it. */
  verifyCode?: string
  refreshes: number
  expiresAt: number
}
let attempt: Attempt | undefined

/** Drops the live attempt; tests use it to start each spec from no login. */
export function forgetWeixinLogin(): void { attempt = undefined }

/** `2.4.10` as the decimal of `0x0002040A`, the form `iLink-App-ClientVersion` carries. */
function clientVersion(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(part => Number.parseInt(part, 10) || 0)
  return String((major << 16) | (minor << 8) | patch)
}
/** Base64 of a random uint32 written in decimal, the per-request identifier the iLink login endpoints require. */
const randomUin = (): string => Buffer.from(String(Math.floor(Math.random() * 0x1_0000_0000)), 'utf8').toString('base64')
/** Headers the login endpoints expect; there is no bot token yet, so `Authorization` is absent. */
const appHeaders = (): Record<string, string> => ({ 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': clientVersion(CLIENT_VERSION),
  'X-WECHAT-UIN': randomUin(), AuthorizationType: 'ilink_bot_token' })

/** Renders a QR code from the fixed generator's own markup; the panel injects it as HTML, so no request data is concatenated. */
function qrSvg(content: string): string {
  const code = qrcode(0, 'M')
  code.addData(content)
  code.make()
  return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}
/** One JSON request with the login's client timeout; a non-2xx answer is a transport failure the caller maps. */
async function requestJson<T>(url: string, init: RequestInit, timeoutMs = POLL_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`The WeChat login endpoint failed with HTTP ${response.status}`)
  return await response.json() as T
}
/** Fetches a fresh code and its rendered SVG; the attempt keeps only these two, never the raw response. */
async function fetchCode(): Promise<{ qrcode: string; svg: string }> {
  const body = await requestJson<QrStart>(`${API_BASE}${START_PATH}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...appHeaders() }, body: JSON.stringify({ local_token_list: [] }) })
  if (!body.qrcode || !body.qrcode_img_content) throw new Error('The WeChat login response carried no QR code')
  return { qrcode: body.qrcode, svg: qrSvg(body.qrcode_img_content) }
}
/** The live attempt, dropping one past its TTL so `start` fetches a new code instead of polling a forgotten one. */
function live(): Attempt | undefined {
  if (attempt && Date.now() < attempt.expiresAt) return attempt
  attempt = undefined
  return undefined
}
/** The code view of a live attempt; `start` answers this because it must not long-poll inside the HTTP request. */
function codeView(running: Attempt): LoginView {
  return { status: 'wait', svg: running.svg }
}
/** One status poll, against the redirect host once the phone was scanned through another one. */
async function pollStatus(running: Attempt): Promise<QrStatus> {
  const verify = running.verifyCode ? `&verify_code=${encodeURIComponent(running.verifyCode)}` : ''
  return requestJson<QrStatus>(`${running.host}${STATUS_PATH}?qrcode=${encodeURIComponent(running.qrcode)}${verify}`,
    { method: 'GET', headers: appHeaders() })
}
/**
 * Replaces an expired code while the attempt still has refreshes; the TTL is not extended, so one attempt never
 * lives longer than a login should. A failed refresh keeps the old code, and the next expired poll counts again.
 */
async function refresh(running: Attempt): Promise<LoginView> {
  if (running.refreshes >= MAX_REFRESHES) {
    attempt = undefined
    return { status: 'expired' }
  }
  running.refreshes += 1
  try {
    const fresh = await fetchCode()
    // Another start may have replaced the attempt while this code was fetched; never resurrect the old one.
    if (attempt !== running) return { status: 'expired' }
    running.qrcode = fresh.qrcode
    running.svg = fresh.svg
    running.verifyCode = undefined
    return codeView(running)
  } catch {
    // The panel retries on the next poll; the old code is stale, so that poll either refreshes again or gives up.
    return codeView(running)
  }
}
/** Starts a new attempt, or returns the live one, with the code to show; never long-polls here. */
async function start(): Promise<LoginView> {
  const running = live()
  if (running) return codeView(running)
  const fresh = await fetchCode()
  attempt = { ...fresh, host: API_BASE, refreshes: 0, expiresAt: Date.now() + ATTEMPT_TTL_MS }
  return codeView(attempt)
}
/**
 * Polls the live attempt exactly once and maps the protocol status to a panel view.
 * A network failure is not terminal: it answers `wait` so the next poll retries, because the phone may be
 * confirming while the network hiccups.
 */
async function wait(): Promise<LoginView> {
  const running = live()
  if (!running) return { status: 'expired' }
  let status: QrStatus
  try { status = await pollStatus(running) } catch { return codeView(running) }
  switch (status.status) {
    case 'wait': return codeView(running)
    case 'scaned': return { status: 'scaned', svg: running.svg }
    // The phone displays a code; the panel asks for it and the next poll carries it.
    case 'need_verifycode': return { status: 'need_verifycode', svg: running.svg }
    case 'confirmed': {
      attempt = undefined
      const token = status.bot_token
      if (!token) return { status: 'failed', message: 'The WeChat login finished without a bot token; start again.' }
      return { status: 'confirmed', credentials: { token, ...status.baseurl ? { baseUrl: status.baseurl } : {} } }
    }
    case 'expired': return refresh(running)
    case 'verify_code_blocked':
      attempt = undefined
      return { status: 'blocked' }
    case 'scaned_but_redirect':
      // The phone scanned through another iLink host; the next poll must go there. The protocol gives a bare host.
      if (status.redirect_host) running.host = `https://${status.redirect_host}`
      return codeView(running)
    case 'binded_redirect':
      attempt = undefined
      return { status: 'failed', message: BOUND }
    // An unknown status is not a reason to drop a scanned code: keep showing it and try the next status name.
    default: return codeView(running)
  }
}
/** Stores the code the phone shows; the next poll submits it and only then can this become `confirmed`. */
async function verify(code: string): Promise<LoginView> {
  const running = live()
  if (!running) return { status: 'expired' }
  running.verifyCode = code.trim() || undefined
  return { status: 'need_verifycode', svg: running.svg }
}

/** The QR login the WeChat Source offers on its settings card. */
export const weixinLogin: SourceLogin = {
  label: { zh: '扫码登录', en: 'Log in by scanning' },
  hint: { zh: '用手机微信扫描二维码，并在手机上确认登录。', en: 'Scan the QR code with WeChat on your phone, then confirm there.' },
  start,
  wait,
  verify,
}
