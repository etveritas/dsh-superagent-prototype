/** WeChat Source kind: the iLink bot long poll, its Triggers, replies, and the loop that runs it. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey, type Trigger } from '../core/index.ts'
import { WeixinAccountSchema, type WeixinAccount } from '../deployment.ts'
import { KV } from '../kv.ts'
import { checkedImText } from '../infra/text.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'
import type { SourceRegistry } from './registry.ts'
import { getUpdates, isStaleToken } from './weixin-api.ts'
import { sendWeixin, setActiveWeixin, weixinLink } from './weixin-channel.ts'
import { weixinLogin } from './weixin-login.ts'
import { rememberToken, rememberWeixin, weixinThreadContext } from './weixin-read.ts'
import { SOURCE, weixinPeer, weixinTrigger } from './weixin-trigger.ts'

/** The Source's configuration is the bot account the panel logs in; the long poll uses nothing else. */
export const WeixinConfigSchema = WeixinAccountSchema
export type WeixinConfig = ReturnType<typeof WeixinConfigSchema.parse>
/** How long one `getUpdates` call may wait for messages before the server answers with none, until it suggests another. */
export const WEIXIN_LONG_POLL_MS = 35_000
/** Consecutive failed rounds before the Source reports an error and backs off; one failure is retried at once. */
const MAX_FAILURES = 3
const BACKOFF_MS = 30_000
const RETRY_MS = 2_000
/** A stale token (`-14`) cannot recover by polling again: the account must log in again, so the Source stops for an hour. */
export const STALE_TOKEN_PAUSE_MS = 3_600_000
export const STALE_TOKEN_NOTE = 'The WeChat bot token is stale; log in again on the WeChat Source\'s card in the panel'
export const weixinKind: SourceKind<WeixinConfig> = {
  kind: SOURCE,
  chat: true,
  title: { zh: '微信', en: 'WeChat' },
  description: { zh: '通过扫码登录的微信机器人长轮询接收私聊消息，并在同一会话中回复。', en: 'Receives the direct messages of a WeChat bot logged in by scanning a code, and replies in the same conversation.' },
  schema: WeixinConfigSchema,
  fields: [
    { key: 'token', type: 'text', label: { zh: '机器人 token', en: 'Bot token' },
      hint: { zh: '把手机微信扫码登录得到；在来源卡片上点「扫码登录」会填好它，保存后重启 dsh-superagent。', en: 'Produced by scanning the login code with WeChat; the Log in by scanning button on this card fills it in, and saving restarts dsh-superagent.' } },
    { key: 'baseUrl', type: 'text', advanced: true, label: { zh: '接口地址', en: 'API base URL' },
      hint: { zh: '登录返回了别的地址时填它；留空使用 https://ilinkai.weixin.qq.com。', en: 'The address the login returned when it differs; leave it empty to use https://ilinkai.weixin.qq.com.' } },
    { key: 'botAgent', type: 'text', advanced: true, label: { zh: '观测标识 bot_agent', en: 'bot_agent tag' },
      hint: { zh: '只用于后端日志和监控归因，不参与鉴权或路由；留空使用 dsh-superagent。', en: 'Used only for the backend\'s logs and monitoring, never for authorization or routing; leave it empty to use dsh-superagent.' } },
  ],
  health: ['weixin'],
  // The bot only receives what people send it directly, so every received message is listened to and none is observed unaddressed.
  scope: () => ({ listened: true, observed: false, row: 'direct' }),
  channel: { allowed: () => true, check: message => { checkedImText(message.text) }, send: sendWeixin, link: weixinLink },
  threadContext: weixinThreadContext,
  login: weixinLogin,
  policy: {
    unnamed: { person: { zh: '微信用户', en: 'WeChat user' }, bot: { zh: '微信机器人', en: 'WeChat bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(128), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user ids').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信用户', en: 'WeChat users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 id', en: 'User id' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who messages the bot directly always makes an explicit request; that needs no setting.' },
    rows: () => [
      { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '接收', en: 'Received' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    ],
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEIXIN_CHAT', description: { zh: '工单所在的微信会话；工单不是从微信来的时为空', en: 'The WeChat conversation of the ticket; empty when the ticket did not start on WeChat' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_WEIXIN_CHAT: trigger?.source === SOURCE ? weixinPeer(trigger) ?? '' : '' }),
  },
}
/** Returns the WeChat Source's settings, falling back to schema defaults while the plugin is disabled. */
export const weixinSettings = (sources: SourceRegistry): WeixinConfig => sources.instance<WeixinConfig>(SOURCE)?.config ?? WeixinConfigSchema.parse({})

export const name = 'dsh-superagent-weixin'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(weixinKind), 'weixin: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const source = sourceContext(ctx.orchestrator, weixinKind)
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = runWeixin(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/**
 * Keeps the long poll running while the Source is enabled: it reports health, turns each message into a Trigger, and
 * stops for an hour when the token is stale. Setup restarts dsh-superagent, and the Source's fields are setup-read, so a
 * new account arrives already resolved.
 */
export async function runWeixin(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  let timeoutMs = WEIXIN_LONG_POLL_MS
  while (!signal.aborted) {
    const config = ctx.config<WeixinConfig>(SOURCE)
    // Setup resolves the account from these settings; while it has not, or the token is blank, nothing polls.
    const account = ctx.configured() ? ctx.deployment.weixin : undefined
    if (!config || !account) {
      setActiveWeixin(undefined)
      ctx.report(SOURCE, health('paused', !config ? 'sourceOff' : ctx.configured() ? 'weixinUnset' : 'setupPending'))
      await pause(RETRY_MS, signal)
      continue
    }
    // Replies after this round go out through the account the poll authenticates with.
    setActiveWeixin(account)
    try {
      const round = await pollWeixin(ctx, account, timeoutMs, signal)
      timeoutMs = round.timeoutMs
      failures = 0
      ctx.report(SOURCE, { state: 'ready', detail: `${round.read} messages`, at: new Date().toISOString() })
    } catch (error) {
      if (signal.aborted) return
      if (isStaleToken(error)) {
        ctx.report(SOURCE, { state: 'error', detail: STALE_TOKEN_NOTE })
        await pause(STALE_TOKEN_PAUSE_MS, signal)
        continue
      }
      failures += 1
      // One network failure is retried at once; three in a row need a person.
      if (failures >= MAX_FAILURES) {
        failures = 0
        ctx.report(SOURCE, health('error', 'pollFailures', { count: String(MAX_FAILURES), error: String(error) }))
        await pause(BACKOFF_MS, signal)
      } else await pause(RETRY_MS, signal)
    }
  }
}
/** One long poll: takes in every message it carried, then moves the stored cursor past them. */
export async function pollWeixin(ctx: SourceContext, account: WeixinAccount, timeoutMs: number, signal: AbortSignal):
  Promise<{ read: number; timeoutMs: number }> {
  const buf = ctx.state.get(KV.weixin.buf) ?? ''
  const page = await getUpdates(account, { buf, timeoutMs, signal })
  let read = 0
  for (const item of page.messages) {
    if (signal.aborted) throw new Error('The WeChat Source stopped during the read')
    const trigger = weixinTrigger(item)
    if (!trigger) continue
    read += 1
    await take(ctx, trigger)
  }
  // The cursor moves only once every Trigger it covered is stored, so an interrupted round replays instead of dropping.
  if (page.buf && page.buf !== buf) ctx.state.set(KV.weixin.buf, page.buf)
  return { read, timeoutMs: page.timeoutMs }
}
/** Takes one Trigger in: the conversation's memory for reads, its latest reply token, and the Thread's facts. */
async function take(ctx: SourceContext, trigger: Trigger): Promise<void> {
  const peer = weixinPeer(trigger) ?? ''
  const token = typeof trigger.meta.contextToken === 'string' ? trigger.meta.contextToken : undefined
  if (peer) {
    rememberWeixin(peer, { id: String(trigger.meta.messageId ?? ''), from: String(trigger.actor.id), at: trigger.at, text: trigger.text })
    // The backend expects a reply to echo the token of the message it answers; the remembered latest one is the freshest.
    if (token) rememberToken(peer, token)
  }
  await ctx.receive(trigger)
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation: { value: { zh: '微信私聊', en: 'WeChat direct chat' } } } })
}
