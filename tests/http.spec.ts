import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('unsubscribes only the ticket named by ticket_id', async () => {
  const seen: unknown[] = []
  const call = serve({
    engine: { unsubscribe: (key: string, ticketId?: string) => { seen.push([key, ticketId]); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe?ticket_id=t1`))
    .toMatchObject({ status: 200, body: { removed: true, ticket_id: 't1', context_delivery: 'injected' } })
  expect(seen).toEqual([['feishu:oc_1:om/root', 't1']])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('starts a Source login, polls it, and verifies the code it asks for', async () => {
  const calls: string[] = []
  const svg = '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
  const login = {
    label: { zh: '扫码登录', en: 'Log in by scanning' },
    start: async () => { calls.push('start'); return { status: 'wait', svg } },
    wait: async () => { calls.push('wait'); return { status: 'scaned', svg } },
    verify: async (code: string) => { calls.push(`verify:${code}`); return { status: 'need_verifycode', svg } },
  }
  const call = serve({
    sources: { kind: (id: string) => id === 'weixin' ? { kind: 'weixin', login } : undefined,
      instance: (id: string) => id === 'weixin' ? { id, kind: id, enabled: true, config: { token: '' } } : undefined },
    settings: { block: (block: string) => ({ block, revision: 3, value: {} }),
      save: async () => { throw new Error('a login that is not confirmed saves nothing') } },
  })
  // A start request may carry no body at all, and its answer is the code view without any long poll.
  expect(await call('POST', 'sources/weixin/login')).toEqual({ status: 200, body: { status: 'wait', svg } })
  expect(await call('POST', 'sources/weixin/login', '')).toEqual({ status: 200, body: { status: 'wait', svg } })
  expect(await call('GET', 'sources/weixin/login')).toEqual({ status: 200, body: { status: 'scaned', svg } })
  // A body with a code is the phone's code, which `verify` stores for the next poll.
  expect(await call('POST', 'sources/weixin/login', { code: '1234' })).toEqual({ status: 200, body: { status: 'need_verifycode', svg } })
  expect(calls).toEqual(['start', 'start', 'wait', 'verify:1234'])
})

it('saves the credentials of a confirmed login as the Source configuration', async () => {
  const saves: unknown[] = []
  const login = { label: { zh: '扫码登录', en: 'Log in by scanning' },
    wait: async () => ({ status: 'confirmed', credentials: { token: 'bot-secret', baseUrl: 'https://api.test' } }) }
  const call = serve({
    sources: { kind: () => ({ kind: 'weixin', login }),
      instance: () => ({ id: 'weixin', kind: 'weixin', enabled: false, config: { token: '', baseUrl: '', botAgent: 'tag' } }) },
    settings: { block: (block: string) => ({ block, revision: 7, value: {} }),
      save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 8, policy_changed: false,
        restarting: true, context_delivery: 'pending' } } },
  })
  // Only the status and whether the panel restarts leaves the host; the bot token is saved, never returned.
  expect(await call('GET', 'sources/weixin/login')).toEqual({ status: 200, body: { status: 'confirmed', restarting: true } })
  expect(saves).toEqual([['source:weixin', { enabled: false,
    config: { token: 'bot-secret', baseUrl: 'https://api.test', botAgent: 'tag' } }, 7, 'panel']])
})

it('answers 404 for a login no Source offers', async () => {
  const call = serve({ sources: { kind: (id: string) => id === 'github' ? { kind: 'github' } : undefined } })
  expect(await call('POST', 'sources/github/login')).toEqual({ status: 404, body: { error: 'This Source has no login' } })
  expect(await call('GET', 'sources/missing/login')).toEqual({ status: 404, body: { error: 'This Source has no login' } })
})
