/** Validates personal GitLab credentials against the configured HTTPS instance. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Trigger } from '../core/model.ts'
import { z } from 'zod'

export type GitLabCredential = { token: string } | { username: string; password: string }
export interface GitLabIdentity {
  userId: number
  username: string
  token: string
  expiresAt?: number
  bearer?: true
}
const Account = z.object({ id: z.number().int().positive(), username: z.string().min(1) })
const PasswordGrant = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().optional() })

export async function verifyGitLabIdentity(host: string, credential: GitLabCredential, request: typeof fetch = fetch): Promise<GitLabIdentity> {
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) throw new Error('Invalid configured GitLab host')
  const origin = new URL(`https://${host}`).origin
  const send = async (path: string, label: string, init: RequestInit): Promise<unknown> => {
    let response: Response
    try { response = await request(origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }) }
    catch { throw new Error(`${label} could not reach the configured GitLab instance`) }
    if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status})`)
    try { return await response.json() } catch { throw new Error(`${label} returned invalid JSON`) }
  }
  const grant = 'token' in credential ? undefined : PasswordGrant.safeParse(await send('/oauth/token', 'GitLab password authorization', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'password', username: credential.username, password: credential.password }),
  }))
  if (grant && !grant.success) throw new Error('GitLab did not return a usable access token')
  const token = 'token' in credential ? credential.token : grant?.data?.access_token
  if (!token || /[\r\n]/.test(token)) throw new Error('Invalid GitLab access token')
  const account = Account.safeParse(await send('/api/v4/user', 'GitLab identity verification', {
    headers: grant ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token },
  }))
  if (!account.success) throw new Error('GitLab did not return a valid account')
  const expiresIn = grant?.data?.expires_in
  return { userId: account.data.id, username: account.data.username, token, ...grant ? { bearer: true as const } : {},
    ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}) }
}

const containsProject = (text: string, path: string, origin: string): boolean =>
  (text.toLowerCase().match(/https?:\/\/[a-z0-9_./:-]+|[a-z0-9_./-]+/g) ?? []).some(value => {
    const normalized = value.split('/-/')[0]!.replace(/\/$/, '').replace(/\.git$/, '')
    return normalized === path.toLowerCase() || normalized === origin.toLowerCase() + '/' + path.toLowerCase()
  })

const pathPart = z.string().min(1).max(500).refine(value => !value.split('/').some(part => !part || part === '.' || part === '..'))
const ref = z.string().min(1).max(250)
const iid = z.number().int().positive().safe()
export const GitLabOperation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z.object({ kind: z.literal('issue'), iid }).strict(),
  z.object({ kind: z.literal('merge_request'), iid }).strict(),
  z.object({ kind: z.literal('diffs'), iid, page: iid.default(1) }).strict(),
  z.object({ kind: z.literal('file'), path: pathPart, ref }).strict(),
  z.object({ kind: z.literal('create_issue'), title: z.string().min(1).max(255), description: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal('commit'), branch: ref, start_branch: ref, message: z.string().min(1).max(1000),
    actions: z.array(z.object({ action: z.enum(['create', 'update', 'delete']), file_path: pathPart,
      content: z.string().max(100_000).optional(), last_commit_id: z.string().optional() }).strict()).min(1).max(10) }).strict(),
  z.object({ kind: z.literal('create_merge_request'), source_branch: ref, target_branch: ref,
    title: z.string().min(1).max(255), description: z.string().max(20_000) }).strict(),
])

const Identity = Account.pick({ username: true }).extend({ userId: z.number().int().positive(), token: z.string().min(1),
  expiresAt: z.number().optional(), bearer: z.literal(true).optional() })
const Project = z.object({ id: z.number().int().positive().safe(), path_with_namespace: z.string() })
const State = z.object({ host: z.string(), accounts: z.record(z.string(), Identity),
  projects: z.record(z.string(), z.number().int().positive().safe()), used: z.record(z.string(), z.number()) })
type State = z.infer<typeof State>

/** Broker for project-scoped GitLab operations using each WeCom sender’s verified identity. */
export class PersonalGitLab {
  private readonly origin: string
  private state: State
  private readonly pending = new Set<string>()

