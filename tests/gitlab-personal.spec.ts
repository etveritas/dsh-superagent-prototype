import { expect, it, vi } from 'vitest'
import { PersonalGitLabRunner, type RunnerProcess } from '../src/infra/gitlab-runner.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import type { Ticket, Trigger } from '../src/core/model.ts'
import { PersonalGitLab, verifyGitLabIdentity } from '../src/infra/gitlab-personal.ts'

it('verifies the token against the configured GitLab user endpoint', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 7, username: 'alice' }))
  const result = await verifyGitLabIdentity('gitlab.example.com', { token: 'example-token' }, request)
  expect(result).toEqual({ userId: 7, username: 'alice', token: 'example-token' })
  expect(request).toHaveBeenCalledWith('https://gitlab.example.com/api/v4/user',
    expect.objectContaining({ redirect: 'error', headers: { 'PRIVATE-TOKEN': 'example-token' } }))
})

it('exchanges a password for a token and never forwards the password to the API', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: 'oauth-example', expires_in: 7200 }))
    .mockResolvedValueOnce(Response.json({ id: 7, username: 'alice' }))
  const result = await verifyGitLabIdentity('gitlab.example.com', { username: 'alice', password: 'example-password' }, request)
  expect(result).toMatchObject({ userId: 7, username: 'alice', token: 'oauth-example', expiresAt: expect.any(Number) })
  expect(result).not.toHaveProperty('password')
  expect(request).toHaveBeenNthCalledWith(1, 'https://gitlab.example.com/oauth/token',
    expect.objectContaining({ method: 'POST', redirect: 'error',
      body: new URLSearchParams({ grant_type: 'password', username: 'alice', password: 'example-password' }) }))
  expect(request).toHaveBeenNthCalledWith(2, 'https://gitlab.example.com/api/v4/user',
    expect.objectContaining({ headers: { Authorization: 'Bearer oauth-example' } }))
})

it('fails without echoing a rejected password or attempting shared credentials', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error_description: 'example-password' }, { status: 400 }))
  await expect(verifyGitLabIdentity('gitlab.example.com', { username: 'alice', password: 'example-password' }, request))
    .rejects.toThrow(/^GitLab password authorization failed \(HTTP 400\)$/)
  expect(request).toHaveBeenCalledOnce()
})

it('keeps project administration separate from member identity and authorizes the original sender', async () => {
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const actor = (init?.headers as Record<string, string>)['PRIVATE-TOKEN']
    if (String(url).endsWith('/user')) return Response.json({ id: actor === 'alice-token' ? 1 : 2, username: actor?.split('-')[0] })
    return Response.json({ id: 9, path_with_namespace: 'acme/example' })
  })
  const gitlab = new PersonalGitLab('gitlab.example.com', ['bob'], undefined, id => ['alice', 'bob'].includes(id), request)
  const message = (id: string, text: string): Trigger => ({
    id: id + text, source: 'wecom', human: true, actor: { source: 'wecom', id },
    addressed: 'direct', threads: [], at: new Date().toISOString(), text, meta: {},
  })
  const alice = message('alice', '绑定 GitLab alice-token')
  const bob = message('bob', '绑定 GitLab bob-token')
  await gitlab.bind(alice, { token: 'alice-token' })
  await gitlab.bind(bob, { token: 'bob-token' })
  await expect(gitlab.addProject(message('alice', '添加 GitLab 项目 acme/example'), 'acme/example')).rejects.toThrow('administrator')
  await gitlab.addProject(message('bob', '添加 GitLab 项目 acme/example'), 'acme/example')
  const origin = message('alice', '检查 GitLab 项目 acme/example')
  const followup = message('bob', '补充检查 acme/example')
  const ticket = { id: 'ticket', origin: { triggerId: origin.id, triggerIds: [origin.id] },
    inputs: [{ kind: 'trigger', triggerId: followup.id }] } as Ticket
  const tools = executorTools({
    personalGitlab: gitlab, resources: {}, github: { deployment: {} },
    store: { tickets: { get: () => ticket }, triggers: { get: (id: string) => [origin, followup].find(item => item.id === id) } },
  } as unknown as ExecutorToolsHost, ticket)
  await tools.find(tool => tool.name === 'orchestrator_gitlab_work')!.execute(
    { project: 'acme/example', operation: { kind: 'project' } }, new AbortController().signal)
  expect(request).toHaveBeenLastCalledWith('https://gitlab.example.com/api/v4/projects/9',
    expect.objectContaining({ headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'alice-token' }) }))
  request.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
  const signal = new AbortController().signal
  expect(await gitlab.archive(origin, 'acme/example', 'main', signal)).toEqual(Buffer.from([1, 2, 3]))
  expect(request).toHaveBeenLastCalledWith('https://gitlab.example.com/api/v4/projects/9/repository/archive.tar.gz?sha=main',
    expect.objectContaining({ headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'alice-token' }) }))
  await expect(gitlab.archive(followup, 'acme/other', 'main', signal)).rejects.toThrow()
  await expect(gitlab.run(origin, 'acme/other', { kind: 'project' })).rejects.toThrow()
})

