/** PingCode source kind definition, work item polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Thread } from '../core/index.ts'
import { PingcodeAccountsSchema } from '../deployment.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { pingcodeLink, sendPingcode } from './pingcode-channel.ts'
import { pingcodeThreadContext, workItem, workItemComments } from './pingcode-read.ts'
import { SOURCE, WorkItemSchema, agentNames, commentTrigger, ownWork, pingcodeIdentifier, pingcodeRef, pingcodeThread, pingcodeTime,
  workItemTrigger, type PingcodeRef, type PingcodeWorkItem } from './pingcode-trigger.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'

export { SOURCE, commentTrigger, pingcodeRef, workItemTrigger } from './pingcode-trigger.ts'
export { readPingcode, workItemComments } from './pingcode-read.ts'

const PingcodeConfigSchema = PingcodeAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeWorkItems: z.boolean().default(false),
  observeComments: z.boolean().default(false),
}).strict()
export type PingcodeConfig = z.infer<typeof PingcodeConfigSchema>
const OBSERVED = { workItems: 'observeWorkItems', comments: 'observeComments' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'workItem') return 'workItems'
  if (meta.kind === 'comment') return 'comments'
  return undefined
}

/** The PingCode Source: one account behind the skill's user token, watching the work items of several projects. */
export const pingcodeKind: SourceKind<PingcodeConfig> = {
  kind: SOURCE,
  title: { zh: 'PingCode', en: 'PingCode' },
  description: { zh: '智能体的 PingCode 账号；接收所监听项目的工作项、评论与 @ 提及，以及已订阅工作项的后续评论。',
    en: 'The agent\'s PingCode account; receives work items, comments, mentions and later comments on the conversations it follows in the projects it watches.' },
  schema: PingcodeConfigSchema,
  fields: [
    { key: 'skill', type: 'text', label: { zh: 'PingCode 技能目录', en: 'PingCode skill directory' },
      hint: { zh: '包含 scripts/api_call.py 与 .env 的目录；留空自动发现 ~/.agents/skills/pingcode。保存时用它调用 PingCode 验证 .env 里的用户令牌，然后重启 dsh-superagent。',
        en: 'The directory holding scripts/api_call.py and .env; leave it blank to auto-detect ~/.agents/skills/pingcode. Saving calls PingCode with it to check the user token in .env, then restarts dsh-superagent.' } },
    { key: 'python', type: 'text', advanced: true, label: { zh: '运行技能的 python3', en: 'python3 that runs the skill' },
      hint: { zh: '命令名或绝对路径，默认为 PATH 上的 python3。', en: 'A command name or absolute path; defaults to python3 on PATH.' } },
    { key: 'projects', type: 'rows', label: { zh: '监听的项目', en: 'Projects' },
      hint: { zh: '写项目 ID、编号或名称，例如 SCR-1 所属项目的 SCR；保存时按 PingCode 报告的项目解析。来源接收这些项目的工作项与评论。',
        en: 'Project ID, identifier or name, such as SCR for the project of SCR-1; saving resolves it against the projects PingCode reports. The Source receives the work items and comments of these projects.' },
      columns: [{ key: 'project', type: 'text', label: { zh: '项目', en: 'Project' }, pattern: '[A-Za-z0-9_.\\-]{1,64}' }] },
    { key: 'observeWorkItems', type: 'switch', label: { zh: '接收项目里的新工作项', en: 'Receive new work items in the projects' },
      hint: { zh: '打开后，没有 @ 智能体的新工作项也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。',
        en: 'New work items that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the projects' },
      hint: { zh: '打开后，没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。',
        en: 'Comments that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'PingCode 每分钟限流（免费版 200 次），轮询间隔不要太小。', en: 'PingCode rate-limits requests per minute (200 on the free plan), so keep the interval generous.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  ],
  health: ['pingcode'],
  // A project's work items and comments are received in full while their switch is on; elsewhere only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  channel: { send: sendPingcode, link: pingcodeLink },
  threadContext: pingcodeThreadContext,
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.@-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 PingCode 账号', en: 'PingCode accounts that may originate work' },
      hint: { zh: '写 PingCode 的账号名；工作项或评论的创建人是这个账号时才可能发起工作。',
        en: 'The PingCode account name; a work item or comment may originate work only when this account created it.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.@\\-]+' }] }],
    explicit: { zh: '名单里的账号在工作项或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in a work item or a comment.' },
    rows(stored) {
      const config = PingcodeConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('workItems', { zh: '新工作项', en: 'New work items' }), row('comments', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_PINGCODE_PROJECT', description: { zh: '接下工单的工作项所属项目的编号（identifier），如 SCR', en: 'The identifier of the project that holds the work item of this ticket, such as SCR' } },
      { key: 'DSH_SUPERAGENT_PINGCODE_ITEM', description: { zh: '接下工单的工作项编号，如 SCR-12；工单不是从 PingCode 来的时为空', en: 'The work item identifier that started the ticket, such as SCR-12; empty when the ticket did not start on PingCode' } },
      { key: 'DSH_SUPERAGENT_PINGCODE_URL', description: { zh: '接下工单的工作项网页地址；工单不是从 PingCode 来的时为空', en: 'The page of the work item that started the ticket; empty when the ticket did not start on PingCode' } },
    ],
    values: ({ deployment, trigger }) => {
      const ref = trigger?.source === SOURCE ? pingcodeRef(trigger) : undefined
      const project = deployment.pingcode?.projects.find(item => item.id === ref?.project)
      return { DSH_SUPERAGENT_PINGCODE_PROJECT: project?.identifier ?? '',
        DSH_SUPERAGENT_PINGCODE_ITEM: trigger && trigger.source === SOURCE ? pingcodeIdentifier(trigger) : '',
        DSH_SUPERAGENT_PINGCODE_URL: trigger?.source === SOURCE ? trigger.url ?? '' : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.pingcode ? {
    skill: { zh: `技能目录 ${deployment.pingcode.skill}`, en: `Skill directory ${deployment.pingcode.skill}` },
    python: { zh: `当前账号 ${deployment.pingcode.displayName || deployment.pingcode.login}`, en: `Current account ${deployment.pingcode.displayName || deployment.pingcode.login}` },
  } : {},
}

export const name = 'dsh-superagent-pingcode'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(pingcodeKind), 'pingcode: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, pingcodeKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('pingcode', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/** One poll; a tally counts records PingCode's schema did not match. */
interface Round { started: string; signal?: AbortSignal | undefined; read: Set<string>; failures: string[]; notes: number; tally: Tally }
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, read: new Set(), failures: [], notes: 0, tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const sinceMs = (since: string): number => Date.parse(since)

/** Marks a Thread as PingCode's and describes it by project identifier and work item title. */
function describeThread(ctx: SourceContext, ref: PingcodeRef, item: PingcodeWorkItem): void {
  const thread = `${SOURCE}:${pingcodeThread(ref.item)}`
  ctx.threads.patch(thread, { project: ref.project, item: ref.item, identifier: item.identifier ?? '', title: item.title })
  const label = `${item.identifier ?? ''} ${item.title}`.trim()
  ctx.threads.describe(thread, { label, ...item.html_url ? { url: item.html_url } : {} })
}

/** Reads the comments of one work item and ingests those after `since`, skipping the agent's own. */
async function intakeComments(ctx: SourceContext, round: Round, ref: PingcodeRef, page: string, since: string, identifier = ''): Promise<void> {
  const config = ctx.config<PingcodeConfig>(SOURCE)
  const account = ctx.deployment.pingcode
  if (!config || !account) throw new Error('The PingCode Source stopped during the poll')
  const names = agentNames(account)
  const comments = await workItemComments(ctx.commands.withSignal(round.signal), ref, round.tally)
  for (const comment of comments) {
    if (stopped(ctx, round)) throw new Error('The PingCode Source stopped during the poll')
    if (sinceMs(pingcodeTime(comment.created_at)) < sinceMs(since)) continue
    if (ownWork(comment.created_by, account.id)) continue
    const trigger = commentTrigger(comment, ref, names, account.id, page, identifier)
    // With the comments switch off, a comment still reaches the gate when it mentions the agent.
    if (!trigger.text || (!config.observeComments && trigger.addressed !== 'mention')) continue
    await ctx.receive(trigger)
    round.notes += 1
  }
  round.read.add(`${SOURCE}:${pingcodeThread(ref.item)}`)
}

/** Reads one project's work items changed since `since`, newest first by the API's own order, and handles each change. */
async function pollProject(ctx: SourceContext, round: Round, project: string, since: string): Promise<void> {
  const config = ctx.config<PingcodeConfig>(SOURCE)
  const account = ctx.deployment.pingcode
  if (!config || !account) throw new Error('The PingCode Source stopped during the poll')
  const names = agentNames(account)
  const commands = ctx.commands.withSignal(round.signal)
  const after = Math.floor(sinceMs(since) / 1000)
  for (let page = 0; page < 10; page += 1) {
    const listed = await commands.pingcode<{ values?: unknown[] }>({ method: 'POST', path: '/v1/pjm/work_items/search',
      body: { mode: 'query', payload: { filter: { 'project.id': { in: [project] }, updated_at: { gt: after } }, page_size: 100,
        page_index: page, include_public_image_token: 'description' } } })
    const values = Array.isArray(listed?.values) ? listed.values : []
    const items = validItems(WorkItemSchema, values, round.tally)
    if (!items.length) return
    for (const item of items) {
      if (stopped(ctx, round)) throw new Error('The PingCode Source stopped during the poll')
      const ref: PingcodeRef = { project, item: item.id }
      // A work item reaches the gate when a person opened it after the cursor and its kind is observed, or when it mentions the agent.
      if (sinceMs(pingcodeTime(item.created_at)) >= sinceMs(since) && !ownWork(item.created_by, account.id)) {
        const opened = workItemTrigger(item, project, names, account.id)
        if (config.observeWorkItems || opened.addressed === 'mention') { await ctx.receive(opened); round.notes += 1 }
      }
      // Comments are read for every change so a mention reaches the gate even with the comments switch off.
      await intakeComments(ctx, round, ref, item.html_url ?? '', since, item.identifier ?? '')
      // After ingest, so a Trigger that created the Thread finds it described.
      describeThread(ctx, ref, item)
    }
    if (values.length < 100) return
  }
}

/** Polls each watched project's changed work items, then the subscribed Threads no stream read this round. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const config = ctx.config<PingcodeConfig>(SOURCE)
  const projects = ctx.deployment.pingcode?.projects ?? []
  if (config && projects.length) {
    const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
    for (const project of projects) {
      if (stopped(ctx, round)) break
      const stored = ctx.state.get(KV.pingcode.since(project.id)) ?? round.started
      const since = new Date(Math.max(Date.parse(stored), horizon)).toISOString()
      try {
        // Work items are always listed so a mention in a comment reaches the gate even with both switches off; the switches
        // decide what is received beyond a mention.
        await pollProject(ctx, round, project.id, since)
        ctx.state.set(KV.pingcode.since(project.id), cursorAt(round.started))
      } catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project.identifier || project.id}: ${String(error)}`) }
    }
    await pollThreads(ctx, signal, round)
  }
  const interval = Math.max(60, config?.pollSeconds ?? 60)
  if (signal?.aborted || !config) return interval
  if (round.failures.length) throw new Error(`${round.failures.length} PingCode reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report('pingcode', { state: 'ready', detail: `${projects.length} projects; ${round.notes} new; next poll ≥ ${interval}s${skipped}`, at: round.started })
  return interval
}

/** Reads a subscribed Thread's comments from its own cursor, which advances only after the whole read succeeds. */
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  const item = typeof thread.meta.item === 'string' ? thread.meta.item : thread.ref.id
  const since = ctx.state.get(KV.pingcode.thread(thread.key)) ?? thread.createdAt
  const work = await workItem(ctx.commands.withSignal(round.signal), item)
  const ref: PingcodeRef = { project: work.project?.id ?? '', item }
  await intakeComments(ctx, round, ref, work.html_url ?? '', since, work.identifier ?? '')
  ctx.state.set(KV.pingcode.thread(thread.key), cursorAt(round.started))
}
/** Polls subscribed PingCode Threads not already read in this round; a failing Thread records `pollError` and does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => { await pollThread(ctx, round, thread) }, thread => round.read.has(thread.key))
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the skill and token; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('pingcode', health('paused', 'setupPending')); return }
  if (!ctx.config<PingcodeConfig>(SOURCE)) { ctx.report('pingcode', health('paused', 'sourceOff')); return }
  if (!ctx.deployment.pingcode) { ctx.report('pingcode', health('paused', 'pingcodeUnset')); return }
  while (!signal.aborted) {
    const config = ctx.config<PingcodeConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('pingcode', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('pingcode', failed)
    }
    await pause(Math.max(interval, ctx.config<PingcodeConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
