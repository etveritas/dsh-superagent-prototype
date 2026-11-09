/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY', ticket: true, description: { zh: '这个工单所在的仓库或项目：来源的项目，没有来源项目时用执行器的默认仓库；都未配置时为空。准备命令用它选择本地 clone', en: 'The repository or project this ticket works in: the Source\'s project, or the Executor\'s default repository when the ticket has no repository Source; empty when neither is configured. The prepare command uses it to choose the local clone' } },
  { key: 'DSH_SUPERAGENT_WORK_REF', ticket: true, description: { zh: '这个工单要检出的引用：接下它的 PR/MR 的 head，否则是 refs/heads/<基线分支>；既没有来源 head 也没有基线分支时为空。准备命令应当为空时报错，不要回退到远端的默认分支', en: 'The ref this ticket checks out: the head of the pull or merge request that started it, otherwise refs/heads/<base branch>; empty when neither a source head nor a base branch is configured. The prepare command should fail on empty instead of falling back to the remote\'s default branch' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  // Each Source's values are computed once. Roles are taken from one Source as a group: the Source that started the
  // Ticket when it names a repository, otherwise the first repository Source that does. A repository from one Source
  // and a base branch from another would describe unrelated repositories, so a missing role falls to the Executor's
  // defaults instead of another Source's value.
  const environments = sources.environments(settings).map(item => ({ ...item,
    values: item.environment.values({ deployment, config: item.config, ...trigger ? { trigger } : {} }) }))
  const origin = trigger?.threads[0]?.source
  const rolesOf = (item: typeof environments[number]): Partial<Record<'repository' | 'head' | 'base', string>> => {
    const roles: Partial<Record<'repository' | 'head' | 'base', string>> = {}
    for (const spec of item.environment.variables) {
      const value = item.values[spec.key] ?? ''
      if (spec.role && value && !roles[spec.role]) roles[spec.role] = value
    }
    return roles
  }
  const holders = environments.map(item => ({ kind: item.kind.kind, roles: rolesOf(item) })).filter(holder => holder.roles.repository)
  const roles = (holders.find(holder => holder.kind === origin) ?? holders[0])?.roles ?? {}
  const base = (roles.base || settings.executor.baseBranch).replace(/^refs\/heads\//, '')
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? {
    DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id,
    DSH_SUPERAGENT_REPOSITORY: roles.repository || settings.executor.repository,
    DSH_SUPERAGENT_WORK_REF: roles.head || (base ? `refs/heads/${base}` : '') } : {} }
  return [
    ...EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '',
      description: spec.description, owner: 'executor' })),
    ...environments.flatMap(item => item.environment.variables.map(spec => ({ key: spec.key, value: item.values[spec.key] ?? '',
      description: spec.description, owner: item.kind.kind }))),
  ]
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
