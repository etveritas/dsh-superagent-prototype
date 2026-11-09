/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { skillScript, type Deployment } from '../deployment.ts'
import { sameName } from './text.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  // A script that reports the failure on stdout, as the PingCode skill does, has nothing to say on stderr.
  const printed = (error as { stdout?: unknown } | null)?.stdout
  if (typeof printed === 'string' && printed.trim()) {
    const text = printed.trim().slice(0, 2000)
    try {
      const parsed = JSON.parse(text.slice(text.indexOf('{'))) as { code?: unknown; message?: unknown }
      if (typeof parsed.message === 'string') {
        const code = Number(parsed.code)
        return new CliError(`${parsed.message}${Number.isFinite(code) ? ` (${code})` : ''}`, Number.isFinite(code) ? code : undefined, exitCode)
      }
    } catch { /* Not a JSON error report; the printed text is kept below. */ }
    return new CliError(text, undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** One whitelisted PingCode API call: the method, an API path, query parameters and an optional JSON body. */
export interface PingcodeCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  params?: Record<string, string> | undefined
  body?: unknown
  /** Reads every page of a list endpoint, which the script merges into one `{total, values}`. */
  fetchAll?: boolean
}
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get githubAccount(): NonNullable<Deployment['github']> {
    const account = this.deployment.github
    if (!account) throw new Error('GitHub Source is disabled')
    return account
  }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  async run(program: string, args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      return stdout
    } catch (error) { throw commandError(error, program) }
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.githubAccount.cli, args)) as T }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.githubAccount.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /** The verified GitLab account; throws while the Source has no working CLI. */
  private get gitlab(): NonNullable<Deployment['gitlab']> {
    const gitlab = this.deployment.gitlab
    if (!gitlab) throw new Error('The GitLab Source has no working CLI')
    return gitlab
  }
  /** Runs the agent's `glab` against the deployment's instance and parses its JSON output. */
  async glab<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.gitlab.cli, ['--hostname', this.gitlab.host, ...args])) as T }
  /**
   * Calls the GitLab API on a path within one configured project, validating JSON output when a schema is provided
   * or returning raw CLI output when omitted.
   * @throws CliError with GitLab's HTTP status as `code` on failure.
   */
  async gitlabApi<T>(schema: z.ZodType<T>, project: string, path: string, ...flags: string[]): Promise<T>
  async gitlabApi(project: string, path: string, ...flags: string[]): Promise<string>
  async gitlabApi<T>(schema: z.ZodType<T> | string, project: string, path = '', ...flags: string[]): Promise<T | string> {
    // The raw overload passes the project where a schema would be, the path where the project would be, and its first flag as `path`.
    if (typeof schema === 'string') {
      return this.run(this.gitlab.cli, ['--hostname', this.gitlab.host, 'api', this.projectPath(schema, project), ...(path ? [path] : []), ...flags])
    }
    return schema.parse(await this.glab(['api', this.projectPath(project, path), ...flags]))
  }
  private projectPath(project: string, path: string): string {
    const configured = this.deployment.gitlab?.projects ?? []
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (!configured.some(item => sameName(item, project)) || outside) throw new Error('GitLab calls are restricted to the configured projects')
    return `projects/${encodeURIComponent(project)}${path ? `/${path}` : ''}`
  }
  /**
   * Calls the PingCode API through the skill's `scripts/api_call.py`, validating JSON output.
   * Only the API's `/v1` paths are reachable, and the skill's own `.env` decides which account answers.
   * @throws CliError naming the API's error code when the call fails.
   */
  async pingcode<T>(call: PingcodeCall): Promise<T> {
    const account = this.deployment.pingcode
    if (!account) throw new Error('The PingCode Source has no working skill directory')
    const path = call.path
    if (!/^\/v1\/[A-Za-z0-9_.\-/]+$/.test(path) || path.includes('..')) throw new Error('PingCode calls are restricted to the API v1 paths')
    const params = Object.keys(call.params ?? {}).filter(key => (call.params?.[key] ?? '') !== '').sort()
    const argv = [skillScript(account.skill), call.method, path, '--raw', ...call.fetchAll ? ['--fetch-all'] : []]
    if (params.length) argv.push('--params', ...params.map(key => `${key}=${String(call.params?.[key])}`))
    if (call.body !== undefined) argv.push('--body', JSON.stringify(call.body))
    const text = await this.run(account.python, argv)
    let value: unknown
    try { value = JSON.parse(text.slice(Math.max(0, text.search(/[[{]/)))) } catch { throw new CliError(`PingCode returned no JSON: ${text.trim().slice(0, 200)}`) }
    // A business error arrives with HTTP 200 as `{code, message}`; treating it as data would read as an empty result.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const error = value as Record<string, unknown>
      if (typeof error.code === 'string' && typeof error.message === 'string' && !('id' in error) && !('values' in error) && !('total' in error)) {
        const code = Number(error.code)
        throw new CliError(`${error.message} (${error.code})`, Number.isFinite(code) ? code : undefined)
      }
    }
    return value as T
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
