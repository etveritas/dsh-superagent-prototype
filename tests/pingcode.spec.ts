import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { sendPingcode } from '../src/sources/pingcode-channel.ts'
import { readPingcode } from '../src/sources/pingcode-read.ts'
import { agentNames, commentTrigger, mentions, ownWork, pingcodeRef, pingcodeText, pingcodeThread, workItemTrigger } from '../src/sources/pingcode-trigger.ts'
import { apply, pingcodeKind, pollRound, pollThreads, type PingcodeConfig } from '../src/sources/pingcode.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const PROJECT = 'proj-scrum'
const SKILL = '/path/pingcode-skill'
// One minute ahead of the first round's cursor, so the fixtures count as new work.
const now = Math.floor(Date.now() / 1000) + 60
const alice = { id: 'u-alice', name: 'alice', display_name: 'Alice' }
const agent = { id: 'u-agent', name: 'agent-bot', display_name: 'Agent Bot' }
const item = (id: string, overrides: Record<string, unknown> = {}) => ({ id, identifier: 'SCR-1', title: 'Fix the bug',
  description: '<p>Please fix it</p>', type: 'task', created_at: now, updated_at: now, html_url: `https://x.pingcode.com/pjm/workitems/${id}`,
  project: { id: PROJECT, identifier: 'SCR', name: 'Scrum' }, created_by: alice, ...overrides })
const comment = (id: string, content: string, overrides: Record<string, unknown> = {}) =>
  ({ id, content: `<p>${content}</p>`, created_at: now, created_by: alice, is_deleted: 0, ...overrides })

