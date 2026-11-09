/**
 * Downloads and decrypts WeCom message images and commits them as model-visible attachments during assessment.
 * WeCom pushes an image as an encrypted URL and its own key (`image.aeskey`) on the callback; the bytes are AES-256-CBC
 * with the key's first 16 bytes as IV, padded to a 32-byte multiple, so no file or CLI is involved.
 */
import { createDecipheriv } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type { WecomImageRef } from './wecom-trigger.ts'

/** One image read as an attachment, paired with the message and key the assessment named. */
export interface WecomAdmissionImage { source_message_id: string; image_key: string; image: ImageAttachmentRef }
/** How many padding bytes WeCom may add: it pads to 32-byte multiples, though AES works in 16-byte blocks. */
const WECOM_PADDING_MAX = 32
/** The keys `images(text)` offers: one per `[图片]` marker, in the order the text shows them. */
export const wecomImageKeys = (text: string): string[] =>
  Array.from(text.matchAll(/\[图片\]/g), (_match, index) => `img-${index + 1}`)
const IMAGE_KEY = /^img-(\d+)$/
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex')
const EXTENSIONS: Record<ImageMediaType, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
/** Identifies the image by its own bytes, because a download's content type and name are not trustworthy. */
function wecomImageType(data: Buffer): ImageMediaType | undefined {
  if (data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  const header = data.subarray(0, 6).toString('latin1')
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}
/** Decrypts one image; the ciphertext may carry up to 32 bytes of PKCS#7 padding, so it is removed by hand. */
function decryptWecomImage(encrypted: Buffer, aeskey: string): Buffer {
  const key = Buffer.from(aeskey, 'base64')
  if (key.length !== 32) throw new Error('The image aeskey is not a 32-byte AES-256 key')
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
    decipher.setAutoPadding(false)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const pad = decrypted.at(-1) ?? 0
    if (pad < 1 || pad > WECOM_PADDING_MAX || pad > decrypted.length) throw new Error('Invalid PKCS#7 padding')
    for (let index = decrypted.length - pad; index < decrypted.length; index += 1) {
      if (decrypted[index] !== pad) throw new Error('Inconsistent PKCS#7 padding')
    }
    return decrypted.subarray(0, decrypted.length - pad)
  } catch (error) {
    throw new Error(`The WeCom image could not be decrypted: ${error instanceof Error ? error.message : String(error)}`)
  }
}
/** Downloads `url` into memory, refusing anything larger than `cap` bytes rather than buffering it. */
async function download(url: string, cap: number, signal: AbortSignal): Promise<Buffer> {
  let target: URL
  try { target = new URL(url) } catch { throw new Error('The WeCom image URL is not a URL') }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('The WeCom image URL is not an HTTP(S) URL')
  let response: Response
  try { response = await fetch(target, { signal }) }
  catch (error) { signal.throwIfAborted(); throw new Error(`The WeCom image could not be downloaded: ${error instanceof Error ? error.message : String(error)}`) }
  if (!response.ok) throw new Error(`WeCom refused the image download (HTTP ${response.status}); its links expire about five minutes after the message arrived`)
  const declared = Number(response.headers.get('content-length'))
  if (declared > cap) throw new Error('The image exceeds the deployment byte limit')
  const chunks: Buffer[] = []
  let total = 0
  if (response.body) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) { await reader.cancel(); throw new Error('The image exceeds the deployment byte limit') }
      chunks.push(Buffer.from(value))
    }
  }
  return Buffer.concat(chunks)
}
/**
 * Reads one image of a message as an attachment for `agent`. `key` comes from the message text, so it names an index the
 * conversation recorded rather than an arbitrary URL; the model must accept image input, as Feishu's reads demand.
 */
export async function readWecomImage(agent: Agent, refs: readonly WecomImageRef[], key: string, messageId: string,
  signal: AbortSignal): Promise<WecomAdmissionImage> {
  const index = IMAGE_KEY.exec(key)?.[1]
  const ref = index === undefined ? undefined : refs[Number(index) - 1]
  if (!ref) throw new Error(`Choose an image key from this source message: ${messageId} has no such image`)
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  const llm = agent.ctx.get('llm')
  if (!llm || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (!info.inputModalities?.includes('image')) throw new Error(`Model ${model} does not support image input; the image has not been inspected`)
  signal.throwIfAborted()
  const limit = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  // Ciphertext is the padded plaintext, so it may exceed the limit by at most the padding itself.
  const encrypted = await download(ref.url, limit + WECOM_PADDING_MAX, signal)
  const data = ref.aeskey ? decryptWecomImage(encrypted, ref.aeskey) : encrypted
  signal.throwIfAborted()
  if (data.length === 0) throw new Error('The WeCom image is empty')
  if (data.length > limit) throw new Error('The image exceeds the deployment byte limit')
  const mediaType = wecomImageType(data)
  if (!mediaType) throw new Error('The downloaded resource is not a supported PNG/JPEG/WebP/GIF image')
  const image = await attachments.saveImage({ data, mediaType, name: `${key}${EXTENSIONS[mediaType]}` })
  signal.throwIfAborted()
  return { source_message_id: messageId, image_key: key, image }
}
