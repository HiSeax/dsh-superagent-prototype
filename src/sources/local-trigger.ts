/**
 * Normalizes a person's message in a local DSH Session into a domain Trigger.
 *
 * A local DSH Session is a Source's channel: the person writes in an ordinary Session, and every message the person
 * writes there is a direct request to the agent. The Session's own agent messages, other plugins' deliveries and this
 * plugin's own replies never become Triggers.
 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'local'
/** The one person a local Session has: the local user, whose messages alone may originate work. */
export const LOCAL_USER = 'local'
/** The primary Thread of one DSH Session: its messages form one conversation, keyed `local:<session id>`. */
export const localThreadId = (sessionId: string): string => sessionId
/** Channel address of a reply into the Session; `messageId` names the message the reply answers. */
export const localChannel = (sessionId: string, messageId: string): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${sessionId}`, address: { sessionId, messageId } })
/** Deterministic Trigger ID for one DSH message; every read of the same message produces the same ID. */
export const localTriggerId = (sessionId: string, messageId: string): string => key(SOURCE, sessionId, messageId)
/** The part of a DSH `session/event` a Trigger is made from. */
export interface LocalMessageEvent { type: string; seq: number; time: number; data: unknown }
const MessageSchema = z.looseObject({
  id: z.string().min(1), role: z.literal('user'), content: z.array(z.unknown()), source: z.looseObject({ kind: z.string() }),
})
/** Concatenates the text blocks of a message's content; messages without text produce the empty string. */
export function messageText(content: readonly unknown[]): string {
  return content.flatMap(block => block && typeof block === 'object' && 'type' in block && block.type === 'text'
    && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
}
/**
 * Converts one DSH Session event into a Trigger of this Source, or returns undefined when it is not a person's message.
 * @param input.sessionId - the Session the event was appended to.
 * @param input.masterId - the orchestrator's own Session, whose messages never become Triggers.
 */
export function localTrigger(input: { sessionId: string; masterId: string; event: LocalMessageEvent }): Trigger | undefined {
  const { sessionId, masterId, event } = input
  if (event.type !== 'user/message' || sessionId === masterId) return undefined
  const parsed = MessageSchema.safeParse(event.data)
  if (!parsed.success) return undefined
  // Only a message a person wrote in the Session becomes a Trigger: this plugin's own replies and other plugins' notices
  // carry their producer's kind.
  if (parsed.data.source.kind !== 'user') return undefined
  const text = messageText(parsed.data.content)
  if (!text) return undefined
  return { id: localTriggerId(sessionId, parsed.data.id), source: SOURCE, threads: [{ source: SOURCE, id: localThreadId(sessionId) }],
    actor: { source: SOURCE, id: LOCAL_USER }, human: true, addressed: 'direct', at: new Date(event.time).toISOString(), text,
    channel: localChannel(sessionId, parsed.data.id), meta: { sessionId, messageId: parsed.data.id, seq: event.seq } }
}