type Routes = Record<string, unknown | (() => unknown)>
/** A Source context over a real Store and registry, with `api_call.py` answered by path and the triggers it received recorded. */
function context(routes: Routes, options: { register?: boolean; pingcode?: boolean } = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pingcode-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    policy: { sources: { pingcode: { allowed: [{ id: 'alice' }] } } },
    sources: { pingcode: { enabled: true, config: { skill: SKILL, python: '/usr/bin/python3', projects: [{ project: PROJECT }],
      observeWorkItems: true, observeComments: true } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  if (options.register !== false) sources.register(pingcodeKind)
  const deployment = testDeployment({ stateDir: join(tmpdir(), 'pingcode-state'),
    ...options.pingcode === false ? {} : { pingcode: { skill: SKILL, python: '/usr/bin/python3', login: 'agent-bot', id: 'u-agent',
      displayName: 'Agent Bot', projects: [{ id: PROJECT, identifier: 'SCR', name: 'Scrum' }] } } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const reads: { method: string; path: string; args: string[] }[] = []
  vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    const method = String(args[1] ?? ''), path = String(args[2] ?? '')
    reads.push({ method, path, args })
    const route = routes[path] ?? routes[`${method} ${path}`] ?? (path === '/v1/comments' ? { values: [] } : {})
    const value = typeof route === 'function' ? route() : route
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  const seen = new Map<string, Trigger>()
  const receive = vi.fn(async (trigger: Trigger) => seen.has(trigger.id) ? 'duplicate' as const : (seen.set(trigger.id, trigger), 'stored' as const))
  const parts: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() }, outbox: { send: () => {} },
    commands, sources, deployment, ready: Promise.resolve(), configured: () => true, receive }
  const ctx = sourceContextOf(parts, { kind: 'pingcode', health: ['pingcode'] })
  const host = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  return { ctx, host, store, commands, receive, seen, reads, board, sources }
}
const triggers = (receive: ReturnType<typeof context>['receive']) => receive.mock.calls.map(call => call[0]!)
afterEach(() => { vi.restoreAllMocks() })

describe('pingcode triggers', () => {
  it('turns work items and comments into triggers that name their project and item', () => {
    const said = commentTrigger(comment('c-11', 'hi @Agent Bot, please look'), { project: PROJECT, item: 'i-5' }, ['Agent Bot', 'agent-bot'],
      'u-agent', `https://x.pingcode.com/pjm/workitems/i-5`)
    expect(said).toMatchObject({ id: key('pingcode-comment', 'i-5', 'c-11'), source: 'pingcode', human: true,
      threads: [{ source: 'pingcode', id: 'i-5' }], actor: { source: 'pingcode', id: 'alice' }, addressed: 'mention', text: 'hi @Agent Bot, please look',
      channel: { source: 'pingcode', thread: 'pingcode:i-5', address: { project: PROJECT, item: 'i-5', commentId: 'c-11' } },
      meta: { project: PROJECT, item: 'i-5', kind: 'comment', commentId: 'c-11' } })
    const opened = workItemTrigger(item('i-5') as never, PROJECT, ['Agent Bot'], 'u-agent')
    expect(opened).toMatchObject({ id: key('pingcode-work-item', PROJECT, 'i-5'), human: true, text: 'SCR-1 Fix the bug\n\nPlease fix it',
      url: 'https://x.pingcode.com/pjm/workitems/i-5', meta: { project: PROJECT, item: 'i-5', kind: 'workItem', identifier: 'SCR-1' } })
    // The agent's own comment is never a person's message.
    expect(commentTrigger(comment('c-12', 'done', { created_by: agent }), { project: PROJECT, item: 'i-5' }, ['Agent Bot'], 'u-agent')).toMatchObject({ human: false })
  })
  it('flattens HTML, reads mentions of either account name, and identifies the agent\'s own work', () => {
    expect(pingcodeText('<p>one</p><p>two<br>three</p>')).toBe('one\ntwo\nthree')
    expect(pingcodeText('a &amp; b')).toBe('a & b')
    expect([mentions('ping @Agent Bot', ['Agent Bot']), mentions('ping @agent-bot', ['Agent Bot', 'agent-bot']), mentions('no', ['Agent Bot'])])
      .toEqual([true, true, false])
    expect([ownWork(agent, 'u-agent'), ownWork(alice, 'u-agent')]).toEqual([true, false])
    expect(pingcodeRef(workItemTrigger(item('i-5') as never, PROJECT, [], 'u-agent'))).toEqual({ project: PROJECT, item: 'i-5' })
    expect(agentNames({ login: 'agent-bot', displayName: 'Agent Bot' })).toEqual(['Agent Bot', 'agent-bot'])
  })
  it('scopes each kind by its observe switch and names the policy rows', () => {
    const config = pingcodeKind.schema.parse({}) as PingcodeConfig
    expect(pingcodeKind.scope!({ meta: { kind: 'comment' } }, config)).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(pingcodeKind.scope!({ meta: { kind: 'workItem' } }, { ...config, observeWorkItems: true })).toMatchObject({ observed: true, row: 'workItems' })
    expect(pingcodeKind.policy!.rows!({ observeComments: true }).map(row => row.id)).toEqual(['workItems', 'comments'])
    expect(pingcodeKind.policy!.rows!({})[1]).toMatchObject({ note: { zh: '仅 @', en: '@ only' } })
  })
})

describe('pingcode polling', () => {
  it('reads a project\'s changed work items and comments, skipping the agent\'s own', async () => {
    const h = context({ '/v1/pjm/work_items/search': { values: [item('i-5')] },
      '/v1/comments': { values: [comment('c-11', 'first'), comment('c-12', 'mine', { created_by: agent })] } })
    expect(await pollRound(h.ctx)).toBe(60)
    expect(triggers(h.receive).map(trigger => trigger.meta.kind)).toEqual(['workItem', 'comment'])
    expect(h.board.all.pingcode).toMatchObject({ state: 'ready' })
    expect(h.store.get(`pingcode-since:${PROJECT}`)).toBeTruthy()
    // The same items on the next round produce the same IDs, which the Engine deduplicates.
    await pollRound(h.ctx)
    expect(new Set(triggers(h.receive).map(trigger => trigger.id)).size).toBe(2)
  })
  it('receives a mention even with the comments switch off, and other comments only with it on', async () => {
    const routes = { '/v1/pjm/work_items/search': { values: [item('i-5', { description: '' })] },
      '/v1/comments': { values: [comment('c-11', 'ping @agent-bot'), comment('c-12', 'plain')] } }
    const quiet = context(routes)
    quiet.store.saveSettings(SettingsSchema.parse({ ...quiet.store.settings(), sources: { pingcode: { enabled: true,
      config: { skill: SKILL, python: '/usr/bin/python3', projects: [{ project: PROJECT }] } } } }))
    await pollRound(quiet.ctx)
    expect(triggers(quiet.receive).map(trigger => trigger.meta.commentId)).toEqual(['c-11'])
    const all = context(routes)
    all.store.saveSettings(SettingsSchema.parse({ ...all.store.settings(), sources: { pingcode: { enabled: true,
      config: { skill: SKILL, python: '/usr/bin/python3', projects: [{ project: PROJECT }], observeComments: true } } } }))
    await pollRound(all.ctx)
    expect(triggers(all.receive).map(trigger => trigger.meta.commentId)).toEqual(['c-11', 'c-12'])
  })
  it('keeps a failed project read as a round failure and reports a clean round otherwise', async () => {
    const failing = context({ '/v1/pjm/work_items/search': () => { throw new CliError('boom', 500) } })
    await expect(pollRound(failing.ctx)).rejects.toThrow('PingCode reads failed')
  })
  it('polls a subscribed Thread from its own cursor and keeps a read failure on the thread', async () => {
    const h = context({ '/v1/pjm/work_items/i-5': item('i-5'), '/v1/comments': { values: [comment('c-31', 'later')] } })
    h.store.threads.save({ key: 'pingcode:i-5', ref: { source: 'pingcode', id: 'i-5' }, createdAt: '2026-01-01T00:00:00.000Z',
      lastAt: new Date().toISOString(), subscriptions: ['ticket'], correlated: [], pending: [], meta: { item: 'i-5', project: PROJECT } })
    await pollThreads(h.ctx)
    expect(triggers(h.receive)).toMatchObject([{ id: key('pingcode-comment', 'i-5', 'c-31'), text: 'later' }])
    expect(h.store.get('pingcode-thread:pingcode:i-5')).toBeTruthy()
    const failing = context({ '/v1/pjm/work_items/i-5': () => { throw new CliError('denied', 403) } })
    failing.store.threads.save({ key: 'pingcode:i-5', ref: { source: 'pingcode', id: 'i-5' }, createdAt: '2026-01-01T00:00:00.000Z',
      lastAt: new Date().toISOString(), subscriptions: ['ticket'], correlated: [], pending: [], meta: { item: 'i-5', project: PROJECT } })
    await pollThreads(failing.ctx)
    expect(failing.store.threads.get('pingcode:i-5')?.meta.pollError).toContain('denied')
  })
  it('registers its kind and reports what setup still misses', async () => {
    const h = context({}, { register: false, pingcode: false })
    const disposers: (() => unknown)[] = []
    apply({ orchestrator: h.host, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(h.sources.kind('pingcode')).toBe(pingcodeKind)
    await vi.waitFor(() => expect(h.board.all.pingcode).toMatchObject({ state: 'paused', code: 'pingcodeUnset' }))
    for (const dispose of disposers) await dispose()
  })
})

describe('pingcode channel and resources', () => {
  it('posts a marked comment, settles on the marker and treats a deleted work item as gone', async () => {
    const h = context({ '/v1/comments': { values: [] } })
    const message = (id: string) => ({ id, kind: 'reply' as const, text: 'Done', channel: { source: 'pingcode', thread: 'pingcode:i-5',
      address: { project: PROJECT, item: 'i-5' } } })
    expect(await sendPingcode(h.ctx, message('m1'))).toBe('sent')
    const posted = h.reads.find(read => read.method === 'POST')!
    expect(posted.path).toBe('/v1/comments')
    const body = JSON.parse(posted.args[posted.args.indexOf('--body') + 1]!) as { content: string; principal_id: string }
    expect(body).toMatchObject({ principal_id: 'i-5' })
    expect(body.content).toContain('Done')
    expect(body.content).toContain('<!-- dsh-superagent:m1 -->')
    const deduped = context({ '/v1/comments': { values: [comment('c-41', 'Done\n\n<!-- dsh-superagent:m2 -->', { created_by: agent })] } })
    expect(await sendPingcode(deduped.ctx, message('m2'))).toBe('sent')
    expect(deduped.reads.filter(read => read.method === 'POST')).toEqual([])
    const gone = context({ '/v1/comments': () => { throw new CliError('Not Found', 404) } })
    expect(await sendPingcode(gone.ctx, message('m3'))).toBe('gone')
  })
  it('reads a work item and pages of its comments as model-facing messages', async () => {
    const comments = Array.from({ length: 25 }, (_, index) => comment(`c-${100 + index}`, `comment ${index}`))
    const h = context({ '/v1/pjm/work_items/i-5': item('i-5'), '/v1/comments': { values: comments } })
    expect(await readPingcode(h.commands, 'pingcode/i-5')).toMatchObject({ identifier: 'SCR-1', title: 'Fix the bug',
      message: { from: 'alice', text: 'SCR-1 Fix the bug\n\nPlease fix it' } })
    const page = await readPingcode(h.commands, 'pingcode/i-5/comments/1') as { messages: { id: string }[]; next_resource?: string }
    expect(page.messages.map(message => message.id)).toEqual(comments.slice(0, 20).map(row => row.id))
    expect(page.next_resource).toBe('pingcode/i-5/comments/2')
    await expect(readPingcode(h.commands, 'pingcode/../../etc')).rejects.toThrow('Use pingcode/')
  })
  it('calls only API paths, and reports a business error as a failure', async () => {
    const h = context({ '/v1/myself': { id: 'u-agent', name: 'agent-bot' } })
    expect(await h.commands.pingcode({ method: 'GET', path: '/v1/myself' })).toEqual({ id: 'u-agent', name: 'agent-bot' })
    expect(h.reads.at(-1)!.args.slice(0, 4)).toEqual([join(SKILL, 'scripts', 'api_call.py'), 'GET', '/v1/myself', '--raw'])
    await expect(h.commands.pingcode({ method: 'GET', path: '/etc/passwd' })).rejects.toThrow('restricted')
    await expect(h.commands.pingcode({ method: 'GET', path: '/v1/../etc' })).rejects.toThrow('restricted')
    const refused = context({ '/v1/comments': { code: '100026', message: "'access_token'无效" } })
    await expect(refused.commands.pingcode({ method: 'GET', path: '/v1/comments' })).rejects.toThrow("'access_token'无效 (100026)")
  })
})

describe('pingcode command failures', () => {
  it('keeps the error a script reports on stdout, which the PingCode skill does', () => {
    const error = commandError({ stdout: '{"code":"100026","message":"\'access_token\'无效"}', code: 1 })
    expect(error).toBeInstanceOf(CliError)
    expect(error.message).toBe("'access_token'无效 (100026)")
    expect(commandError({ stdout: 'not json', stderr: '', code: 1 }).message).toBe('not json')
    expect(commandError({ stderr: '', stdout: '', code: 1 }).message).toBe('command exited with code 1')
  })
})
