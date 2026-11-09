/** Normalizes the messages the WeCom intelligent robot receives into domain Triggers, and the frames they arrive in. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'wecom'
/**
 * A callback body as the long connection pushes it. WeCom sends `create_time` in seconds; the schema keeps the number and
 * `wecomTime` accepts either unit, because the two documented forms differ between the bot APIs.
 */
const QuoteSchema = z.looseObject({ msgtype: z.string().optional(), text: z.looseObject({ content: z.string() }).optional(),
  voice: z.looseObject({ content: z.string().optional() }).optional(), mixed: z.looseObject({ msg_item: z.array(z.unknown()).default([]) }).optional() })
const MessageSchema = z.looseObject({
  msgid: z.string().min(1),
  aibotid: z.string().optional(),
  chatid: z.string().optional(),
  chattype: z.enum(['single', 'group']).default('single'),
  from: z.looseObject({ userid: z.string().min(1) }),
  create_time: z.number().optional(),
  response_url: z.string().optional(),
  msgtype: z.string(),
  text: z.looseObject({ content: z.string() }).optional(),
  voice: z.looseObject({ content: z.string().optional() }).optional(),
  image: z.looseObject({ url: z.string().optional(), aeskey: z.string().optional() }).optional(),
  file: z.looseObject({ url: z.string().optional(), aeskey: z.string().optional() }).optional(),
  video: z.looseObject({ url: z.string().optional(), aeskey: z.string().optional() }).optional(),
  mixed: z.looseObject({ msg_item: z.array(z.unknown()).default([]) }).optional(),
  quote: QuoteSchema.optional(),
})
export type WecomMessage = z.infer<typeof MessageSchema>
/** Deterministic Trigger ID for a WeCom message, so a replayed callback is a duplicate rather than new work. */
export const wecomTriggerId = (msgid: string): string => key('wecom', msgid)
/** A conversation's Thread: a group chat by `chatid`, a single chat by the other member's userid. */
export const wecomThreadId = (conversation: string): string => `${SOURCE}:${conversation}`
/** The conversation a reply goes to: the group's `chatid`, or the userid of a single chat. */
export const wecomConversation = (message: WecomMessage): string | undefined =>
  message.chattype === 'group' ? message.chatid : message.from.userid
/** Constructs the reply Channel address; both kinds of conversation are addressed by one id. */
export const wecomChannel = (conversation: string, messageId: string, direct: boolean): ChannelRef =>
  ({ source: SOURCE, thread: wecomThreadId(conversation), address: { chatId: conversation, messageId, ...direct ? { direct: 'true' } : {} } })
/** Parses a WeCom timestamp: seconds from the bot API, milliseconds where a form supplies them. */
export function wecomTime(value: number | undefined): string {
  const time = value === undefined ? Date.now() : value < 1e12 ? value * 1000 : value
  return new Date(time).toISOString()
}
/** The marker a media message shows; a mixed message's items use the same ones so its text and its images stay aligned. */
const MARKERS: Record<string, string> = { image: '[图片]', file: '[文件]', video: '[视频]', voice: '[语音]' }
const marker = (type: string | undefined): string => MARKERS[type ?? ''] ?? `[${type ?? 'unknown'}]`
/** Reads the text of a message the bot may act on; media becomes a marker, and a transcribed voice message its text. */
export function wecomText(message: WecomMessage): string {
  switch (message.msgtype) {
    case 'text': return message.text?.content ?? ''
    case 'voice': return message.voice?.content ?? marker('voice')
    case 'mixed': return message.mixed?.msg_item.map(item => {
      const entry = item as { msgtype?: string; text?: { content?: string } }
      // Only an image item becomes the marker `wecomImages` has a reference for; anything else keeps its own marker.
      return entry.msgtype === 'text' ? entry.text?.content ?? '' : marker(entry.msgtype)
    }).filter(text => text.length > 0).join('\n') ?? ''
    case 'image': return marker('image')
    case 'file': return marker('file')
    case 'video': return marker('video')
    default: return `[${message.msgtype}]`
  }
}
/** One image a callback carries: the encrypted download URL and the AES key that decrypts it. */
export interface WecomImageRef { url: string; aeskey?: string }
const imageRef = (image: { url?: string; aeskey?: string } | undefined): WecomImageRef | undefined =>
  image?.url ? { url: image.url, ...(image.aeskey ? { aeskey: image.aeskey } : {}) } : undefined
/** The images a message carries, in the order its text shows them as `[图片]`. */
export function wecomImages(input: unknown): WecomImageRef[] {
  const parsed = MessageSchema.safeParse(input)
  if (!parsed.success) return []
  const message = parsed.data
  const images: WecomImageRef[] = []
  const add = (image: { url?: string; aeskey?: string } | undefined): void => {
    const ref = imageRef(image)
    if (ref) images.push(ref)
  }
  if (message.msgtype === 'image') add(message.image)
  if (message.msgtype === 'mixed') for (const item of message.mixed?.msg_item ?? []) {
    const entry = item as { msgtype?: string; image?: { url?: string; aeskey?: string } }
    if (entry.msgtype === 'image') add(entry.image)
  }
  return images
}
/** The quoted message's text, when the sender answered one; WeCom sends the content without the quoted message's id. */
export function wecomQuote(quote: WecomMessage['quote']): string | undefined {
  if (!quote) return undefined
  if (quote.text?.content) return quote.text.content
  if (quote.voice?.content) return quote.voice.content
  if (quote.msgtype === 'image') return '[图片]'
  return undefined
}
/** Converts a callback body into a Trigger, returning undefined for the bot's own messages and for anything unreadable. */
export function wecomTrigger(input: unknown, botId: string): Trigger | undefined {
  const parsed = MessageSchema.safeParse(input)
  if (!parsed.success) return undefined
  const message = parsed.data
  // `aibotid` is the receiving bot's own id on every callback, so only the sender can identify the bot's own messages.
  if (message.from.userid === botId) return undefined
  const conversation = wecomConversation(message)
  if (!conversation) return undefined
  const direct = message.chattype === 'single'
  const quote = wecomQuote(message.quote)
  return { id: wecomTriggerId(message.msgid), source: SOURCE, threads: [{ source: SOURCE, id: wecomThreadId(conversation) }],
    actor: { source: SOURCE, id: message.from.userid }, human: true,
    // The robot only receives what addresses it: a single chat is direct, and a group message is a mention.
    addressed: direct ? 'direct' as const : 'mention' as const,
    at: wecomTime(message.create_time), text: wecomText(message), channel: wecomChannel(conversation, message.msgid, direct),
    meta: { chatId: conversation, messageId: message.msgid, chattype: message.chattype, direct, ...(quote ? { quote } : {}) } }
}
/** The conversation a Trigger belongs to, for reads and for the Executor's environment. */
export const wecomChat = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : undefined
