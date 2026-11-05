/** Weixin (iLink Bot) Source kind and Cordis plugin entry: the official bot for a personal WeChat account. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sourceContext, type SourceHost } from './host.ts'
import type { ChannelLink, ChannelLinks, SourceKind } from './kind.ts'
import { WEIXIN_HEALTH, WEIXIN_POLL, WeixinBot } from './weixin-bot.ts'
import { WeixinConfigSchema, type WeixinConfig } from './weixin-config.ts'
import { weixinThreadContext } from './weixin-read.ts'
import { DIRECT_ROW, SOURCE } from './weixin-trigger.ts'

/** The Source's Policy part: the wxids that may originate work, empty until a person is added. */
const WeixinPolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).default([]),
}).strict()
/** A Weixin direct chat has no page outside the host, so its link carries only the label. */
export const weixinLink = (_address: Record<string, string>, _links: ChannelLinks): ChannelLink =>
  ({ url: '', label: { zh: '微信', en: 'WeChat' } })

/**
 * Builds the Weixin kind for `bot`. The bot is the Source's runtime: it performs the first scan login, long-polls
 * `getUpdates`, and sends replies through `sendMessage`; the kind only declares its configuration, scope, channel and
 * policy. No network call happens while the panel reads the kind.
 */
export function weixinKind(bot: WeixinBot): SourceKind<WeixinConfig> {
  const kind: SourceKind<WeixinConfig> = {
    kind: SOURCE,
    title: { zh: '微信（iLink Bot）', en: 'WeChat (iLink Bot)' },
    description: { zh: '接入个人微信的官方 iLink Bot：首次启用需用手机扫码登录，之后在这个微信私聊里发的消息成为触发，编排器的确认、结果和问题也回到该私聊。',
      en: 'Connects the official iLink Bot of a personal WeChat account: the first enable scans a QR code, then messages in that WeChat direct chat become Triggers, and the orchestrator\'s acknowledgements, results and questions return there.' },
    schema: WeixinConfigSchema,
    fields: [
      { key: 'credentials', type: 'text', label: { zh: '登录凭据文件', en: 'Login credentials file' },
        hint: { zh: '扫码登录成功后保存 bot token 的文件，相对状态目录或绝对路径；待扫码的二维码 PNG 和链接文本也写在它旁边。换一个文件即重新登录。',
          en: 'File that keeps the bot token after a successful scan, relative to the state directory or absolute; the pending QR PNG and its link text are written beside it. Point it at another file to log in again.' } },
      { key: 'qrTimeoutMinutes', type: 'number', advanced: true, min: 1, max: 60, label: { zh: '扫码等待时限 / 分钟', en: 'QR scan time limit / minutes' },
        hint: { zh: '一次登录最多等待扫码的时间；二维码过期会自动换一张，最多刷新 3 次。', en: 'How long one login waits for the scan; an expired code is replaced automatically, at most three times.' } },
      { key: 'longPollTimeoutMs', type: 'number', advanced: true, min: 5000, max: 120000, label: { zh: '长轮询时限 / 毫秒', en: 'Long-poll time limit / ms' },
        hint: { zh: 'getUpdates 的客户端超时；服务端每次大约保持 35 秒，超时只表示暂时没有消息。', en: 'Client timeout of getUpdates; the server holds each request about 35 seconds, and a timeout only means no message yet.' } },
      { key: 'requestTimeoutMs', type: 'number', advanced: true, min: 1000, max: 120000, label: { zh: '请求时限 / 毫秒', en: 'Request time limit / ms' },
        hint: { zh: '登录、发消息等普通请求的时限。', en: 'Time limit of ordinary requests such as the login and a send.' } },
      { key: 'baseUrl', type: 'text', advanced: true, label: { zh: 'iLink 入口', en: 'iLink entry' },
        hint: { zh: '默认 https://ilinkai.weixin.qq.com；扫码后服务端返回的节点会优先使用，一般不用改。', en: 'Defaults to https://ilinkai.weixin.qq.com; the node a confirmed scan returns takes precedence, so this rarely changes.' } },
      { key: 'window', type: 'fact', label: { zh: '主动推送限制', en: 'Push limit' } },
    ],
    health: WEIXIN_HEALTH,
    facts: () => ({ window: { zh: 'iLink 只允许在对方最后一条消息后 24 小时内主动推送；超时后必须等对方再发一条。',
      en: 'iLink allows a push only within 24 hours of the person\'s last message; after that they must send the bot another message.' } }),
    scope({ meta }, _config) {
      // iLink conversations are direct chats with the bot; a group message (which the bot should not receive) is not
      // listened to, because the protocol's send path has no group branch.
      return meta.direct === true ? { listened: true, observed: false, row: DIRECT_ROW }
        : { listened: false, reason: 'group_not_supported' }
    },
    channel: {
      // A direct chat stays addressable while the bot is logged in; a send after the 24-hour window reports its failure.
      allowed: () => true,
      send: (_context, message) => bot.send(message),
      link: weixinLink,
    },
    threadContext: weixinThreadContext,
    policy: {
      unnamed: { person: { zh: '微信用户', en: 'WeChat user' }, bot: { zh: '微信机器人', en: 'WeChat bot' } },
      schema: WeixinPolicySchema,
      fields: [
        { key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信用户', en: 'WeChat users who may originate work' },
          hint: { zh: '填对方的 wxid（触发记录里能看到）。只有名单内的人发私聊消息才成为明确请求；不填时按准入表处理，默认忽略。',
            en: 'List the other side\'s wxid, which the Trigger shows. Only a listed person\'s direct message is an explicit request; otherwise the admission table applies, which ignores by default.' },
          columns: [{ key: 'id', type: 'text', label: { zh: 'wxid', en: 'wxid' } },
            { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      ],
      explicit: { zh: 'iLink 只有与机器人的私聊：名单内的人发的消息总是明确的请求，没有 @ 与群聊之分。',
        en: 'iLink only carries direct chats with the bot: a listed person\'s message is always an explicit request, with no mention or group distinction.' },
      rows: () => [{ id: DIRECT_ROW, label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '接收', en: 'Received' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
    },
  }
  return kind
}

export const name = 'dsh-superagent-weixin'
export const inject = ['orchestrator']
/**
 * Registers the Weixin kind, then attaches the bot and runs its login/poll lifecycle. Registration comes first so the
 * management panel shows the Source card before any scan; nothing performs a network call until the plugin is enabled,
 * and a failing loop is kept on the Source's health entry instead of escaping into the host.
 */
export function apply(ctx: Context): void {
  const host = ctx.orchestrator
  const bot = new WeixinBot()
  const kind = weixinKind(bot)
  ctx.effect(() => host.sources.register(kind), 'weixin: source kind')
  ctx.effect(() => {
    const context = sourceContext(host, kind)
    bot.attach(context)
    const controller = new AbortController()
    const running = bot.run(controller.signal).catch((error: unknown) => {
      try { context.report(WEIXIN_POLL, { state: 'error', detail: `The Weixin Source stopped: ${String(error)}` }) } catch { /* unregistered */ }
      ctx.logger.warn('dsh-superagent weixin loop failed: %s', String(error))
    })
    return async () => { bot.detach(); controller.abort(); await running }
  }, 'weixin: bot')
}