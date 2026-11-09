/**
 * WeCom context reader for assessments. The long connection delivers messages but keeps no history, so the Source remembers
 * the recent messages of each conversation it received, with the images they carried, and reads them back here; the text
 * is never fetched from WeCom, and only an image is, from the encrypted URL its message came with.
 */
import { readWecomImage, wecomImageKeys } from './wecom-image.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import type { WecomConfig } from './wecom.ts'
import type { WecomImageRef } from './wecom-trigger.ts'

/** How many recent messages of one conversation an assessment may read. */
export const WECOM_RECENT_MESSAGES = 50
/** How many conversations are remembered; the least recently written one is dropped past this. */
export const WECOM_REMEMBERED_CHATS = 200
/** One received message as the reader shows it. */
export interface WecomStored { id: string; from: string; at: string; text: string; images?: WecomImageRef[] }
const recent = new Map<string, WecomStored[]>()
/** Records a received message for later reads; the same message id is never stored twice. */
export function rememberWecom(chatId: string, message: WecomStored): void {
  const messages = recent.get(chatId) ?? []
  if (!messages.some(item => item.id === message.id)) messages.push(message)
  recent.delete(chatId)
  recent.set(chatId, messages.slice(-WECOM_RECENT_MESSAGES))
  while (recent.size > WECOM_REMEMBERED_CHATS) {
    const oldest = recent.keys().next().value
    if (oldest === undefined) break
    recent.delete(oldest)
  }
}
/** The remembered messages of one conversation, oldest first. */
export const wecomTranscript = (chatId: string): WecomStored[] => [...(recent.get(chatId) ?? [])]
/** Drops everything remembered; the Source's disposal and tests use it. */
export const forgetWecom = (): void => { recent.clear() }
/**
 * Reads the Trigger's conversation instead of WeCom: `thread` is the remembered window, `root` its first message, and
 * `parent` the message the Trigger answered when WeCom supplied it. There is no pagination; an image is read from the
 * encrypted URL the conversation remembered, through the key its text offers.
 */
export const wecomThreadContext: ThreadContext<WecomConfig> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (_commands, trigger, part, _cursor) => {
    const chatId = typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : ''
    const messages: ContextMessage[] = wecomTranscript(chatId).map(item => ({ id: item.id, from: item.from, at: item.at, text: item.text }))
    if (part === 'thread') return { messages, body: { status: 'available', messages }, status: 'available' }
    if (part === 'root') {
      const first = messages[0]
      return first ? { messages: [first], body: { status: 'available', messages: [first] }, status: 'available' }
        : { messages: [], body: { status: 'no_root', messages: [] }, status: 'no_root' }
    }
    const quote = typeof trigger.meta.quote === 'string' ? trigger.meta.quote : undefined
    if (!quote) return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
    const quoted: ContextMessage = { id: `${String(trigger.meta.messageId ?? trigger.id)}:quote`, from: 'quoted message', at: trigger.at, text: quote }
    return { messages: [quoted], body: { status: 'available', messages: [quoted] }, status: 'available' }
  },
  images: wecomImageKeys,
  image: async (agent, _commands, trigger, message, key, _stateDir, signal) => {
    const chatId = typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : ''
    const images = wecomTranscript(chatId).find(stored => stored.id === message.id)?.images ?? []
    return readWecomImage(agent, images, key, message.id, signal)
  },
}
