/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { IM_WORDS } from '../src/infra/text.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { wecomKind } from '../src/sources/wecom.ts'
import { weixinKind } from '../src/sources/weixin.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

it('refuses an over-limit reply before queueing it for each IM Source, so the agent can rewrite it instead of retrying forever', () => {
  const text = Array.from({ length: IM_WORDS + 1 }, () => 'word').join(' ')
  const refuse = <C extends Record<string, unknown>>(kind: SourceKind<C>) => {
    h.runtime.sources.register(kind)
    const message: OutboundMessage = { id: `too-long-${kind.kind}`,
      channel: { source: kind.kind, thread: `${kind.kind}:chat-1`, address: { chatId: 'chat-1', peer: 'peer' } }, text, kind: 'reply' }
    expect(() => h.runtime.outbox.send(message)).toThrow(`maximum is ${IM_WORDS}`)
    // Nothing was recorded, so no receipt waits on a delivery that can never succeed.
    expect(h.runtime.outbox.status(message.id)).toBeUndefined()
  }
  refuse(wecomKind); refuse(weixinKind)
  expect(h.runtime.effects.pending('reply')).toBe(false)
})

it('drops a reply already queued before the queue-time check, instead of retrying an impossible delivery forever', async () => {
  h.runtime.sources.register(wecomKind)
  const text = Array.from({ length: IM_WORDS + 1 }, () => 'word').join(' ')
  const message: OutboundMessage = { id: 'queued-too-long',
    channel: { source: 'wecom', thread: 'wecom:chat-1', address: { chatId: 'chat-1' } }, text, kind: 'reply' }
  // A receipt an earlier version persisted, as an upgrade finds it.
  h.runtime.store.atomic(() => {
    h.runtime.store.receipts.add(message)
    h.runtime.effects.enqueue('reply', message.id, {})
  })
  await h.runtime.sendReplies()
  expect(h.runtime.store.receipts.get(message.id)).toMatchObject({ status: 'dropped', dropped: { reason: 'messageInvalid' } })
  expect(h.runtime.effects.pending('reply')).toBe(false)
})
