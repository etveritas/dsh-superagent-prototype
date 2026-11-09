/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, resolveGitlabDeployment, resolvePingcodeDeployment, resolveWecomBot, resolveWeixinAccount, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment, type AmbientGitConfiguration } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => [id === 'github' && settings.sources[id]?.enabled === false, ...keys.map(key => settings.sources[id]?.config[key] ?? '')]))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  gitlabProblem?: SetupProblem
  pingcodeProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  /** The operator's own git configuration selection, which the `git` shim restores in every shell outside an Executor Session. */
  private readonly ambientGit: AmbientGitConfiguration
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
    this.ambientGit = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if every account check is already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem && !this.gitlabProblem && !this.pingcodeProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    if (block === 'source:github' && settings.sources.github?.enabled === false) return
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : block === 'source:wecom' ? resolveWecomBot(settings.sources.wecom?.config)
        : block === 'source:weixin' ? resolveWeixinAccount(settings.sources.weixin?.config)
          : block === 'source:gitlab' ? resolveGitlabDeployment(machine, settings.sources.gitlab?.config, this.probe())
            : block === 'source:pingcode' ? resolvePingcodeDeployment(machine, settings.sources.pingcode?.config, this.probe())
              : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked, this.ambientGit)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment: Deployment = settings.sources.github?.enabled === false
      ? { ...machine, repository: '' }
      : await resolveDeployment(machine, settings.sources.github?.config, probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    // WeCom differs only in transport: incomplete credentials pause that Source alone, and a rejected subscription shows in its health.
    const wecom = await resolveWecomBot(settings.sources.wecom?.config).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      context.logger.warn('dsh-superagent leaves WeCom out: %s', error.message)
      return undefined
    })
    // WeChat follows WeCom: the panel logs the account in, and whether its token still works shows in the Source's health.
    const weixin = await resolveWeixinAccount(settings.sources.weixin?.config).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      context.logger.warn('dsh-superagent leaves WeChat out: %s', error.message)
      return undefined
    })
    // A broken GitLab account pauses only the GitLab Source.
    const gitlab = await resolveGitlabDeployment(machine, settings.sources.gitlab?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.gitlabProblem = error.problem
      context.logger.warn('dsh-superagent leaves GitLab out: %s', error.message)
      return undefined
    })
    // Like GitLab, a broken PingCode skill or token pauses only the PingCode Source.
    const pingcode = await resolvePingcodeDeployment(machine, settings.sources.pingcode?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.pingcodeProblem = error.problem
      context.logger.warn('dsh-superagent leaves PingCode out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}), ...(wecom ? { wecom } : {}), ...(weixin ? { weixin } : {}),
      ...(gitlab ? { gitlab } : {}), ...(pingcode ? { pingcode } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands, this.ambientGit).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
