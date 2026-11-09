/** WeCom Source kind: the intelligent-robot long connection, its Triggers, replies, and the loop that runs it. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import { WecomBotSchema } from '../deployment.ts'
import { checkedImText } from '../infra/text.ts'
import { pause } from './poll.ts'
import { wecomLink, sendWecom } from './wecom-channel.ts'
import { rememberWecom, wecomThreadContext } from './wecom-read.ts'
import { SOURCE, wecomChat, wecomImages, wecomTrigger } from './wecom-trigger.ts'
import { setActiveWecom, WecomConnection, type WecomFrame, type WecomRobot } from './wecom-ws.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

/** The Source's configuration is the bot identity setup resolves; the long connection uses nothing else. */
export const WecomConfigSchema = WecomBotSchema
export type WecomConfig = ReturnType<typeof WecomConfigSchema.parse>
/** Reported when another process subscribes with the same bot: WeCom keeps one connection per bot, so this one stops. */
export const TAKEN_OVER = 'Another dsh-superagent instance subscribed to this WeCom bot; stop it, then restart this one'
export const wecomKind: SourceKind<WecomConfig> = {
  kind: SOURCE,
  chat: true,
  title: { zh: '企业微信', en: 'WeCom' },
  description: { zh: '通过智能机器人的长连接接收私聊和 @ 机器人的群消息，并在同一会话中回复。', en: 'Receives the messages a WeCom intelligent robot is addressed in over its long connection, and replies in the same conversation.' },
  schema: WecomConfigSchema,
  fields: [
    { key: 'botId', type: 'text', label: { zh: '机器人 ID', en: 'Bot ID' },
      hint: { zh: '企业微信管理后台里智能机器人的 ID；保存后重启 dsh-superagent，长连接由它订阅。', en: 'The intelligent robot\'s ID in the WeCom admin console; saving restarts dsh-superagent, whose long connection subscribes with it.' } },
    { key: 'secret', type: 'text', advanced: true, label: { zh: '机器人 Secret', en: 'Bot secret' },
      hint: { zh: '与机器人 ID 配套的 Secret，保存在本机设置数据库里；它只用于这条长连接。', en: 'The secret that pairs with the bot ID, kept in this installation\'s settings database; it is used only for this long connection.' } },
    { key: 'wsUrl', type: 'text', advanced: true, label: { zh: '长连接地址', en: 'Long-connection URL' },
      hint: { zh: '私有部署的企业填写管理端给出的长连接地址；留空使用 wss://openws.work.weixin.qq.com。', en: 'For a private deployment, the long-connection URL its admin console gives; leave it empty to use wss://openws.work.weixin.qq.com.' } },
  ],
  health: ['wecom'],
  // The robot only receives what addresses it, so every received message is listened to and none is observed unaddressed.
  scope: ({ meta }) => ({ listened: true, observed: false, row: meta.direct === true || meta.chattype === 'single' ? 'direct' : 'group' }),
  channel: { allowed: () => true, check: message => { checkedImText(message.text) }, send: sendWecom, link: wecomLink },
  threadContext: wecomThreadContext,
  policy: {
    unnamed: { person: { zh: '企业微信用户', en: 'WeCom user' }, bot: { zh: '企业微信机器人', en: 'WeCom bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(64), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate userids').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的企业微信用户', en: 'WeCom users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'userid', en: 'userid' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人私聊机器人或在群里 @ 机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who messages the bot directly or mentions it in a group always makes an explicit request; that needs no setting.' },
    rows: () => [
      { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '接收', en: 'Received' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'group', label: { zh: '群聊', en: 'Group chats' }, note: { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    ],
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WECOM_CHAT', description: { zh: '工单所在的企微会话；工单不是从企业微信来的时为空', en: 'The WeCom conversation of the ticket; empty when the ticket did not start on WeCom' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_WECOM_CHAT: trigger?.source === SOURCE ? wecomChat(trigger) ?? '' : '' }),
  },
}
/** Returns the WeCom Source's settings, falling back to schema defaults while the plugin is disabled. */
export const wecomSettings = (sources: SourceRegistry): WecomConfig => sources.instance<WecomConfig>(SOURCE)?.config ?? WecomConfigSchema.parse({})

export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind), 'wecom: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const source = sourceContext(ctx.orchestrator, wecomKind)
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = runWecom(source, controller.signal)
      .catch((error: unknown) => { source.report('wecom', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** True when the loop's configuration still matches the connection's bot. */
const sameBot = (config: WecomConfig, robot: WecomRobot): boolean =>
  config.botId === robot.botId && config.secret === robot.secret && (config.wsUrl ?? '') === (robot.wsUrl ?? '')
/**
 * Keeps the bot's long connection open while the Source is enabled: it reconnects with exponential backoff, reports
 * health, and turns each callback into a Trigger. Setup restarts dsh-superagent once it resolves the bot.
 */
export async function runWecom(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let retry = 1000
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WecomConfig>(SOURCE)
    // Setup resolves the bot from these settings; while it has not, or it rejected the credentials, nothing connects.
    const robot = ctx.configured() ? ctx.deployment.wecom : undefined
    if (!config || !robot) {
      ctx.report('wecom', health('paused', !config ? 'sourceOff' : ctx.configured() ? 'wecomUnset' : 'setupPending'))
      await pause(5000, signal)
      continue
    }
    ctx.report('wecom', { state: 'starting', detail: 'Connecting to WeCom' })
    const began = Date.now()
    const outcome = await connect(ctx, { ...robot, wsUrl: config.wsUrl || robot.wsUrl }, () => { failures = 0 }, signal)
    if (signal.aborted) return
    if (outcome === 'taken-over') {
      ctx.report('wecom', { state: 'error', detail: TAKEN_OVER })
      return
    }
    failures += 1
    if (failures >= 3) ctx.report('wecom', health('error', 'pollFailures', { count: String(failures), error: 'the long connection closed' }))
    retry = Date.now() - began >= 60_000 ? 1000 : Math.min(retry * 2, 60_000)
    await pause(retry, signal)
  }
}
/** One connection attempt; resolves once it ended. */
function connect(ctx: SourceContext, robot: WecomRobot, ready: () => void, signal: AbortSignal): Promise<'closed' | 'taken-over'> {
  return new Promise(resolve => {
    let settled = false
    let chain = Promise.resolve()
    let watch: ReturnType<typeof setInterval> | undefined
    let stop: (() => void) | undefined
    const finish = (outcome: 'closed' | 'taken-over'): void => {
      if (settled) return
      settled = true
      if (watch) clearInterval(watch)
      if (stop) signal.removeEventListener('abort', stop)
      resolve(outcome)
    }
    const client = new WecomConnection(robot, {
      onReady: () => { ready(); ctx.report('wecom', { state: 'ready', detail: 'Listening for the bot\'s messages', at: new Date().toISOString() }) },
      onMessage: frame => {
        // Callbacks are handled in order so Triggers reach the Engine in the order WeCom sent them.
        chain = chain.then(() => receive(ctx, robot, frame)).catch(error => { ctx.report('wecom', { state: 'error', detail: String(error) }) })
      },
      onEvent: frame => {
        const event = (frame.body as { event?: { eventtype?: string } } | undefined)?.event
        if (event?.eventtype === 'disconnected_event') finish('taken-over')
      },
      onError: error => { ctx.report('wecom', { state: 'error', detail: error.message }) },
      onClosed: (_reason, takenOver) => { setActiveWecom(undefined); finish(takenOver ? 'taken-over' : 'closed') },
    })
    setActiveWecom(client)
    // The connection is opened from the settings as they are now; a change or the Source being switched off ends it.
    watch = setInterval(() => {
      // The plugin may be disposed between ticks; reading the closed store then would crash DSH.
      if (signal.aborted) { client.close('The WeCom Source stopped'); return }
      const current = ctx.config<WecomConfig>(SOURCE)
      if (!current || !sameBot(current, robot)) client.close('The WeCom Source changed')
    }, 5000)
    // Disposal must end the attempt at once, so no timer survives into the next incarnation of the plugin.
    stop = () => client.close('The WeCom Source stopped')
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) { stop(); return }
    client.start()
  })
}
/** Takes one callback frame in: the conversation's memory for reads, the Trigger, and the Thread's facts. */
async function receive(ctx: SourceContext, robot: WecomRobot, frame: WecomFrame): Promise<void> {
  // Events (welcome, card clicks, feedback) carry no message to act on and are not Triggers.
  if (frame.cmd !== 'aibot_msg_callback') return
  const trigger = wecomTrigger(frame.body, robot.botId)
  if (!trigger) return
  const chatId = wecomChat(trigger) ?? ''
  // The image URLs expire, so the conversation keeps them for the read the assessment may make soon after.
  const images = wecomImages(frame.body)
  rememberWecom(chatId, { id: String(trigger.meta.messageId ?? ''), from: String(trigger.actor.id), at: trigger.at, text: trigger.text,
    ...(images.length ? { images } : {}) })
  await ctx.receive(trigger)
  const group = trigger.meta.chattype === 'group'
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), {
    facts: { conversation: { value: group ? { zh: '群聊', en: 'Group chat' } : { zh: '私聊', en: 'Direct message' } } } })
}
