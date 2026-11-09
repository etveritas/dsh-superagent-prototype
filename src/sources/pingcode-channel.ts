/** PingCode outbound channel: posts comments on work items under the agent account. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { workItemComments } from './pingcode-read.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** HTTP statuses that mean the work item can no longer receive a reply, as PingCode reports them in a failed call. */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 403 || error.code === 404 || error.code === 410)
/** The comment body a reply is sent as: PingCode stores comments as HTML, so the text keeps its line breaks. */
function commentHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}
/** Posts a comment with an embedded marker so a retried delivery does not create a duplicate comment. */
export async function sendPingcode(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const account = commands.deployment.pingcode
  if (!account) throw new Error('The PingCode Source has no working account')
  const address = message.channel.address
  const item = address.item ?? ''
  if (!item) throw new Error('Missing PingCode reply target')
  try {
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const comments = await workItemComments(commands, { project: address.project ?? '', item })
    const posted = comments.some(comment => comment.created_by?.id === account.id && String(comment.content ?? '').includes(marker))
    if (posted) return 'sent'
    await commands.pingcode<unknown>({ method: 'POST', path: '/v1/comments',
      body: { principal_type: 'work_item', principal_id: item, content: `${commentHtml(message.text)}\n\n${marker}` } })
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** The link to the work item a reply went to; the address carries the page PingCode reported. */
export function pingcodeLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const identifier = address.identifier ?? ''
  void links
  return { url: address.url ?? '', label: { zh: `PingCode ${identifier || '工作项'}`, en: `PingCode ${identifier || 'work item'}` } }
}