  constructor(private readonly host: string, private readonly admins: readonly string[], private readonly file: string | undefined,
    private readonly allowed: (id: string) => boolean, private readonly request: typeof fetch = fetch) {
    if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) throw new Error('Invalid configured GitLab host')
    this.origin = new URL(`https://${host}`).origin
    this.state = { host: this.origin, accounts: {}, projects: {}, used: {} }
    if (file) {
      try { this.state = State.parse(JSON.parse(readFileSync(file, 'utf8'))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not load personal GitLab state') }
      if (this.state.host !== this.origin) throw new Error('Personal GitLab state belongs to a different GitLab instance')
    }
  }

  private actor(trigger: Trigger | undefined): string {
    if (trigger?.source !== 'wecom' || trigger.actor.source !== 'wecom' || !trigger.human ||
      !trigger.addressed || !this.allowed(trigger.actor.id)) throw new Error('An allowed WeCom sender must request this action')
    return trigger.actor.id
  }

  private identity(actor: string): GitLabIdentity {
    const identity = Object.hasOwn(this.state.accounts, actor) ? this.state.accounts[actor] : undefined
    if (!identity || (identity.expiresAt !== undefined && identity.expiresAt <= Date.now())) {
      throw new Error('The originating WeCom user must bind or renew their personal GitLab account in a direct message')
    }
    return identity
  }

  private async change<T>(trigger: Trigger, run: () => Promise<{ result: T; update: Partial<State> }>): Promise<T> {
    const at = Date.parse(trigger.at)
    const now = Date.now()
    if (!(at >= now - 15 * 60_000 && at <= now + 60_000) || Object.hasOwn(this.state.used, trigger.id) || this.pending.has(trigger.id)) {
      throw new Error('Use a new WeCom message to request this change')
    }
    this.pending.add(trigger.id)
    try {
      const { result, update } = await run()
      const used = Object.fromEntries(Object.entries(this.state.used).filter(([, time]) => time >= now - 15 * 60_000))
      const state = { ...this.state, ...update, used: { ...used, [trigger.id]: at } }
      if (this.file) {
        const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}`
        writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, this.file)
      }
      this.state = state
      return result
    } finally { this.pending.delete(trigger.id) }
  }

  async bind(trigger: Trigger, credential: GitLabCredential) {
    const actor = this.actor(trigger)
    if (trigger.addressed !== 'direct') throw new Error('Bind a GitLab account in a direct message')
    const fields = 'token' in credential ? [credential.token] : [credential.username, credential.password]
    if (!fields.every(value => value && trigger.text.includes(value))) throw new Error('Use credentials supplied in the binding message')
    return this.change(trigger, async () => {
      const identity = await verifyGitLabIdentity(this.host, credential, this.request)
      return { result: { username: identity.username }, update: { accounts: { ...this.state.accounts, [actor]: identity } } }
    })
  }

  private project(input: string): string {
    const url = input.startsWith('https://') ? new URL(input) : undefined
    if (url && (url.origin !== this.origin || url.username || url.password || url.search || url.hash)) {
      throw new Error('Use a project from the configured GitLab instance')
    }
    const path = (url ? url.pathname.slice(1) : input).replace(/\/$/, '').replace(/\.git$/, '')
    if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(path) || path.split('/').some(part => part === '.' || part === '..' || part === '-')) {
      throw new Error('Use a GitLab namespace/project path or its HTTPS URL')
    }
    return path
  }

  async addProject(trigger: Trigger, input: string) {
    const actor = this.actor(trigger)
    if (!this.admins.includes(actor)) throw new Error('Only a configured WeCom administrator can add GitLab projects')
    const path = this.project(input)
    if (!containsProject(trigger.text, path, this.origin)) throw new Error('The project must appear in the administrator’s request')
    return this.change(trigger, async () => {
      const project = Project.parse(await this.api(this.identity(actor), '/projects/' + encodeURIComponent(path)))
      const projects = { ...this.state.projects, [project.path_with_namespace.toLowerCase()]: project.id }
      return { result: { project: project.path_with_namespace }, update: { projects } }
    })
  }

  async run(origin: Trigger | undefined, input: string, operation: z.infer<typeof GitLabOperation>, signal?: AbortSignal) {
    const identity = this.identity(this.actor(origin))
    const path = this.project(input).toLowerCase()
    const id = this.state.projects[path]
    if (!id || !origin || !containsProject(origin.text, path, this.origin)) {
      throw new Error('The initial request must name a registered GitLab project')
    }
    const base = '/projects/' + id
    switch (operation.kind) {
      case 'project': return this.api(identity, base, undefined, signal)
      case 'issue': return this.api(identity, `${base}/issues/${operation.iid}`, undefined, signal)
      case 'merge_request': return this.api(identity, `${base}/merge_requests/${operation.iid}`, undefined, signal)
      case 'diffs': return this.api(identity, `${base}/merge_requests/${operation.iid}/diffs?per_page=10&page=${operation.page}`, undefined, signal)
      case 'file': return this.api(identity, `${base}/repository/files/${encodeURIComponent(operation.path)}?ref=${encodeURIComponent(operation.ref)}`, undefined, signal)
      case 'create_issue': return this.api(identity, base + '/issues', { title: operation.title, description: operation.description }, signal)
      case 'commit': {
        const { branch, start_branch, message, actions } = operation
        return this.api(identity, base + '/repository/commits', { branch, start_branch, commit_message: message, actions }, signal)
      }
      case 'create_merge_request': {
        const { title, description, source_branch, target_branch } = operation
        return this.api(identity, base + '/merge_requests', { title, description, source_branch, target_branch }, signal)
      }
    }
  }

  private async api(identity: GitLabIdentity, path: string, body?: object, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = identity.bearer
      ? { Authorization: `Bearer ${identity.token}` } : { 'PRIVATE-TOKEN': identity.token }
    if (body) headers['Content-Type'] = 'application/json'
    const timeout = AbortSignal.timeout(15_000)
    let response: Response
    try {
      response = await this.request(this.origin + '/api/v4' + path, { headers, redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
    } catch { throw new Error('Could not reach the configured GitLab instance') }
    if (!response.ok) throw new Error(`GitLab request failed (HTTP ${response.status})`)
    return response.json()
  }
}
