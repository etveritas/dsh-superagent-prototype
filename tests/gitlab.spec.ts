import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { githubKind } from '../src/sources/github.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { readGitlab, readGitlabPath } from '../src/sources/gitlab-read.ts'
import { diffNote, gitlabThread, gitlabUrlThread, isHumanUser, mentions, noteTrigger, projectIssueTrigger, projectMergeRequestTrigger,
  systemNote } from '../src/sources/gitlab-trigger.ts'
import { apply, gitlabKind, pollRound, pollThreads, type GitlabConfig } from '../src/sources/gitlab.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const HOST = 'gitlab.example.com'
const PROJECT = 'acme/widgets'
const at = '2099-01-01T00:00:00.000Z'
const user = (username: string, bot = false) => ({ id: 1, username, name: username, bot })
const issue = (iid: number, overrides: Record<string, unknown> = {}) => ({ iid, title: `Issue ${iid}`, description: 'Please fix it',
  state: 'opened', created_at: at, updated_at: at, web_url: `https://${HOST}/${PROJECT}/-/issues/${iid}`, author: user('alice'), ...overrides })
const merge = (iid: number, overrides: Record<string, unknown> = {}) => ({ ...issue(iid, overrides), title: `Merge ${iid}`,
  web_url: `https://${HOST}/${PROJECT}/-/merge_requests/${iid}`, source_branch: 'fix', target_branch: 'main' })
const note = (id: number, body: string, overrides: Record<string, unknown> = {}) => ({ id, body, author: user('alice'),
  created_at: at, updated_at: at, system: false, ...overrides })

type Routes = Record<string, unknown | (() => unknown)>
/** A Source context over a real Store and registry, with `glab api` answered by path and the triggers it received recorded. */
function context(routes: Routes, options: { register?: boolean; gitlab?: boolean } = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } },
    sources: { gitlab: { enabled: true, config: { host: HOST, cli: '/path/glab', projects: [{ path: PROJECT }],
      observeIssues: true, observeMergeRequests: true, observeComments: true } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  if (options.register !== false) sources.register(gitlabKind)
  const deployment = testDeployment({ stateDir: join(tmpdir(), 'gitlab-state'),
    ...options.gitlab === false ? {} : { gitlab: { host: HOST, cli: '/path/glab', login: 'agent-bot', id: 7,
      email: `7-agent-bot@users.noreply.${HOST}`, projects: [PROJECT] } } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const reads: { path: string; args: string[] }[] = []
  vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    const path = String(args[3] ?? '')
    reads.push({ path, args })
    const bare = path.split('?')[0]!.replace(/^projects\/acme%2Fwidgets\/?/, '')
    const route = routes[bare] ?? (bare.endsWith('/notes') ? [] : {})
    const value = typeof route === 'function' ? route() : route
    if (value instanceof Error) throw value
    // Raw API output, as `glab api .../raw` prints it, is not JSON.
    if (value && typeof value === 'object' && 'raw' in value) return String((value as { raw: string }).raw)
    return JSON.stringify(value)
  })
  const seen = new Map<string, Trigger>()
  const receive = vi.fn(async (trigger: Trigger) => seen.has(trigger.id) ? 'duplicate' as const : (seen.set(trigger.id, trigger), 'stored' as const))
  const parts: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() }, outbox: { send: () => {} },
    commands, sources, deployment, ready: Promise.resolve(), configured: () => true, receive }
  const ctx = sourceContextOf(parts, { kind: 'gitlab', health: ['gitlab'] })
  const host = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  return { ctx, host, store, commands, receive, seen, reads, board, sources }
}
const triggers = (receive: ReturnType<typeof context>['receive']) => receive.mock.calls.map(call => call[0]!)
afterEach(() => { vi.restoreAllMocks() })

