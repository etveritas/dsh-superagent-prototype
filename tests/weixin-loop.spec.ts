import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { STALE_TOKEN_NOTE, WeixinConfigSchema, apply, pollWeixin, runWeixin, weixinKind } from '../src/sources/weixin.ts'
import { testDeployment } from './fixtures/deployment.ts'

const TOKEN = 'bot-token-1'
const account = { token: TOKEN }
const directories: string[] = []
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** A Store with the WeChat Source configured, its kind registered, and a SourceContext whose `receive` reaches a real Engine. */
function host(options: { enabled?: boolean; overrides?: Partial<SourceContextDeps> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weixin-loop-'))
  directories.push(directory)
  const store = new Store(join(directory, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { weixin: { enabled: options.enabled ?? true, config: { token: TOKEN } } },
    policy: { sources: { weixin: { allowed: [{ id: 'wxid_alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(weixinKind)
  const deployment = testDeployment({ weixin: account })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...options.overrides }
  return { ...deps, store, engine, board, receive, ctx: sourceContextOf(deps, weixinKind) }
}
/** One message of `getUpdates`, complete and text-only unless overridden. */
const message = (id: string, over: Record<string, unknown> = {}) => ({ message_id: id, from_user_id: 'wxid_alice', to_user_id: 'bot-1',
  message_type: 1, message_state: 2, create_time_ms: Date.parse('2026-09-09T00:00:00Z'), context_token: `ctx-${id}`,
  item_list: [{ type: 1, text_item: { text: 'Please fix the build' } }], ...over })
/** Stubs `fetch` with the body `getUpdates` should answer, and returns the requested URLs. */
function answer(body: () => unknown): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(String(url))
    return new Response(JSON.stringify(body()), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return { urls }
}

describe('weixin kind', () => {
  it('is a direct-message Source whose card logs the bot in', () => {
    expect(weixinKind.kind).toBe('weixin')
    expect(weixinKind.health).toEqual(['weixin'])
    expect(weixinKind.fields.map(field => field.key)).toEqual(['token', 'baseUrl', 'botAgent'])
    expect(weixinKind.login).toBeDefined()
    expect(weixinKind.scope?.({ meta: {} }, WeixinConfigSchema.parse({}))).toEqual({ listened: true, observed: false, row: 'direct' })
  })

  it('admits an allowed sender who writes to the bot, and nobody else', () => {
    const policy = weixinKind.policy!
    expect(policy.rows!(WeixinConfigSchema.parse({}))).toEqual([{ id: 'direct', label: { zh: '私聊', en: 'Direct messages' },
      note: { zh: '接收', en: 'Received' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }])
    expect(policy.schema.parse({ allowed: [{ id: 'wxid_alice' }] })).toEqual({ allowed: [{ id: 'wxid_alice' }] })
  })

  it('fills the Executor variable from the conversation of a WeChat ticket and blanks it otherwise', () => {
    const trigger = { source: 'weixin', meta: { peer: 'wxid_alice' } } as unknown as Trigger
    expect(weixinKind.environment!.values({ deployment: testDeployment(), config: WeixinConfigSchema.parse({}), trigger }))
      .toEqual({ DSH_SUPERAGENT_WEIXIN_CHAT: 'wxid_alice' })
    expect(weixinKind.environment!.values({ deployment: testDeployment(), config: WeixinConfigSchema.parse({}) }))
      .toEqual({ DSH_SUPERAGENT_WEIXIN_CHAT: '' })
  })
})

describe('weixin poll round', () => {
  it('takes in the messages of one long poll and moves the cursor after them', async () => {
    const h = host()
    answer(() => ({ ret: 0, msgs: [message('m1')], get_updates_buf: 'buf-1', longpolling_timeout_ms: 20_000 }))
    expect(await pollWeixin(h.ctx, account, 35_000, new AbortController().signal)).toEqual({ read: 1, timeoutMs: 20_000 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(h.store.get(KV.weixin.buf)).toBe('buf-1')
    expect(h.engine.candidate(key('weixin', 'm1'))?.strength).toBe('explicit')
    // A replay of the same cursor stores nothing new, so a restart cannot duplicate work.
    expect(await pollWeixin(h.ctx, account, 20_000, new AbortController().signal)).toEqual({ read: 1, timeoutMs: 20_000 })
    expect(await h.receive.mock.results[1]!.value).toBe('duplicate')
    h.store.close()
  })

  it('keeps the cursor when the round is cut short, so the next one replays instead of dropping', async () => {
    const h = host({ overrides: { receive: vi.fn(() => { throw new Error('the store is unavailable') }) } })
    answer(() => ({ ret: 0, msgs: [message('m1')], get_updates_buf: 'buf-1' }))
    await expect(pollWeixin(h.ctx, account, 35_000, new AbortController().signal)).rejects.toThrow('the store is unavailable')
    expect(h.store.get(KV.weixin.buf)).toBeUndefined()
    h.store.close()
  })

  it('moves the cursor only when the server sent a new one', async () => {
    const h = host()
    answer(() => ({ ret: 0, msgs: [] }))
    expect(await pollWeixin(h.ctx, account, 35_000, new AbortController().signal)).toEqual({ read: 0, timeoutMs: 35_000 })
    expect(h.store.get(KV.weixin.buf)).toBeUndefined()
    h.store.close()
  })
})

describe('weixin loop', () => {
  it('reports the Source off while it is disabled', async () => {
    vi.useFakeTimers()
    const h = host({ enabled: false })
    const controller = new AbortController()
    const running = runWeixin(h.ctx, controller.signal)
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await running
    expect(h.board.all.weixin?.code).toBe('sourceOff')
    h.store.close()
  })

  it('reports an unset token while the deployment has no account', async () => {
    vi.useFakeTimers()
    const h = host({ overrides: { deployment: testDeployment({ weixin: undefined }) } })
    const controller = new AbortController()
    const running = runWeixin(h.ctx, controller.signal)
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await running
    expect(h.board.all.weixin?.code).toBe('weixinUnset')
    h.store.close()
  })

  it('takes a message in, reports ready, and stops when the loop is aborted', async () => {
    const h = host()
    answer(() => ({ ret: 0, msgs: [message('m1')], get_updates_buf: 'buf-1' }))
    const controller = new AbortController()
    // The poll's own receive aborts the loop, so the round finishes and the next one never starts.
    const original = h.receive.getMockImplementation()!
    h.receive.mockImplementation((trigger: Trigger) => { const result = original(trigger); controller.abort(); return result })
    await runWeixin(h.ctx, controller.signal)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.board.all.weixin?.state).toBe('ready')
    expect(h.store.get(KV.weixin.buf)).toBe('buf-1')
    h.store.close()
  })

  it('reports three consecutive failures as an error, then backs off', async () => {
    vi.useFakeTimers()
    const h = host()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const controller = new AbortController()
    const running = runWeixin(h.ctx, controller.signal)
    // Two quick retries reach the third failure, which reports and then waits a backoff.
    await vi.advanceTimersByTimeAsync(5_000)
    controller.abort()
    await running
    expect(h.board.all.weixin).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '3' } })
    h.store.close()
  })

  it('stops for an hour and says why when the token is stale', async () => {
    vi.useFakeTimers()
    const h = host()
    answer(() => ({ ret: -14, errmsg: 'token expired' }))
    const controller = new AbortController()
    const running = runWeixin(h.ctx, controller.signal)
    await vi.advanceTimersByTimeAsync(5_000)
    controller.abort()
    await running
    expect(h.board.all.weixin).toMatchObject({ state: 'error', detail: STALE_TOKEN_NOTE })
    expect(h.board.all.weixin?.code).toBeUndefined()
    h.store.close()
  })
})

describe('weixin plugin', () => {
  it('registers the kind and runs the loop, which disposal stops', async () => {
    const registered: string[] = []
    const disposed: (() => void)[] = []
    const report = vi.fn()
    const orchestrator = {
      sources: { register: (kind: { kind: string }) => { registered.push(kind.kind); return () => {} } },
      context: () => ({ ready: Promise.resolve(), configured: () => false, config: () => undefined, report, receive: vi.fn(),
        state: { get: () => undefined, set: () => {} }, threads: { describe: vi.fn() } }),
    }
    const ctx = { orchestrator,
      effect: (run: () => unknown) => { const dispose = run(); if (typeof dispose === 'function') disposed.push(dispose as () => void) } } as unknown as Context
    apply(ctx)
    expect(registered).toEqual(['weixin'])
    // The loop reports the Source off (no configuration) once its first turn runs, before pausing.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(report).toHaveBeenCalledWith('weixin', expect.objectContaining({ code: 'sourceOff' }))
    for (const dispose of disposed.reverse()) dispose()
  })
})
