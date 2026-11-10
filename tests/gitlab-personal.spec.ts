import { expect, it, vi } from 'vitest'
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
  await expect(gitlab.run(origin, 'acme/other', { kind: 'project' })).rejects.toThrow()
})
