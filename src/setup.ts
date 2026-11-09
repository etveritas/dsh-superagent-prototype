/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment' | 'github' | 'feishu' | 'wecom' | 'weixin' | 'gitlab' | 'pingcode'
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the credential configuration dsh-superagent writes for github.com or the GitLab instance; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
  wecomUnset: ['wecom', 'The WeCom Source needs both the intelligent robot\'s ID and its secret from the WeCom admin console.'],
  weixinUnset: ['weixin', 'The WeChat Source needs the bot token that scanning the login code produces; log in on the Source\'s settings card in the panel.'],
  gitlabProjectUnset: ['gitlab', 'The GitLab Source names no project.'],
  gitlabCliMissing: ['gitlab', 'The agent GitLab CLI (glab) was not found.'],
  gitlabCliFailed: ['gitlab', 'The agent GitLab CLI (glab) does not work.'],
  gitlabCliSignedOut: ['gitlab', 'The agent GitLab CLI cannot read its account.'],
  gitlabCliNoAccount: ['gitlab', 'The agent GitLab CLI did not report a GitLab account.'],
  gitlabProjectUnreadable: ['gitlab', '@{account} cannot read {project}.'],
  gitlabProjectReadOnly: ['gitlab', '@{account} is not a Developer of {project}, so the agent cannot push there.'],
  pingcodeProjectUnset: ['pingcode', 'The PingCode Source names no project.'],
  pingcodeSkillMissing: ['pingcode', 'No PingCode skill directory was found (it must hold scripts/api_call.py and .env): {skill}.'],
  pingcodePythonMissing: ['pingcode', 'The python3 the PingCode skill runs on was not found.'],
  pingcodeCliFailed: ['pingcode', 'The PingCode skill could not call the API.'],
  pingcodeTokenInvalid: ['pingcode', 'The PingCode user token is missing, expired or invalid; run scripts/auth_user.py in the skill directory to authorize again.'],
  pingcodeNoAccount: ['pingcode', 'The PingCode API did not report the account of the user token.'],
  pingcodeProjectUnreadable: ['pingcode', 'The project {project} was not found; name it by project ID, identifier or name.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}
