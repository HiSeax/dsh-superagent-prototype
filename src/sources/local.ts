/** Local DSH Session Source kind and Cordis plugin entry: the orchestrator's main Session, or separate ordinary Sessions, as the Source. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sourceContext, type SourceHost } from './host.ts'
import type { SourceKind } from './kind.ts'
import { localLink, sendLocal } from './local-channel.ts'
import { receiveLocal, runLocal, LOCAL_HEALTH } from './local-loops.ts'
import { localThreadContext } from './local-read.ts'
import { LOCAL_USER, MASTER_ROW, localTrigger, SOURCE } from './local-trigger.ts'

const SessionSchema = z.object({ sessionId: z.string().trim().min(1).max(200), name: z.string().trim().max(60).optional() }).strict()
const LocalConfigSchema = z.object({
  master: z.boolean().default(false),
  sessions: z.array(SessionSchema).refine(sessions => new Set(sessions.map(row => row.sessionId)).size === sessions.length,
    'Duplicate Session IDs').default([]),
  readPageSize: z.number().int().min(1).max(50).default(20),
}).strict()
export type LocalConfig = z.infer<typeof LocalConfigSchema>
/** The Source's Policy part: the local users who may originate work, the local user by default. */
const LocalPolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
    .default([{ id: LOCAL_USER }]),
}).strict()
/** The admission row a Trigger's meta belongs to, or undefined when this Source does not listen to it. */
function rowOf(config: LocalConfig, meta: Record<string, unknown>): string | undefined {
  if (meta.master === true) return config.master ? MASTER_ROW : undefined
  const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : ''
  return config.sessions.some(row => row.sessionId === sessionId) ? sessionId : undefined
}
/** Whether `config` listens to a Trigger whose meta names the main Session or one configured channel Session. */
export const listensTo = (config: LocalConfig, meta: Record<string, unknown>): boolean => rowOf(config, meta) !== undefined

/**
 * Builds the local Session kind for `host`. A person writes in the orchestrator's own main Session when that is switched
 * on, and in any separate ordinary DSH Session configured as a channel; those messages become the Source's Triggers, and
 * the Engine's replies go back into the same Session's conversation.
 */
export function localKind(host: SourceHost): SourceKind<LocalConfig> {
  const kind: SourceKind<LocalConfig> = {
    kind: SOURCE,
    title: { zh: '本地 DSH 会话', en: 'Local DSH Session' },
    description: { zh: '把编排器主会话或另开的普通 DSH 会话当作来源：人发的消息成为触发，编排器的确认、结果和问题也回到同一个会话。',
      en: 'Uses the orchestrator\'s main Session, or another ordinary DSH Session, as the Source: a person\'s messages there become Triggers, and the orchestrator\'s acknowledgements, results and questions return to the same Session.' },
    schema: LocalConfigSchema,
    fields: [
      { key: 'master', type: 'switch', label: { zh: '监听编排器主会话', en: 'Listen to the orchestrator\'s main Session' },
        hint: { zh: '开启后，你在编排器主会话里发的消息直接成为触发，编排器的确认、结果和问题也回到主会话。插件自己投递的候选、确认和工作输入不会被当成触发；你在主会话里看到的普通对话照旧。',
          en: 'When on, a message you write in the orchestrator\'s main Session becomes a Trigger, and the orchestrator\'s acknowledgements, results and questions return there. The candidates, acknowledgements and worker inputs this plugin delivers never become Triggers; ordinary conversation in the main Session is unchanged.' } },
      { key: 'sessions', type: 'rows', label: { zh: '其他通道会话', en: 'Other channel Sessions' },
        hint: { zh: '另开的普通 DSH 会话的 session id（可选）。这个会话里人发的消息成为触发；编排器的确认、结果和问题也回到这个会话。保存后立即生效，不用重启。',
          en: 'Session ids of separate ordinary DSH Sessions (optional). A person\'s messages there become Triggers, and the orchestrator\'s acknowledgements, results and questions return there. A save applies at once, without a restart.' },
        columns: [{ key: 'sessionId', type: 'text', label: { zh: 'Session ID', en: 'Session ID' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' },
        hint: { zh: '智能体读取被监听会话的历史时，每页的消息数。', en: 'Messages per page when agents read a listened Session\'s history.' } },
    ],
    health: [LOCAL_HEALTH],
    scope({ meta }, config) {
      const row = rowOf(config, meta)
      return row === undefined ? { listened: false, reason: 'session_not_allowed' } : { listened: true, observed: false, row }
    },
    channel: {
      // A reply goes only to the main Session while it is listened to, or to a Session the Source still receives.
      allowed: (address, config) =>
        (config.master && address.master === 'true') || config.sessions.some(row => row.sessionId === address.sessionId),
      send: (_context, message) => sendLocal(host.dshSessions, message),
      link: localLink,
    },
    threadContext: localThreadContext(host.dshSessions),
    policy: {
      unnamed: { person: { zh: '本地用户', en: 'Local user' }, bot: { zh: '自动化消息', en: 'Automated message' } },
      schema: LocalPolicySchema,
      fields: [
        { key: 'allowed', type: 'rows', label: { zh: '能发起工作的本地用户', en: 'Local users who may originate work' },
          hint: { zh: '被监听会话里人发的消息一定来自本地用户；不在这份名单里的本地用户按准入表处理。',
            en: 'A person\'s message in a listened Session always comes from the local user; a local user not on this list follows the admission table.' },
          columns: [{ key: 'id', type: 'text', label: { zh: '本地用户', en: 'Local user' } },
            { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      ],
      explicit: { zh: '被监听的会话里，人自己发的消息总是明确的请求：本地会话没有 @ 与私聊之分，也不存在没有指向机器人的消息。',
        en: 'A message a person writes in a listened Session is always an explicit request: a local Session has no mentions and no direct-message distinction.' },
      rows(config) {
        const parsed = LocalConfigSchema.parse(config)
        const cells = { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }
        return [
          ...parsed.master ? [{ id: MASTER_ROW, label: { zh: '主会话', en: 'Main Session' }, note: { zh: '接收', en: 'Received' }, cells }] : [],
          ...parsed.sessions.map(row => ({ id: row.sessionId, label: row.name || row.sessionId,
            note: { zh: '接收', en: 'Received' }, cells })),
        ]
      },
    },
  }
  return kind
}

export const name = 'dsh-superagent-local'
export const inject = ['orchestrator']
/**
 * Registers the local Session kind, listens to the DSH Sessions a person writes in as its Triggers, and reports whether the
 * configured channel Sessions exist.
 */
export function apply(ctx: Context): void {
  const host = ctx.orchestrator
  const kind = localKind(host)
  ctx.effect(() => host.sources.register(kind), 'local: source kind')
  ctx.effect(() => {
    const context = sourceContext(host, kind)
    const dispose = ctx.on('session/event', (session, event) => {
      const trigger = localTrigger({ sessionId: session.id, masterId: host.masterId, event })
      if (!trigger) return
      // The Source's configuration decides which Sessions are listened to, the main Session included; a save applies
      // without a restart.
      const config = context.config<LocalConfig>(SOURCE)
      if (!config || !listensTo(config, trigger.meta)) return
      void receiveLocal(context, trigger).catch((error: unknown) => {
        ctx.logger.warn('dsh-superagent could not receive a local Session message: %s', String(error))
      })
    })
    return () => { dispose() }
  }, 'local: channel Sessions')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runLocal(host, kind, controller.signal)
    return async () => { controller.abort(); await running }
  }, 'local: health')
}