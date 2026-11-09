/** Normalizes the messages the WeChat iLink bot receives into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'weixin'
/**
 * A wire number, which the documented iLink examples write as either a number or a decimal string depending on the field;
 * the helpers below read both so one malformed scalar cannot drop a person's message.
 */
const ScalarSchema = z.union([z.number(), z.string()])
/** The parts of one `MessageItem` this Source reads; every other item shape (tool calls, videos) only needs its `type`. */
const itemShape = {
  type: ScalarSchema.optional(),
  msg_id: ScalarSchema.optional(),
  text_item: z.looseObject({ text: z.string().optional() }).optional(),
  voice_item: z.looseObject({ text: z.string().optional() }).optional(),
  file_item: z.looseObject({ file_name: z.string().optional() }).optional(),
}
const QuotedSchema = z.looseObject(itemShape)
const ItemSchema = z.looseObject({ ...itemShape,
  ref_msg: z.looseObject({ message_item: QuotedSchema.optional(), svr_id: ScalarSchema.optional() }).optional() })
/**
 * A `WeixinMessage` as `getUpdates` returns it. Only the sender and an identity are demanded by `weixinTrigger`, so media
 * and partial states still parse; unknown keys are kept away from the reader rather than rejected.
 */
export const WeixinMessageSchema = z.looseObject({
  message_id: ScalarSchema.optional(),
  from_user_id: z.string().default(''),
  to_user_id: z.string().optional(),
  client_id: z.string().optional(),
  create_time_ms: ScalarSchema.optional(),
  update_time_ms: ScalarSchema.optional(),
  session_id: z.string().optional(),
  group_id: z.string().optional(),
  message_type: ScalarSchema.optional(),
  message_state: ScalarSchema.optional(),
  item_list: z.array(ItemSchema).default([]),
  context_token: z.string().optional(),
  seq: ScalarSchema.optional(),
})
export type WeixinMessage = z.infer<typeof WeixinMessageSchema>
/** Reads a wire number that may arrive as a numeric string; an unreadable value is treated as absent. */
const numberOf = (value: number | string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
/** The placeholder for an item the agent cannot read; an unknown item type still shows that something arrived. */
const itemMarker = (type: number | undefined): string => {
  switch (type) {
    case 2: return '[图片]'
    case 3: return '[语音]'
    case 4: return '[文件]'
    case 5: return '[视频]'
    default: return '[消息]'
  }
}
/** Deterministic Trigger ID for a WeChat message, so a replayed long-poll round is a duplicate rather than new work. */
export const weixinTriggerId = (id: string): string => key(SOURCE, id)
/** A direct chat's Thread; this backend only delivers direct chats, so the peer identifies it. */
export const weixinThreadId = (peer: string): string => `${SOURCE}:${peer}`
/** The message's own id, or the id its first item carries when the envelope has none. */
export const weixinMessageId = (message: WeixinMessage): string | undefined => {
  const own = message.message_id === undefined ? '' : String(message.message_id)
  if (own) return own
  const item = message.item_list.find(entry => entry.msg_id !== undefined)
  return item?.msg_id === undefined ? undefined : String(item.msg_id)
}
/** Constructs the reply Channel address; the `context_token` is echoed by the reply, so it is part of the address when present. */
export function weixinChannel(peer: string, messageId: string, contextToken?: string): ChannelRef {
  return { source: SOURCE, thread: weixinThreadId(peer), address: { peer, messageId, ...contextToken ? { contextToken } : {} } }
}
/** The text of a message: the first text item, else a voice transcription, else a marker for the media it carries. */
export function weixinText(message: WeixinMessage): string {
  const text = message.item_list.find(item => numberOf(item.type) === 1 && item.text_item?.text)?.text_item?.text
  if (text) return text
  const transcription = message.item_list.find(item => numberOf(item.type) === 3 && item.voice_item?.text)?.voice_item?.text
  if (transcription) return transcription
  // Nothing readable: the first item says what kind of message arrived, the way the panel shows it.
  return itemMarker(numberOf(message.item_list[0]?.type))
}
/** The quoted message's text, when the sender answered one; the quote is nested in the message's own items. */
export function weixinQuote(message: WeixinMessage): string | undefined {
  const ref = message.item_list.find(item => item.ref_msg)?.ref_msg
  if (!ref?.message_item) return undefined
  const quoted = ref.message_item
  return quoted.text_item?.text || quoted.voice_item?.text || itemMarker(numberOf(quoted.type))
}
/** Parses a WeChat timestamp in milliseconds; a missing or unreadable one falls back to now, matching the other Sources. */
export function weixinTime(message: WeixinMessage): string {
  const ms = numberOf(message.create_time_ms)
  return new Date(ms === undefined ? Date.now() : ms).toISOString()
}
/** Converts a polled message into a Trigger, returning undefined for the bot's own, partial, and unreadable messages. */
export function weixinTrigger(input: unknown): Trigger | undefined {
  const parsed = WeixinMessageSchema.safeParse(input)
  if (!parsed.success) return undefined
  const message = parsed.data
  // message_type 2 is the bot's own reply; a GENERATING update is not the finished message the Trigger must store.
  if (numberOf(message.message_type) === 2) return undefined
  if (numberOf(message.message_state) === 1) return undefined
  if (!message.from_user_id) return undefined
  const messageId = weixinMessageId(message)
  if (!messageId) return undefined
  const peer = message.from_user_id
  const contextToken = message.context_token
  const quote = weixinQuote(message)
  return { id: weixinTriggerId(messageId), source: SOURCE, threads: [{ source: SOURCE, id: weixinThreadId(peer) }],
    actor: { source: SOURCE, id: peer }, human: true,
    // The iLink bot receives direct chats only, so everything it delivers is addressed to the bot.
    addressed: 'direct',
    at: weixinTime(message), text: weixinText(message), channel: weixinChannel(peer, messageId, contextToken),
    meta: { peer, messageId, direct: true, ...(contextToken ? { contextToken } : {}), ...(quote ? { quote } : {}), ...(message.group_id ? { groupId: message.group_id } : {}) } }
}
/** The peer a Trigger belongs to, for reads and for the Executor's environment. */
export const weixinPeer = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.peer === 'string' ? trigger.meta.peer : undefined
