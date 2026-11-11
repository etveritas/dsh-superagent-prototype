/** Isolates ticket commands from host files and the GitLab credential broker. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

export const RunnerOperation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shell'), command: z.string().min(1).max(20_000) }).strict(),
  z.object({ kind: z.literal('codex'), prompt: z.string().min(1).max(20_000) }).strict(),
  z.object({ kind: z.literal('hermes'), prompt: z.string().min(1).max(20_000) }).strict(),
])
const docker = '/usr/bin/docker'
const processEnv = { PATH: '/usr/bin:/bin' }
const execute = promisify(execFile)
export type RunnerProcess = (binary: string, args: string[], options: {
  env: Record<string, string>; signal?: AbortSignal; maxBuffer?: number
}) => Promise<{ stdout: string; stderr: string }>

/** Runs a single command or agent in an operator-provisioned image with one workspace mount. */
export class PersonalGitLabRunner {
  constructor(private readonly image: string, private readonly spawn: RunnerProcess = execute,
    private readonly modelKey?: string) {
    if (!/^[a-z0-9][a-z0-9.:/_@-]*$/i.test(image)) throw new Error('Invalid isolated GitLab worker image')
    if (modelKey && !/^[A-Z][A-Z0-9_]*$/.test(modelKey)) throw new Error('Invalid worker model environment variable name')
  }

  async run(directory: string, operation: z.infer<typeof RunnerOperation>, signal?: AbortSignal) {
    if (!isAbsolute(directory) || /[,\r\n"\0]/.test(directory)) throw new Error('Invalid workspace for the isolated runner')
    const uid = process.getuid?.(), gid = process.getgid?.()
    if (!uid || gid === undefined) throw new Error('Isolated GitLab execution requires a non-root Linux deployment')
    const name = 'dsh-gitlab-' + randomUUID()
    const argv = operation.kind === 'shell' ? ['/bin/sh', '-c', operation.command]
      : operation.kind === 'codex' ? ['codex', 'exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '--', operation.prompt]
        : ['hermes', 'chat', '--oneshot', '--query=' + operation.prompt]
    const timeout = AbortSignal.timeout(300_000)
    const runSignal = signal ? AbortSignal.any([timeout, signal]) : timeout
    const modelKey = operation.kind !== 'shell' ? this.modelKey : undefined
    const modelValue = modelKey ? process.env[modelKey] : undefined
    if (modelKey && !modelValue) throw new Error('The isolated agent model credential is not configured')
    const options = { env: modelKey && modelValue ? { ...processEnv, [modelKey]: modelValue } : processEnv, signal: runSignal, maxBuffer: 256 * 1024 }
    try {
      return await this.spawn(docker, ['run', '--rm', '--pull=never', '--name', name,
        '--user', `${uid}:${gid}`, '--network', 'bridge', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit=256',
        '--memory=2g', '--cpus=2', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=512m',
        '--workdir', '/workspace', '--env', 'HOME=/tmp', '--mount', `type=bind,source=${directory},target=/workspace,bind-recursive=disabled`,
        ...(modelKey ? ['--env', modelKey] : []), '--entrypoint', argv[0]!, this.image, ...argv.slice(1)], options)
    } catch (error) {
      await this.spawn(docker, ['rm', '-f', name], { env: processEnv, signal: AbortSignal.timeout(5000) }).catch(() => {})
      if (runSignal.aborted) throw new Error('The isolated worker stopped or timed out')
      const failure = error as { code?: unknown; stdout?: string; stderr?: string }
      return { exitCode: failure.code ?? 'unknown', stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
    }
  }
}