describe('gitlab triggers', () => {
  it('turns notes, issues and merge requests into triggers that name their project, number and target', () => {
    const comment = noteTrigger(note(11, 'hi @agent-bot, please look'), { project: PROJECT, iid: 5, target: 'issue' }, HOST, 'agent-bot')
    expect(comment).toMatchObject({ id: key('gitlab-note', PROJECT, '5', '11', at), source: 'gitlab', human: true,
      threads: [{ source: 'gitlab', id: `${PROJECT}:5` }], actor: { source: 'gitlab', id: 'alice' }, addressed: 'mention',
      url: `https://${HOST}/${PROJECT}/-/issues/5#note_11`, channel: { source: 'gitlab', thread: `gitlab:${PROJECT}:5`,
        address: { project: PROJECT, iid: '5', target: 'issue', noteId: '11', url: `https://${HOST}/${PROJECT}/-/issues/5` } },
      meta: { project: PROJECT, iid: 5, target: 'issue', kind: 'note', noteId: 11 } })
    const opened = projectIssueTrigger(issue(5), PROJECT, HOST, 'agent-bot')
    expect(opened).toMatchObject({ id: key('gitlab-issue', PROJECT, '5'), human: true, text: 'Issue 5\n\nPlease fix it',
      meta: { project: PROJECT, iid: 5, target: 'issue', kind: 'issue' }, channel: { source: 'gitlab' } })
    const pull = projectMergeRequestTrigger(merge(6), PROJECT, HOST, 'agent-bot')
    expect(pull).toMatchObject({ id: key('gitlab-merge-request', PROJECT, '6'), meta: { target: 'mergeRequest', kind: 'mergeRequest' } })
    // A bot's note is not human, and a diff note keeps its place.
    expect(noteTrigger(note(12, 'automated', { author: user('project_1_bot') }), { project: PROJECT, iid: 5, target: 'issue' }, HOST, 'agent-bot'))
      .toMatchObject({ human: false })
    expect(noteTrigger(note(13, 'see line', { type: 'DiffNote', position: { new_path: 'src/a.ts', new_line: 4 } }),
      { project: PROJECT, iid: 6, target: 'mergeRequest' }, HOST, 'agent-bot')).toMatchObject({ text: 'src/a.ts:4\n\nsee line',
      meta: { path: 'src/a.ts', line: 4 } })
  })
  it('recognizes GitLab automation accounts, mentions, system notes and diff notes', () => {
    expect([isHumanUser(user('alice')), isHumanUser(user('alice', true)), isHumanUser(user('group_1_bot')), isHumanUser(user('service_account_2'))])
      .toEqual([true, false, false, false])
    expect([mentions('hi @agent-bot!', 'agent-bot'), mentions('@agent-bot_x', 'agent-bot'), mentions('me@agent-bot', 'agent-bot')])
      .toEqual([true, false, false])
    expect([systemNote(note(1, '', { system: true })), diffNote(note(2, '', { position: { new_line: 1 } }))]).toEqual([true, true])
    expect(gitlabUrlThread(`https://${HOST}/${PROJECT}/-/issues/5#note_7`)).toBe(`gitlab:${gitlabThread(PROJECT, 5)}`)
    expect(gitlabUrlThread('https://example.com/acme/widgets')).toBeUndefined()
  })
  it('scopes each kind by its observe switch and answers to the project it names', () => {
    const config = gitlabKind.schema.parse({}) as GitlabConfig
    expect(gitlabKind.scope!({ meta: { kind: 'note' } }, config)).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(gitlabKind.scope!({ meta: { kind: 'issue' } }, { ...config, observeIssues: true })).toMatchObject({ observed: true, row: 'issues' })
    expect(gitlabKind.channel!.allowed!({ project: PROJECT }, gitlabKind.schema.parse({ projects: [{ path: PROJECT }] }))).toBe(true)
    expect(gitlabKind.channel!.allowed!({ project: 'acme/other' }, gitlabKind.schema.parse({ projects: [{ path: PROJECT }] }))).toBe(false)
    expect(gitlabKind.find!(`https://${HOST}/acme/other/-/merge_requests/9`).threads).toEqual(['gitlab:acme/other:9'])
    expect(gitlabKind.find!('12').threads).toEqual([])
  })
})