it('mounts only the ticket workspace in the isolated runner and uses an image-local agent', async () => {
  const spawn = vi.fn<RunnerProcess>().mockResolvedValue({ stdout: 'done', stderr: '' })
  const runner = new PersonalGitLabRunner('example/worker:test', spawn)
  await runner.run('/tickets/example', { kind: 'codex', prompt: 'inspect the code' })
  const [binary, args, options] = spawn.mock.calls[0]!
  expect(binary).toBe('/usr/bin/docker')
  expect(args).toContain('type=bind,source=/tickets/example,target=/workspace,bind-recursive=disabled')
  expect(args).toContain('no-new-privileges')
  expect(args.slice(-9)).toEqual(['--entrypoint', 'codex', 'example/worker:test', 'exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '--', 'inspect the code'])
  expect(options.env).toEqual({ PATH: '/usr/bin:/bin' })
  await expect(runner.run('/tickets/invalid,target=/root', { kind: 'shell', command: 'true' })).rejects.toThrow()
  expect(spawn).toHaveBeenCalledOnce()
})

it('forwards the configured model credential only to delegated agents', async () => {
  const spawn = vi.fn<RunnerProcess>().mockResolvedValue({ stdout: '', stderr: '' })
  vi.stubEnv('EXAMPLE_MODEL_KEY', 'example-model-credential')
  vi.stubEnv('GITLAB_TOKEN', 'example-gitlab-credential')
  try {
    const runner = new PersonalGitLabRunner('example/worker:test', spawn, 'EXAMPLE_MODEL_KEY')
    await runner.run('/tickets/example', { kind: 'hermes', prompt: 'inspect the code' })
    await runner.run('/tickets/example', { kind: 'shell', command: 'true' })
    expect(spawn.mock.calls[0]?.[1]).toContain('EXAMPLE_MODEL_KEY')
    expect(spawn.mock.calls[0]?.[2].env).toEqual({ PATH: '/usr/bin:/bin', EXAMPLE_MODEL_KEY: 'example-model-credential' })
    expect(spawn.mock.calls[1]?.[1]).not.toContain('EXAMPLE_MODEL_KEY')
    expect(spawn.mock.calls[1]?.[2].env).toEqual({ PATH: '/usr/bin:/bin' })
  } finally { vi.unstubAllEnvs() }
})

it('answers private binding and repository requests from the current sender’s account', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ id: 7, username: 'alice' }))
    .mockResolvedValueOnce(Response.json([], { headers: { 'x-next-page': '' } }))
    .mockResolvedValueOnce(Response.json([{ id: 8, path_with_namespace: 'team/example' }], { headers: { 'x-next-page': '2' } }))
  const gitlab = new PersonalGitLab('gitlab.example.com', [], undefined, () => true, request)
  const message: Trigger = {
    id: 'binding', source: 'wecom', human: true, actor: { source: 'wecom', id: 'alice' },
    addressed: 'direct', threads: [], at: new Date().toISOString(), text: '绑定 GitLab alice-token', meta: {},
  }
  expect(gitlab.bindingStatus(message)).toEqual({ status: 'unbound' })
  await gitlab.bind(message, { token: 'alice-token' })
  const query = { ...message, id: 'query', text: '看看我账户下有哪些代码仓' }
  expect(gitlab.bindingStatus(query)).toEqual({ status: 'bound', username: 'alice' })
  await expect(gitlab.listProjects({ ...query, addressed: 'mention' }, 1)).rejects.toThrow('private')
  await expect(gitlab.listProjects({ ...query, actor: { source: 'wecom', id: 'bob' } }, 1)).rejects.toThrow('bind')
  await expect(gitlab.listProjects(query, 1)).resolves.toEqual({
    owned: [], membership: [{ path: 'team/example', registered: false }], hasMore: true,
  })
  expect(request).toHaveBeenLastCalledWith('https://gitlab.example.com/api/v4/projects?membership=true&per_page=20&page=1&order_by=id&sort=asc',
    expect.objectContaining({ headers: { 'PRIVATE-TOKEN': 'alice-token' } }))
  expect(request).toHaveBeenCalledTimes(3)
})
