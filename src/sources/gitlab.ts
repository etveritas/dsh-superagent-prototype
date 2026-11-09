/** GitLab source kind definition, project polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitlabAccountsSchema } from '../deployment.ts'
import type { Thread } from '../core/index.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import { gitlabAllows, gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { gitlabThreadContext, notePageDesc } from './gitlab-read.ts'
import { IssueSchema, MergeRequestSchema, SOURCE, diffNote, gitlabRef, gitlabThread, gitlabUrlThread, noteTrigger,
  projectIssueTrigger, projectMergeRequestTrigger, systemNote, type GitlabRef, type GitlabTarget } from './gitlab-trigger.ts'
import type { Localized, SourceKind } from './kind.ts'
import { BranchNameSchema, ProjectPathSchema } from '../policy.ts'

export { SOURCE, gitlabPage, gitlabThread, gitlabUrlThread, noteTrigger, projectIssueTrigger, projectMergeRequestTrigger } from './gitlab-trigger.ts'
export { readGitlab } from './gitlab-read.ts'

const GitlabConfigFieldsSchema = GitlabAccountsSchema.extend({
  // Tickets that did not start on a merge request check out the base branch of their project.
  baseBranches: z.array(z.object({ project: ProjectPathSchema, baseBranch: BranchNameSchema.refine(branch => branch !== '', 'A branch name') })).default([])
    .refine(rows => new Set(rows.map(row => row.project.toLowerCase())).size === rows.length, 'Duplicate projects'),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observeMergeRequests: z.boolean().default(false),
  observeComments: z.boolean().default(false),
}).strict()
const GitlabConfigSchema = GitlabConfigFieldsSchema.refine(config => config.baseBranches.every(row => config.projects.some(project => sameName(project.path, row.project))),
  'Base branches must name a watched project')
export type GitlabConfig = z.infer<typeof GitlabConfigFieldsSchema>
const OBSERVED = { issues: 'observeIssues', mergeRequests: 'observeMergeRequests', comments: 'observeComments' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mergeRequest') return 'mergeRequests'
  if (meta.kind === 'note') return 'comments'
  return undefined
}

/** The GitLab Source: an agent account on one instance, watching the issues and merge requests of several projects. */
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收所监听项目的 Issue、合并请求、评论、@ 提及与已订阅线程的后续消息。',
    en: 'The agent\'s GitLab account; receives Issues, merge requests, comments, mentions, and later messages on subscribed Threads in the projects it watches.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', pattern: '[A-Za-z0-9.\\-]+(:[0-9]+)?', label: { zh: 'GitLab 实例', en: 'GitLab instance' },
      hint: { zh: '域名，例如 gitlab.com 或自建实例的域名；保存时用 glab 连接它，然后重启 dsh-superagent。', en: 'The hostname, such as gitlab.com or a self-hosted instance; saving connects to it with glab, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是登录了智能体账号与上面实例的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它。保存时检查账号能否推送到下面每个项目，然后重启 dsh-superagent。',
        en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account on the instance above. The agent acts as the account it is signed in to, and the Executor calls it as glab. Saving checks that this account can push to every project below, then restarts dsh-superagent.' } },
    { key: 'projects', type: 'rows', label: { zh: '监听的项目', en: 'Projects' },
      hint: { zh: '写作 group/project。来源接收这些项目的 Issue、合并请求和评论；智能体需要每个项目的 Developer 或更高权限。', en: 'Written group/project. The Source receives issues, merge requests and comments of these projects; the agent needs Developer or higher on each.' },
      columns: [{ key: 'path', type: 'text', label: { zh: '项目', en: 'Project' }, pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)*' }] },
    { key: 'baseBranches', type: 'rows', label: { zh: '基线分支', en: 'Base branches' },
      hint: { zh: '不是 MR 的工单按项目从这个分支开始；未列出的项目用执行器的默认基线分支。MR 工单始终检出 MR 的 head。', en: 'Tickets that are not merge requests start from this branch per project; a project not listed here uses the Executor\'s default base branch. A merge request ticket always checks out its head.' },
      columns: [{ key: 'project', type: 'text', label: { zh: '项目', en: 'Project' }, pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)*' },
        { key: 'baseBranch', type: 'text', label: { zh: '分支', en: 'Branch' }, pattern: '[A-Za-z0-9._/-]+' }] },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the projects' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the projects' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the projects' },
      hint: { zh: '打开后，没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。合并请求 diff 上的行内评论暂不接收。', en: 'Comments that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Inline comments on a merge request diff are not received yet.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  ],
  health: ['gitlab'],
  // A project's issues and merge requests are received in full while their switch is on; elsewhere only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  channel: { allowed: gitlabAllows, send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // A GitLab issue or merge request page names its Thread; a bare number is ambiguous across the Source's projects.
  find: query => ({ threads: [gitlabUrlThread(query)].filter((thread): thread is string => thread !== undefined), terms: [] }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收项目里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。',
        en: 'A comment of a bot account on this list becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the projects on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、合并请求或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a merge request, or a comment.' },
    rows(stored) {
      const config = GitlabConfigFieldsSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mergeRequests', { zh: '新合并请求', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '这个来源连接的 GitLab 实例域名；glab 也以它为准', en: 'The GitLab instance this Source connects to; glab uses it too' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', role: 'repository', description: { zh: '接下工单的项目 group/project；工单不是从 GitLab 来的时为空', en: 'The group/project of the issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，除合并外的 GitLab 操作都用 glab，不用其他账号或凭据', en: 'The agent\'s GitLab account. glab is signed in to it; use glab for every GitLab operation except merging, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或合并请求的 iid；工单不是从 GitLab 来的时为空', en: 'The iid of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_TARGET', description: { zh: '接下工单的对象是 issues 还是 merge_requests；工单不是从 GitLab 来的时为空', en: 'Whether the ticket started from issues or merge_requests; empty when it did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', role: 'head', description: { zh: '接下工单的合并请求的 head 引用 refs/merge-requests/<iid>/head；不是合并请求时为空', en: 'Head ref refs/merge-requests/<iid>/head of the merge request that started the ticket; empty when it was not a merge request' } },
      { key: 'DSH_SUPERAGENT_GITLAB_BASE_BRANCH', role: 'base', description: { zh: '不是合并请求的工单按项目从这个分支开始；项目未配置基线分支时为空', en: 'The branch Tickets that are not merge requests start from for their project; empty when that project has no base branch configured' } },
    ],
    values: ({ deployment, config, trigger }) => {
      const ref = trigger?.source === SOURCE ? gitlabRef(trigger) : undefined
      const base = ref ? config.baseBranches.find(row => sameName(row.project, ref.project))?.baseBranch ?? '' : ''
      return { DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab?.host ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: ref?.project ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab?.email ?? '',
        DSH_SUPERAGENT_GITLAB_IID: ref ? String(ref.iid) : '', DSH_SUPERAGENT_GITLAB_TARGET: ref ? (ref.target === 'issue' ? 'issues' : 'merge_requests') : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: ref?.target === 'mergeRequest' ? `refs/merge-requests/${ref.iid}/head` : '',
        DSH_SUPERAGENT_GITLAB_BASE_BRANCH: base }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    host: { zh: `当前实例 ${deployment.gitlab.host}`, en: `Current instance ${deployment.gitlab.host}` },
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/** The projects setup verified, which are the canonical paths GitLab reported; empty while the Source is not set up. */
const projectsOf = (ctx: SourceContext): string[] => ctx.deployment.gitlab?.projects ?? []
/** One note's or description's Trigger counts toward the ready detail; a tally counts records GitLab's schema did not match. */
interface Round { started: string; signal?: AbortSignal | undefined; read: Set<string>; failures: string[]; notes: number; tally: Tally }
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, read: new Set(), failures: [], notes: 0, tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const targetOf = (meta: Record<string, unknown>): GitlabTarget => meta.target === 'mergeRequest' ? 'mergeRequest' : 'issue'
/** Marks a Thread as GitLab's and describes it by project and number (and title when known). */
function describeThread(ctx: SourceContext, ref: GitlabRef, title?: string): void {
  const thread = `${SOURCE}:${gitlabThread(ref.project, ref.iid)}`
  ctx.threads.patch(thread, { project: ref.project, iid: ref.iid, target: ref.target, ...(title ? { title } : {}) })
  const mark = ref.target === 'mergeRequest' ? '!' : '#'
  ctx.threads.describe(thread, { label: `${ref.project}${mark}${ref.iid}${title ? ` ${title}` : ''}`, facts: { number: { value: `${ref.project}${mark}${ref.iid}` } } })
}
const older = (at: string | null | undefined, since: string): boolean => {
  const time = Date.parse(at ?? '')
  return Number.isFinite(time) && time < Date.parse(since)
}

/** Reads and ingests the notes of one issue or merge request changed since `since`, newest first, capped to keep a poll bounded. */
async function intakeNotes(ctx: SourceContext, round: Round, ref: GitlabRef, since: string, all = true, limit = 10): Promise<void> {
  const { host, login } = ctx.deployment.gitlab!
  const commands = ctx.commands.withSignal(round.signal)
  for (let page = 1; page <= limit; page += 1) {
    const notes = await notePageDesc(commands, ref, page, round.tally)
    if (!notes.length) return
    let reached = false
    for (const note of notes) {
      // Stopping mid-read throws so the thread's cursor stays where it was.
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      if (older(note.updated_at ?? note.created_at, since)) { reached = true; continue }
      if (systemNote(note) || diffNote(note)) continue
      if (sameName(note.author.username, login)) continue
      const trigger = noteTrigger(note, ref, host, login)
      // With the comments switch off, a Thread still reaches the gate when the note mentions the agent.
      if (!trigger.text || (!all && trigger.addressed !== 'mention')) continue
      await ctx.receive(trigger)
      round.notes += 1
    }
    if (reached || notes.length < 100) return
  }
}

/** Lists one project's issues or merge requests newest-updated first and handles each change after `since`. */
async function pollCollection(ctx: SourceContext, round: Round, project: string, target: GitlabTarget, since: string): Promise<void> {
  const { host, login } = ctx.deployment.gitlab!
  const config = ctx.config<GitlabConfig>(SOURCE)!
  const commands = ctx.commands.withSignal(round.signal)
  const schema = target === 'issue' ? IssueSchema : MergeRequestSchema
  const path = target === 'issue' ? 'issues' : 'merge_requests'
  const observed = target === 'issue' ? config.observeIssues : config.observeMergeRequests
  for (let page = 1; page <= 10; page += 1) {
    const listed = await commands.gitlabApi(z.array(z.unknown()), project, `${path}?order_by=updated_at&sort=desc&state=all&per_page=100&page=${page}`)
    const items = validItems(schema, listed, round.tally)
    if (!items.length) return
    let reached = false
    for (const item of items) {
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      if (older(item.updated_at ?? item.created_at, since)) { reached = true; continue }
      const ref: GitlabRef = { project, iid: item.iid, target }
      // A description reaches the gate when a person opened it after the cursor and its kind is observed, or when it mentions
      // the agent: a mention is received like one in a comment.
      if (Date.parse(item.created_at) >= Date.parse(since) && !sameName(item.author.username, login)) {
        const opened = target === 'issue' ? projectIssueTrigger(item, project, host, login) : projectMergeRequestTrigger(item, project, host, login)
        if (observed || opened.addressed === 'mention') { await ctx.receive(opened); round.notes += 1 }
      }
      // Notes are read for every change so a mention reaches the gate even with the comments switch off; the switch decides
      // whether notes that do not mention the agent are received too.
      await intakeNotes(ctx, round, ref, since, config.observeComments)
      round.read.add(`${SOURCE}:${gitlabThread(project, item.iid)}`)
      // After ingest, so a Trigger that created the Thread finds it described.
      describeThread(ctx, ref, item.title)
    }
    if (reached || listed.length < 100) return
  }
}

/** Polls each verified project's observed streams, then the subscribed Threads no stream read this round. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const config = ctx.config<GitlabConfig>(SOURCE)
  const projects = projectsOf(ctx)
  if (config && projects.length) {
    const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
    for (const project of projects) {
      if (stopped(ctx, round)) break
      const stored = ctx.state.get(KV.gitlab.since(project)) ?? round.started
      const since = new Date(Math.max(Date.parse(stored), horizon)).toISOString()
      try {
        if (config.observeIssues || config.observeComments) await pollCollection(ctx, round, project, 'issue', since)
        if (config.observeMergeRequests || config.observeComments) await pollCollection(ctx, round, project, 'mergeRequest', since)
        ctx.state.set(KV.gitlab.since(project), cursorAt(round.started))
      } catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project}: ${String(error)}`) }
    }
    await pollThreads(ctx, signal, round)
  }
  const interval = Math.max(60, config?.pollSeconds ?? 60)
  if (signal?.aborted || !config) return interval
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report('gitlab', { state: 'ready', detail: `${projects.length} projects; ${round.notes} new; next poll ≥ ${interval}s${skipped}`, at: round.started })
  return interval
}
/** Reads a subscribed Thread's notes from its own cursor, which advances only after the whole read succeeds. */
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  const meta = thread.meta as { project?: unknown; iid?: unknown; target?: unknown }
  const fallback = /^(.*):(\d+)$/.exec(thread.ref.id)
  const project = typeof meta.project === 'string' ? meta.project : fallback?.[1]
  const iid = typeof meta.iid === 'number' ? meta.iid : Number(fallback?.[2])
  if (!project || !Number.isInteger(iid)) throw new Error('Subscribed thread names no GitLab project and number')
  const ref: GitlabRef = { project, iid, target: targetOf(meta) }
  const since = ctx.state.get(KV.gitlab.thread(thread.key)) ?? thread.createdAt
  await intakeNotes(ctx, round, ref, since)
  ctx.state.set(KV.gitlab.thread(thread.key), cursorAt(round.started))
}
/** Polls subscribed GitLab Threads not already read in this round; a failing Thread records `pollError` and does not fail the round. */
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
  // Setup restarts dsh-superagent once it resolves the account; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  // A source switched off is reported as off; one switched on without a working CLI waits for setup rather than retrying.
  if (!ctx.config<GitlabConfig>(SOURCE)) { ctx.report('gitlab', health('paused', 'sourceOff')); return }
  if (!ctx.deployment.gitlab) { ctx.report('gitlab', health('paused', 'gitlabCliUnset')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
