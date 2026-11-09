import { createCipheriv, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { readWecomImage, wecomImageKeys } from '../src/sources/wecom-image.ts'
import { forgetWecom, rememberWecom, wecomThreadContext } from '../src/sources/wecom-read.ts'
import { wecomImages, wecomTrigger } from '../src/sources/wecom-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** The first bytes of a PNG, enough for the read to identify the decrypted payload without decoding it. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
const key = randomBytes(32)
const aeskey = key.toString('base64')
const message = (over: Record<string, unknown> = {}) => ({ msgid: 'm-1', chattype: 'single', from: { userid: 'user-1' }, msgtype: 'image',
  image: { url: 'http://placeholder', aeskey }, create_time: 1_767_225_600, ...over })
/** Encrypts like WeCom does: AES-256-CBC with the key's first 16 bytes as IV and padding to a 32-byte multiple. */
const encrypt = (bytes: Buffer): Buffer => {
  const padding = 32 - (bytes.length % 32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(Buffer.concat([bytes, Buffer.alloc(padding, padding)])), cipher.final()])
}

let server: Server
let requests = 0
let status = 200
let payload = encrypt(PNG)
let saveImage: ReturnType<typeof vi.fn>
let resolveModelInfo: ReturnType<typeof vi.fn>
let agent: Agent
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
const ref = { attachmentId: 'image-id', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
const signal = () => new AbortController().signal
beforeEach(async () => {
  requests = 0
  status = 200
  payload = encrypt(PNG)
  saveImage = vi.fn().mockResolvedValue(ref)
  resolveModelInfo = vi.fn().mockResolvedValue({ inputModalities: ['text', 'image'] })
  const ctx = new Context()
  ctx.reflect.provide('attachments', { saveImage, imageLimits: { maxImageBytes: 100, maxMessageImageBytes: 100 } })
  ctx.reflect.provide('llm', { resolveModelInfo })
  agent = { ctx, session: { requestHeader: () => ({ config: { provider: 'chosen-provider', model: 'chosen-model' } }) }, options: {} } as unknown as Agent
  server = createServer((_request, response) => { requests += 1; response.writeHead(status); response.end(payload) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
})
afterEach(async () => {
  forgetWecom()
  vi.restoreAllMocks()
  await new Promise<void>(done => server.close(() => done()))
})
const url = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}/image`

it('finds one image key per marker, in the order the message text shows them', () => {
  expect(wecomImageKeys('look at this [图片]')).toEqual(['img-1'])
  expect(wecomImageKeys('[图片]\n[图片]')).toEqual(['img-1', 'img-2'])
  expect(wecomImageKeys('no image here')).toEqual([])
})

it('keeps a message\'s images in the order its markers appear, alone and in a mixed message', () => {
  expect(wecomImages(message())).toEqual([{ url: 'http://placeholder', aeskey }])
  const mixed = message({ msgtype: 'mixed', image: undefined,
    mixed: { msg_item: [{ msgtype: 'text', text: { content: 'first' } },
      { msgtype: 'image', image: { url: 'http://first', aeskey } }, { msgtype: 'image', image: { url: 'http://second' } }] } })
  expect(wecomImages(mixed)).toEqual([{ url: 'http://first', aeskey }, { url: 'http://second' }])
  expect(wecomImages({ msgid: '', msgtype: 'text' })).toEqual([])
})

it('downloads, decrypts and commits an image as an attachment for the assessing Session', async () => {
  const refs = wecomImages(message({ image: { url: url(), aeskey } }))
  const result = await readWecomImage(agent, refs, 'img-1', 'm-1', signal())
  expect(result).toEqual({ source_message_id: 'm-1', image_key: 'img-1', image: ref })
  expect(resolveModelInfo).toHaveBeenCalledWith('chosen-provider', 'chosen-model', expect.any(AbortSignal))
  expect(saveImage).toHaveBeenCalledWith({ data: PNG, mediaType: 'image/png', name: 'img-1.png' })
  expect(requests).toBe(1)
})

it('reads the image of a message its conversation remembers, through the WeCom thread context', async () => {
  rememberWecom('user-1', { id: 'm-1', from: 'user-1', at: '2026-01-01T00:00:00.000Z', text: '[图片]',
    images: wecomImages(message({ image: { url: url(), aeskey } })) })
  const trigger = wecomTrigger(message({ image: { url: url(), aeskey } }), 'bot-1')!
  const result = await wecomThreadContext.image!(agent, commands, trigger, { id: 'm-1', text: '[图片]' }, 'img-1', tmpdir(), signal())
  expect(result).toMatchObject({ source_message_id: 'm-1', image_key: 'img-1', image: ref })
})

it('refuses a key the message does not carry, and a model that cannot see images', async () => {
  const refs = wecomImages(message({ image: { url: url(), aeskey } }))
  await expect(readWecomImage(agent, refs, 'img-2', 'm-1', signal())).rejects.toThrow('no such image')
  resolveModelInfo.mockResolvedValue({ inputModalities: ['text'] })
  await expect(readWecomImage(agent, refs, 'img-1', 'm-1', signal())).rejects.toThrow('does not support image')
  expect(requests).toBe(0)
  expect(saveImage).not.toHaveBeenCalled()
})

it('refuses bytes that are not an image, and one over the deployment byte limit', async () => {
  payload = encrypt(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
  const refs = wecomImages(message({ image: { url: url(), aeskey } }))
  await expect(readWecomImage(agent, refs, 'img-1', 'm-1', signal())).rejects.toThrow('supported')
  payload = encrypt(Buffer.concat([PNG, Buffer.alloc(200)]))
  await expect(readWecomImage(agent, refs, 'img-1', 'm-1', signal())).rejects.toThrow('byte limit')
  status = 403
  await expect(readWecomImage(agent, refs, 'img-1', 'm-1', signal())).rejects.toThrow('expire about five minutes')
  expect(saveImage).not.toHaveBeenCalled()
})
