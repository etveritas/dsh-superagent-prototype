import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, resolveGitlabDeployment, resolvePingcodeDeployment, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
/** Fake glab CLI signed in as `login`, a Developer of acme/widgets unless told otherwise; paths are what `glab api` receives. */
const glab = (file: string, options: { login?: string; level?: number; project?: string; userFails?: boolean; projectFails?: boolean } = {}): string => {
  const { login = 'agent-bot', level = 30, project = 'acme/widgets', userFails = false, projectFails = false } = options
  const user = userFails ? 'echo "Unauthenticated" >&2; exit 1' : `echo '${JSON.stringify({ id: 7, username: login, email: 'agent@example.com' })}'`
  const found = projectFails ? 'echo "404 Not Found" >&2; exit 1'
    : `echo '${JSON.stringify({ path_with_namespace: project, permissions: { project_access: { access_level: level }, group_access: null } })}'`
  return program(file, `case "$*" in\n  "--hostname gitlab.com api user") ${user} ;;\n  "--hostname gitlab.com api projects/acme%2Fwidgets") ${found} ;;\n  *) exit 1 ;;\nesac`)
}
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  const profile = () => ({ name: 'desktop', dir: join(dir, 'dsh', 'profiles', 'desktop'), home: join(dir, 'dsh') })
  it('defaults an unset state directory under the harness home and reads the editable fields through references', () => {
    const read = machineOf(Config({}), profile())
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'dsh', 'state', 'superagent'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    // A configured directory wins over the default; a composition without a profile has no home to default to.
    expect(machineOf(Config({ stateDir: join(dir, 'state') }), profile()).stateDir).toBe(join(dir, 'state'))
    expect(() => machineOf(Config({}))).toThrow('stateDir')
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('verifies the agent\'s glab account and Developer access to every GitLab project, or leaves GitLab out', async () => {
    expect(await resolveGitlabDeployment(machine(), {}, probe, path)).toBeUndefined()
    const file = glab(join(dir, 'bin', 'glab'))
    const config = (overrides: Record<string, unknown> = {}) => ({ host: 'gitlab.com', cli: 'glab', projects: [{ path: 'acme/widgets' }], ...overrides })
    expect(await resolveGitlabDeployment(machine(), config(), probe, path)).toEqual({ host: 'gitlab.com', cli: file, login: 'agent-bot', id: 7,
      email: 'agent@example.com', projects: ['acme/widgets'] })
    // A renamed project resolves by its old name and polls the canonical one.
    const renamed = glab(join(dir, 'bin', 'glab-renamed'), { project: 'acme/widgets-renamed' })
    expect((await resolveGitlabDeployment(machine(), config({ cli: renamed }), probe, path))!.projects).toEqual(['acme/widgets-renamed'])
    const refuses = async (code: string, values: Record<string, unknown>, gitlab: Record<string, unknown>) =>
      expect(resolveGitlabDeployment(machine(), config(gitlab), probe, path)).rejects.toEqual(setupError('gitlab', code, values))
    await refuses('gitlabProjectUnset', {}, { projects: [] })
    await refuses('gitlabCliMissing', { output: expect.stringContaining('is not an executable file') }, { cli: join(dir, 'bin', 'missing') })
    const reader = glab(join(dir, 'bin', 'glab-reader'), { level: 20 })
    await refuses('gitlabProjectReadOnly', { account: 'agent-bot', project: 'acme/widgets' }, { cli: reader })
    const outsider = glab(join(dir, 'bin', 'glab-outsider'), { projectFails: true })
    await refuses('gitlabProjectUnreadable', { account: 'agent-bot', project: 'acme/widgets', output: expect.stringContaining('404') }, { cli: outsider })
    const anonymous = glab(join(dir, 'bin', 'glab-anonymous'), { userFails: true })
    await refuses('gitlabCliSignedOut', { output: expect.stringContaining('Unauthenticated') }, { cli: anonymous })
  })
  it('verifies the PingCode skill, its python and user token, and resolves each project by ID, identifier or name', async () => {
    const skills = (name: string, options: { tokenInvalid?: boolean; user?: object } = {}): string => {
      const folder = join(dir, name)
      mkdirSync(join(folder, 'scripts'), { recursive: true })
      const user = JSON.stringify(options.user ?? { id: 'u-1', name: 'agent-bot', display_name: 'Agent Bot' })
      const projects = JSON.stringify({ values: [{ id: 'p-1', identifier: 'SCR', name: 'Scrum' }, { id: 'p-2', identifier: 'OPS', name: 'Ops' }] })
      // The real skill prints the API's error on stdout and `⚠️ HTTP <status>` on stderr, then exits 1.
      writeFileSync(join(folder, 'scripts', 'api_call.py'), options.tokenInvalid
        ? `echo '{"code":"100026","message":"access_token无效"}'\necho '⚠️ HTTP 401' >&2\nexit 1`
        : `case "$*" in\n  "GET /v1/myself") echo '${user}' ;;\n  "GET /v1/pjm/projects --fetch-all") echo '${projects}' ;;\n  *) exit 1 ;;\nesac`)
      return folder
    }
    const good = skills('pingcode')
    const config = (overrides: Record<string, unknown> = {}) => ({ skill: good, python: '/bin/sh', projects: [{ project: 'SCR' }, { project: 'ops' }], ...overrides })
    expect(await resolvePingcodeDeployment(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolvePingcodeDeployment(machine(), config(), probe, path)).toEqual({ skill: good, python: '/bin/sh', login: 'agent-bot',
      id: 'u-1', displayName: 'Agent Bot', projects: [{ id: 'p-1', identifier: 'SCR', name: 'Scrum' }, { id: 'p-2', identifier: 'OPS', name: 'Ops' }] })
    const refuses = async (code: string, values: Record<string, unknown>, pingcode: Record<string, unknown>) =>
      expect(resolvePingcodeDeployment(machine(), config(pingcode), probe, path)).rejects.toEqual(setupError('pingcode', code, values))
    await refuses('pingcodeProjectUnset', {}, { projects: [] })
    await refuses('pingcodeSkillMissing', {}, { skill: join(dir, 'nothing') })
    await refuses('pingcodePythonMissing', { output: expect.stringContaining('is not an executable file') }, { python: 'python-that-is-not-installed' })
    await refuses('pingcodeTokenInvalid', { output: expect.stringContaining('HTTP 401') }, { skill: skills('pingcode-invalid', { tokenInvalid: true }) })
    await refuses('pingcodeProjectUnreadable', { project: 'missing' }, { projects: [{ project: 'missing' }] })
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
