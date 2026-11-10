/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'
import { sameName } from './infra/text.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/**
 * Launcher-supplied profile facts: the profile's name and directory and the DeepSeek Harness home the launcher resolved.
 * The loader provides them to every plugin of a profile composition; a plain `dsh` tree has none.
 */
export interface ProfileFacts {
  name: string
  dir: string
  home: string
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The launcher's profile facts, present while this composition runs a DSH profile. */
    profileContext?: ProfileFacts
  }
}
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.')
    .description('Omitted, it is `state/superagent` under the DeepSeek Harness home.'),
  personalGitlabHost: s.string().pattern(/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/).description('HTTPS GitLab host for WeCom personal authorization.'),
  personalGitlabAdmins: s.array(s.string()).default([]).description('WeCom user IDs allowed to register GitLab projects.'),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  personalGitlabHost?: string
  personalGitlabAdmins?: string[]
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig, profile?: ProfileFacts): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir: stateDirectory(config, profile), ...config.personalGitlabHost ? { personalGitlabHost: config.personalGitlabHost, personalGitlabAdmins: config.personalGitlabAdmins } : {}, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

/**
 * The state directory this entry uses: the configured absolute path, or `state/superagent` under the harness home the
 * launcher resolved. A profile composition always names that home, so an entry without configuration starts; a
 * composition without a profile has no home to default to and must name the directory.
 */
