/** WeCom outbound Channel: markdown replies over the bot's long connection. */
import type { OutboundMessage } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { activeWecom, WecomAckError } from './wecom-ws.ts'

/** WeCom accepts at most 20480 bytes of markdown per message. */
export const WECOM_MARKDOWN_MAX_BYTES = 20_480
/**
 * WeCom error codes that mean the conversation can never accept this message, so the Outbox stops instead of retrying.
 * Every other code is retried: guessing wrong here would drop a reply a person waits for.
 */
const goneCodes = new Set([86003])
/** Truncates markdown to WeCom's byte limit, keeping the ellipsis inside it. */
export function truncateWecom(text: string): string {
  if (Buffer.byteLength(text) <= WECOM_MARKDOWN_MAX_BYTES) return text
  let kept = ''
  for (const character of text) {
    if (Buffer.byteLength(kept + character) > WECOM_MARKDOWN_MAX_BYTES - 3) break
    kept += character
  }
  return `${kept}…`
}
/** A WeCom markdown message body, the form both replies and proactive sends use. */
export const wecomMarkdown = (text: string): Record<string, unknown> => ({ msgtype: 'markdown', markdown: { content: truncateWecom(text) } })
/**
 * Replies into the conversation of the addressed message. WeCom sends by conversation rather than by message: the reply is
 * a new message in the same chat, which is also why it can be produced minutes after the Trigger arrived.
 */
export async function sendWecom(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const chatId = message.channel.address.chatId
  if (!chatId) throw new Error('Missing WeCom reply target')
  const connection = activeWecom()
  if (!connection || !connection.isAuthenticated) throw new Error('The WeCom long connection is not open; the reply is retried later')
  const text = truncateWecom(checkedImText(message.text))
  try { await connection.send(chatId, wecomMarkdown(text)) }
  catch (error) {
    if (error instanceof WecomAckError && goneCodes.has(error.code)) return 'gone'
    throw error
  }
  return 'sent'
}
/** WeCom has no public link that opens a conversation, so the panel shows the message source without one. */
export const wecomLink = (): ChannelLink => ({ url: '', label: { zh: '企业微信', en: 'WeCom' } })
