/**
 * WeChat context reader for assessments. The iLink long poll delivers messages but keeps no readable history, so the Source
 * remembers the recent messages of each peer it received and reads them back here; nothing is fetched from WeChat.
 */
import type { WeixinAccount } from '../deployment.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** How many recent messages of one peer an assessment may read. */
export const WEIXIN_RECENT_MESSAGES = 50
/** How many peers and context tokens are remembered; the least recently written one is dropped past this. */
export const WEIXIN_REMEMBERED_CHATS = 200
/** One received message as the reader shows it. */
export interface WeixinStored { id: string; from: string; at: string; text: string }
const recent = new Map<string, WeixinStored[]>()
const tokens = new Map<string, string>()
/** Drops the least recently written entry of a bounded map once it is full. */
function trim<V>(map: Map<string, V>): void {
  while (map.size > WEIXIN_REMEMBERED_CHATS) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
/** Records a received message for later reads; the same message id is never stored twice. */
export function rememberWeixin(peer: string, message: WeixinStored): void {
  const messages = recent.get(peer) ?? []
  if (!messages.some(item => item.id === message.id)) messages.push(message)
  recent.delete(peer)
  recent.set(peer, messages.slice(-WEIXIN_RECENT_MESSAGES))
  trim(recent)
}
/** The remembered messages of one peer, oldest first. */
export const weixinTranscript = (peer: string): WeixinStored[] => [...(recent.get(peer) ?? [])]
/** Records the latest `context_token` of a peer; the next reply to it echoes that token. */
export function rememberToken(peer: string, token: string): void {
  tokens.delete(peer)
  tokens.set(peer, token)
  trim(tokens)
}
/** The latest `context_token` of a peer, if one was received. */
export const weixinToken = (peer: string): string | undefined => tokens.get(peer)
/** Drops everything remembered, the windows and the tokens alike; the Source's disposal and tests use it. */
export const forgetWeixin = (): void => { recent.clear(); tokens.clear() }
/**
 * Reads the Trigger's peer instead of WeChat: `thread` is the remembered window, `root` its first message, and `parent` the
 * message the Trigger answered when the quoted text was received. There is no pagination and no image read.
 */
export const weixinThreadContext: ThreadContext<WeixinAccount> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (_commands, trigger, part, _cursor) => {
    const peer = typeof trigger.meta.peer === 'string' ? trigger.meta.peer : ''
    const messages: ContextMessage[] = weixinTranscript(peer).map(item => ({ id: item.id, from: item.from, at: item.at, text: item.text }))
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
}