describe('gitlab polling', () => {
  it('reads each project\'s new issues, merge requests and notes, skipping system, diff and the agent\'s own notes', async () => {
    const h = context({ issues: [issue(5)], 'issues/5/notes': [note(11, 'first'), note(12, 'event', { system: true }),
      note(13, 'diff', { position: { new_line: 2 } }), note(14, 'mine', { author: user('agent-bot') })],
    merge_requests: [merge(6)], 'merge_requests/6/notes': [note(21, 'on the merge')] })
    expect(await pollRound(h.ctx)).toBe(60)
    const received = triggers(h.receive)
    expect(received.map(trigger => trigger.id)).toEqual([key('gitlab-issue', PROJECT, '5'), key('gitlab-note', PROJECT, '5', '11', at),
      key('gitlab-merge-request', PROJECT, '6'), key('gitlab-note', PROJECT, '6', '21', at)])
    expect(h.board.all.gitlab).toMatchObject({ state: 'ready' })
    expect(h.store.get('gitlab-since:acme/widgets')).toBeTruthy()
    // The same items on the next round produce the same IDs, which the Engine deduplicates.
    await pollRound(h.ctx)
    expect(new Set(triggers(h.receive).map(trigger => trigger.id)).size).toBe(4)
  })
  it('reads only the streams a switch turns on, and failures do not fail the round twice', async () => {
    const h = context({ issues: [issue(5)], 'issues/5/notes': [note(11, 'first')], merge_requests: [merge(6)], 'merge_requests/6/notes': [note(21, 'on the merge')] })
    h.store.saveSettings(SettingsSchema.parse({ ...h.store.settings(), sources: { gitlab: { enabled: true,
      config: { host: HOST, cli: '/path/glab', projects: [{ path: PROJECT }], observeIssues: true } } } }))
    await pollRound(h.ctx)
    expect(triggers(h.receive).map(trigger => trigger.meta.kind)).toEqual(['issue'])
    const failing = context({ issues: () => { throw new CliError('boom', 500) } })
    await expect(pollRound(failing.ctx)).rejects.toThrow('GitLab reads failed')
  })
  it('receives a mention even with the comments switch off, and other comments only with it on', async () => {
    const h = context({ issues: [issue(5)], 'issues/5/notes': [note(11, 'ping @agent-bot'), note(12, 'plain')] })
    h.store.saveSettings(SettingsSchema.parse({ ...h.store.settings(), sources: { gitlab: { enabled: true,
      config: { host: HOST, cli: '/path/glab', projects: [{ path: PROJECT }], observeIssues: true } } } }))
    await pollRound(h.ctx)
    expect(triggers(h.receive).filter(trigger => trigger.meta.kind === 'note').map(trigger => trigger.meta.noteId)).toEqual([11])
    const all = context({ issues: [issue(5)], 'issues/5/notes': [note(11, 'ping @agent-bot'), note(12, 'plain')], merge_requests: [] })
    await pollRound(all.ctx)
    expect(triggers(all.receive).filter(trigger => trigger.meta.kind === 'note').map(trigger => trigger.meta.noteId)).toEqual([11, 12])
  })
  it('polls a subscribed Thread from its own cursor and keeps a read failure on the thread', async () => {
    const h = context({ 'issues/5/notes': [note(31, 'later')] })
    h.store.threads.save({ key: `gitlab:${PROJECT}:5`, ref: { source: 'gitlab', id: `${PROJECT}:5` }, createdAt: '2026-01-01T00:00:00.000Z',
      lastAt: new Date().toISOString(), subscriptions: ['ticket'], correlated: [], pending: [],
      meta: { project: PROJECT, iid: 5, target: 'issue' } })
    await pollThreads(h.ctx)
    expect(triggers(h.receive)).toMatchObject([{ id: key('gitlab-note', PROJECT, '5', '31', at), text: 'later' }])
    expect(h.store.get('gitlab-thread:gitlab:acme/widgets:5')).toBeTruthy()
    const failing = context({ 'issues/5/notes': () => { throw new CliError('denied', 403) } })
    failing.store.threads.save({ key: `gitlab:${PROJECT}:5`, ref: { source: 'gitlab', id: `${PROJECT}:5` }, createdAt: '2026-01-01T00:00:00.000Z',
      lastAt: new Date().toISOString(), subscriptions: ['ticket'], correlated: [], pending: [],
      meta: { project: PROJECT, iid: 5, target: 'issue' } })
    await pollThreads(failing.ctx)
    expect(failing.store.threads.get(`gitlab:${PROJECT}:5`)?.meta.pollError).toContain('denied')
  })
  it('registers its kind and reports what setup still misses', async () => {
    const h = context({}, { register: false, gitlab: false })
    const disposers: (() => unknown)[] = []
    apply({ orchestrator: h.host, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(h.sources.kind('gitlab')).toBe(gitlabKind)
    await vi.waitFor(() => expect(h.board.all.gitlab).toMatchObject({ state: 'paused', code: 'gitlabCliUnset' }))
    for (const dispose of disposers) await dispose()
  })
})

describe('gitlab channel and resources', () => {
  it('posts a marked note, settles on the marker and treats a deleted conversation as gone', async () => {
    const h = context({ 'merge_requests/6/notes': [] })
    const message = (id: string, text: string) => ({ id, kind: 'reply' as const, text, channel: { source: 'gitlab', thread: `gitlab:${PROJECT}:6`,
      address: { project: PROJECT, iid: '6', target: 'mergeRequest' } } })
    expect(await sendGitlab(h.ctx, message('m1', 'Done'))).toBe('sent')
    expect(h.reads.at(-1)!.args).toEqual(expect.arrayContaining(['--method', 'POST', '-f', 'body=Done\n\n<!-- dsh-superagent:m1 -->']))
    const deduped = context({ 'issues/5/notes': [note(41, 'Done', { body: 'Done\n\n<!-- dsh-superagent:m2 -->', author: user('agent-bot') })] })
    expect(await sendGitlab(deduped.ctx, { id: 'm2', kind: 'reply', text: 'Done', channel: { source: 'gitlab', thread: `gitlab:${PROJECT}:5`,
      address: { project: PROJECT, iid: '5', target: 'issue' } } })).toBe('sent')
    expect(deduped.reads.filter(read => read.args.includes('POST'))).toEqual([])
    const gone = context({ 'issues/5/notes': () => { throw new CliError('Not Found', 404) } })
    expect(await sendGitlab(gone.ctx, { id: 'm3', kind: 'reply', text: 'Done', channel: { source: 'gitlab', thread: `gitlab:${PROJECT}:5`,
      address: { project: PROJECT, iid: '5', target: 'issue' } } })).toBe('gone')
  })
  it('reads project files and directory listings from the default branch', async () => {
    const h = context({ 'repository/files/lib%2Fvalue.ts/raw': { raw: 'export const value = 1\n' },
      'repository/tree': [{ name: 'README.md', type: 'blob' }, { name: '.gitlab-ci.yml', type: 'blob' }, { name: 'lib', type: 'tree' }] })
    expect(await readGitlabPath(h.commands, PROJECT, 'lib/value.ts', 'file')).toBe('export const value = 1\n')
    expect(await readGitlabPath(h.commands, PROJECT, '', 'directory')).toBe('lib/\nREADME.md')
    await expect(readGitlabPath(h.commands, PROJECT, '../secrets', 'file')).rejects.toThrow('Only non-hidden')
  })
  it('reads a description and pages of notes as model-facing messages', async () => {
    const notes = Array.from({ length: 20 }, (_, index) => note(100 + index, `note ${index}`))
    const h = context({ 'issues/5': issue(5), 'issues/5/notes': notes })
    expect(await readGitlab(h.commands, 'gitlab/acme/widgets/issues/5')).toMatchObject({ iid: 5, title: 'Issue 5', state: 'opened',
      message: { from: 'alice', text: 'Issue 5\n\nPlease fix it' } })
    const page = await readGitlab(h.commands, 'gitlab/acme/widgets/issues/5/notes/1') as { messages: { id: string }[]; next_resource?: string }
    expect(page.messages.map(message => message.id)).toEqual(notes.map(item => String(item.id)))
    expect(page.next_resource).toBe('gitlab/acme/widgets/issues/5/notes/2')
    await expect(readGitlab(h.commands, 'gitlab/acme/widgets/unknown/5')).rejects.toThrow('Use gitlab/<project>')
  })
})
it('reports the project base branch for Tickets that did not start on a merge request, and the head ref when they did', () => {
  const config = gitlabKind.schema.parse({ host: HOST, cli: '/path/glab', projects: [{ path: PROJECT }, { path: 'acme/other' }],
    baseBranches: [{ project: PROJECT, baseBranch: 'dev' }, { project: 'acme/other', baseBranch: 'master' }] })
  const deployment = testDeployment({ gitlab: { host: HOST, cli: '/path/glab', login: 'agent-bot', id: 7,
    email: `7-agent-bot@users.noreply.${HOST}`, projects: [PROJECT, 'acme/other'] } })
  const values = (trigger: Trigger) => gitlabKind.environment!.values({ deployment, config, trigger })
  expect(values(projectIssueTrigger(issue(5), PROJECT, HOST, 'agent-bot'))).toMatchObject({ DSH_SUPERAGENT_GITLAB_PROJECT: PROJECT,
    DSH_SUPERAGENT_GITLAB_BASE_BRANCH: 'dev', DSH_SUPERAGENT_GITLAB_MR_HEAD: '' })
  expect(values(projectMergeRequestTrigger(merge(6), PROJECT, HOST, 'agent-bot'))).toMatchObject({ DSH_SUPERAGENT_GITLAB_PROJECT: PROJECT,
    DSH_SUPERAGENT_GITLAB_BASE_BRANCH: 'dev', DSH_SUPERAGENT_GITLAB_MR_HEAD: 'refs/merge-requests/6/head' })
  expect(values(projectIssueTrigger(issue(7), 'acme/other', HOST, 'agent-bot'))).toMatchObject({ DSH_SUPERAGENT_GITLAB_BASE_BRANCH: 'master' })
})

it('accepts base branches only for watched projects and requires a branch name', () => {
  const schema = gitlabKind.schema
  expect(() => schema.parse({ host: HOST, cli: '/path/glab', projects: [{ path: PROJECT }],
    baseBranches: [{ project: 'acme/other', baseBranch: 'dev' }] })).toThrow('watched project')
  expect(() => schema.parse({ host: HOST, cli: '/path/glab', projects: [{ path: PROJECT }],
    baseBranches: [{ project: PROJECT, baseBranch: '' }] })).toThrow()
})
it('never combines a repository from one Source with a base branch from another', () => {
  const settings = SettingsSchema.parse({ executor: { repository: 'acme/default', baseBranch: 'dev' },
    sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: '/path/gh', baseBranch: 'release' } },
      gitlab: { enabled: true, config: { host: HOST, cli: '/path/glab', projects: [{ path: PROJECT }] } } } })
  const sources = new SourceRegistry(() => settings)
  sources.register(githubKind); sources.register(gitlabKind)
  const deployment = testDeployment({ gitlab: { host: HOST, cli: '/path/glab', login: 'agent-bot', id: 7,
    email: `7-agent-bot@users.noreply.${HOST}`, projects: [PROJECT] } })
  const trigger = projectIssueTrigger(issue(9), PROJECT, HOST, 'agent-bot')
  const env = Object.fromEntries(environmentOf({ deployment, sources, settings, ticket: { id: 't9', name: 't9', directory: '/srv/t9' }, trigger })
    .map(variable => [variable.key, variable.value]))
  // The GitLab Ticket names its project but has no GitLab base branch: the Executor default applies, not GitHub's `release`.
  expect(env).toMatchObject({ DSH_SUPERAGENT_REPOSITORY: PROJECT, DSH_SUPERAGENT_WORK_REF: 'refs/heads/dev' })
})