export function stateDirectory(config: DeploymentConfig, profile: ProfileFacts | undefined): string {
  if (config.stateDir !== undefined) return config.stateDir
  if (profile === undefined) throw new Error('dsh-superagent has no stateDir and runs outside a profile, so there is no DeepSeek Harness home to default it to; set config.stateDir (docs/006-deployment.md)')
  return join(profile.home, 'state', 'superagent')
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** The WeCom intelligent robot's identity: the bot id, its secret, and, for a private deployment, its long-connection URL. */
export const WecomBotSchema = z.object({
  botId: z.string().trim().max(128).default(''),
  secret: z.string().trim().max(512).default(''),
  wsUrl: z.string().trim().regex(/^(wss?:\/\/[^\s]+)?$/, 'ws:// or wss:// URL').default(''),
})
/**
 * The WeChat bot account behind the iLink long poll: the token scanning the login code produces, the iLink API base URL
 * (blank for the public one), and the `bot_agent` the requests declare. Nothing here is verified over the network at setup.
 */
export const WeixinAccountSchema = z.object({
  token: z.string().trim().max(512).default(''),
  baseUrl: z.string().trim().regex(/^(https?:\/\/[^\s]+)?$/, 'http:// or https:// URL').default(''),
  botAgent: z.string().trim().max(256).default(''),
})
/** The GitLab instance, the agent's glab wrapper, and the projects the Source watches; all three are verified at setup. */
export const GitlabAccountsSchema = z.object({
  host: z.string().trim().regex(/^[A-Za-z0-9.-]+(?::[0-9]+)?$/, 'host').default('gitlab.com'),
  cli: z.string().trim().default(''),
  projects: z.array(z.object({ path: z.string().trim().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/, 'group/project') }).strict())
    .refine(projects => new Set(projects.map(project => project.path)).size === projects.length, 'Duplicate project paths').default([]),
})
/** The PingCode skill directory (blank auto-detects the usual install locations), its `python3`, and the projects the Source watches. */
export const PingcodeAccountsSchema = z.object({
  skill: z.string().trim().default(''),
  python: z.string().trim().default('python3'),
  projects: z.array(z.object({ project: z.string().trim().min(1).max(64) }).strict())
    .refine(projects => new Set(projects.map(item => item.project.toLowerCase())).size === projects.length, 'Duplicate projects').default([]),
})
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape),
  wecom: Object.keys(WecomBotSchema.shape), weixin: Object.keys(WeixinAccountSchema.shape), gitlab: Object.keys(GitlabAccountsSchema.shape),
  pingcode: Object.keys(PingcodeAccountsSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github?: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
  wecom?: WecomBot
  weixin?: WeixinAccount
  gitlab?: GitlabAccount
  pingcode?: PingcodeAccount
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The verified WeCom bot identity; `wsUrl` overrides the public long-connection address for a private deployment. */
export interface WecomBot { botId: string; secret: string; wsUrl?: string }
/** The WeChat bot token the iLink long poll authenticates with, its API base URL, and the `bot_agent` requests declare. */
export interface WeixinAccount { token: string; baseUrl?: string; botAgent?: string }
/** The verified GitLab account and its projects, canonical paths as GitLab reports them; `email` is the commit identity for workers. */
export interface GitlabAccount { host: string; cli: string; login: string; id: number; email: string; projects: string[] }
/** The PingCode account behind the skill's user token, the skill directory that holds its scripts, and the projects it watches. */
export interface PingcodeAccount { skill: string; python: string; login: string; id: string; displayName: string; projects: PingcodeProject[] }
/** One watched PingCode project, named the way the API reports it. */
export interface PingcodeProject { id: string; identifier: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const GitlabUser = z.object({ id: z.number().int().positive(), username: z.string().regex(/^[A-Za-z0-9_.-]+$/), email: z.string().nullish() })
const GitlabProject = z.object({ path_with_namespace: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/),
  permissions: z.object({ project_access: z.object({ access_level: z.number() }).nullish(),
    group_access: z.object({ access_level: z.number() }).nullish() }).nullish() })
/** GitLab access levels: Guest 10, Reporter 20, Developer 30, Maintainer 40. Workers push branches and open merge requests, so Developer is the minimum. */
const DEVELOPER = 30
/**
 * Verify the agent's glab wrapper, its GitLab account, and push access to every configured project.
 * Returns undefined while the Source names no CLI, so a GitLab-less installation keeps working.
 */
export async function resolveGitlabDeployment(machine: Machine, gitlab: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<GitlabAccount | undefined> {
  const { host, cli: name, projects } = GitlabAccountsSchema.parse(gitlab ?? {})
  if (!name) return undefined
  if (!projects.length) throw new SetupError('gitlabProjectUnset')
  let cli: string
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const run = (args: string[]): Promise<string> => probe([cli, '--hostname', host, ...args])
    .catch((error: unknown) => { throw new SetupError('gitlabCliFailed', { output: reason(error) }) })
  const agent = parsed(GitlabUser, await run(['api', 'user']).catch((error: unknown) => {
    throw new SetupError('gitlabCliSignedOut', { output: reason(error) })
  }))
  if (!agent) throw new SetupError('gitlabCliNoAccount')
  const canonical: string[] = []
  for (const { path: project } of projects) {
    const info = parsed(GitlabProject, await run(['api', `projects/${encodeURIComponent(project)}`]).catch((error: unknown) => {
      throw new SetupError('gitlabProjectUnreadable', { account: agent.username, project, output: reason(error) })
    }))
    if (!info) throw new SetupError('gitlabProjectUnreadable', { account: agent.username, project })
    const level = Math.max(info.permissions?.project_access?.access_level ?? 0, info.permissions?.group_access?.access_level ?? 0)
    if (level < DEVELOPER) throw new SetupError('gitlabProjectReadOnly', { account: agent.username, project: info.path_with_namespace })
    canonical.push(info.path_with_namespace)
  }
  // A verified account without an email address commits as GitLab's no-reply address for its numeric ID and username.
  const domain = host.replace(/:\d+$/, '')
  return { host, cli, login: agent.username, id: agent.id, email: agent.email || `${agent.id}-${agent.username}@users.noreply.${domain}`, projects: [...new Set(canonical)] }
}

/** Conventional PingCode skill install locations; a candidate holds its scripts/api_call.py. */
export function defaultSkillDirs(): string[] {
  let home = ''
  try { home = homedir() } catch { /* Without a home directory only an explicit skill directory can work. */ }
  return home ? [join(home, '.agents', 'skills', 'pingcode'), join(home, '.workbuddy', 'skills', 'pingcode')] : []
}
/** The API-calling script inside a skill directory, whose `.env` holds the credentials. */
export const skillScript = (dir: string): string => join(dir, 'scripts', 'api_call.py')
/** Resolves the configured skill directory, or the first auto-detected one that holds the script. */
export function resolveSkillDir(configured: string): string | undefined {
  const holds = (dir: string): boolean => { try { readFileSync(skillScript(dir)); return true } catch { return false } }
  return configured ? holds(configured) ? configured : undefined : defaultSkillDirs().find(holds)
}

const PingcodeUser = z.object({ id: z.string(), name: z.string().nullish(), display_name: z.string().nullish() })
const PingcodeProjects = z.object({ values: z.array(z.looseObject({ id: z.string(), identifier: z.string().nullish(), name: z.string().nullish() })).default([]) })
/**
 * Verify the PingCode skill directory, its python3, the user token in the skill's `.env`, and every configured project.
 * Returns undefined while the Source names neither a skill nor a project, so a PingCode-less installation keeps working.
 */
export async function resolvePingcodeDeployment(machine: Machine, pingcode: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<PingcodeAccount | undefined> {
  const { skill, python, projects } = PingcodeAccountsSchema.parse(pingcode ?? {})
  if (!projects.length && !skill) return undefined
  if (!projects.length) throw new SetupError('pingcodeProjectUnset')
  const dir = resolveSkillDir(skill)
  if (!dir) throw new SetupError('pingcodeSkillMissing', { skill: skill || defaultSkillDirs().join('、') })
  let bin: string
  try { bin = executable(python, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('pingcodePythonMissing', { output: reason(error) }) }
  // Without `--raw` the script prints the API's error on stderr as `⚠️ HTTP <status>`, which tells a rejected token apart from
  // an unreachable instance; both failures print the same `{code, message}` body on stdout.
  const run = (args: string[]): Promise<string> => probe([bin, skillScript(dir), ...args]).catch((error: unknown) => {
    const text = reason(error)
    if (/HTTP 401|access_token|100026|Unauthorized|令牌|授权/.test(text)) throw new SetupError('pingcodeTokenInvalid', { output: text })
    throw new SetupError('pingcodeCliFailed', { output: text })
  })
  const me = parsed(PingcodeUser, await run(['GET', '/v1/myself']))
  if (!me) throw new SetupError('pingcodeNoAccount')
  const listing = parsed(PingcodeProjects, await run(['GET', '/v1/pjm/projects', '--fetch-all']))
  const all = listing?.values ?? []
  // A project may be named by ID, identifier or name; the API's own names are what cursors and URLs use afterwards.
  const canonical: PingcodeProject[] = []
  for (const { project } of projects) {
    const found = all.find(item => item.id === project || sameName(item.identifier ?? '', project) || sameName(item.name ?? '', project))
    if (!found) throw new SetupError('pingcodeProjectUnreadable', { project })
    if (!canonical.some(item => item.id === found.id)) canonical.push({ id: found.id, identifier: found.identifier ?? '', name: found.name ?? '' })
  }
  return { skill: dir, python: bin, login: me.name || me.id, id: me.id, displayName: me.display_name || me.name || '', projects: canonical }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

/**
 * Reads the WeCom bot identity the Source's long connection subscribes with. WeCom keeps one connection per bot, so setup
 * checks that the credentials are complete; whether they work surfaces as the Source's health once it connects.
 */
export async function resolveWecomBot(wecom: unknown): Promise<WecomBot | undefined> {
  const { botId, secret, wsUrl } = WecomBotSchema.parse(wecom ?? {})
  if (!botId && !secret) return undefined
  if (!botId || !secret) throw new SetupError('wecomUnset')
  return { botId, secret, ...(wsUrl ? { wsUrl } : {}) }
}

/**
 * Reads the WeChat bot account the Source long-polls with; a blank token leaves the Source out (it reports `weixinUnset`
 * while enabled). Like WeCom's credentials, whether the token works shows in the Source's health once it polls.
 */
export async function resolveWeixinAccount(weixin: unknown): Promise<WeixinAccount | undefined> {
  const { token, baseUrl, botAgent } = WeixinAccountSchema.parse(weixin ?? {})
  if (!token) return undefined
  return { token, ...(baseUrl ? { baseUrl } : {}), ...(botAgent ? { botAgent } : {}) }
}
