/** WeChat outbound Channel: text replies over the iLink bot API. */
import type { OutboundMessage } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { sendMessage, type WeixinEndpoint } from './weixin-api.ts'
import { weixinToken } from './weixin-read.ts'

/** The account the long-poll loop is connected with, for Channels that reply outside the loop; one process runs one bot. */
let active: WeixinEndpoint | undefined
export const activeWeixin = (): WeixinEndpoint | undefined => active
export const setActiveWeixin = (endpoint: WeixinEndpoint | undefined): void => { active = endpoint }
/**
 * Replies as text to the peer of the addressed message. The iLink API addresses a person rather than a message, so the
 * reply is a new message in the same chat; the remembered `context_token` is what ties it to the message it answers.
 */
export async function sendWeixin(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const peer = message.channel.address.peer
  if (!peer) throw new Error('Missing WeChat reply target')
  const endpoint = activeWeixin()
  if (!endpoint) throw new Error('The WeChat bot is not connected; the reply is retried later')
  const text = checkedImText(message.text)
  // Text that emptied out can never be delivered, so the Outbox drops it instead of retrying forever.
  if (!text.trim()) return 'gone'
  const contextToken = weixinToken(peer) ?? message.channel.address.contextToken
  await sendMessage(endpoint, { peer, text, ...contextToken ? { contextToken } : {} })
  return 'sent'
}
/** WeChat has no public link that opens a conversation, so the panel shows the message source without one. */
export const weixinLink = (_address: Record<string, string>): ChannelLink => ({ url: '', label: { zh: '微信', en: 'WeChat' } })
