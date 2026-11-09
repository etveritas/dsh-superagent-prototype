/** GitLab outbound channel: posts issue and merge request conversation notes under the agent account. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { notePageDesc } from './gitlab-read.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gitlabPage, type GitlabTarget } from './gitlab-trigger.ts'

/** True when the conversation can no longer receive a reply: it was deleted, or the account lost access to it. */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 403 || error.code === 404 || error.code === 410)
/** Posts a note with an embedded HTML marker so a retried delivery does not create a duplicate comment. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const account = commands.deployment.gitlab
  if (!account) throw new Error('The GitLab Source has no working CLI')
  const address = message.channel.address
  const project = address.project ?? ''
  const iid = Number(address.iid)
  const target: GitlabTarget = address.target === 'mergeRequest' ? 'mergeRequest' : 'issue'
  if (!project || !iid) throw new Error('Missing GitLab reply target')
  const collection = target === 'issue' ? 'issues' : 'merge_requests'
  try {
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const notes = await notePageDesc(commands, { project, iid, target }, 1)
    if (notes.some(note => sameName(note.author.username, account.login) && (note.body ?? '').includes(marker))) return 'sent'
    // `-f` sends a JSON field, which is what the notes endpoint and other GitLab write endpoints take.
    await commands.gitlabApi(project, `${collection}/${iid}/notes`, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const iid = Number(address.iid)
  const target: GitlabTarget = address.target === 'mergeRequest' ? 'mergeRequest' : 'issue'
  const host = links.gitlab?.host ?? ''
  const project = address.project ?? ''
  return { url: address.url ?? (host && project && iid ? gitlabPage(host, project, target, iid) : ''),
    label: target === 'mergeRequest' ? { zh: `GitLab !${iid}`, en: `GitLab !${iid}` } : { zh: `GitLab #${iid}`, en: `GitLab #${iid}` } }
}
/** Only a project the Source still watches may receive its replies. */
export const gitlabAllows = (address: Record<string, string>, config: { projects: { path: string }[] }): boolean =>
  config.projects.some(project => sameName(project.path, address.project ?? ''))
