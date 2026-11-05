/** Trigger-scoped reader of a local DSH Session's history; messages read inform assessments without entering intake. */
import type { Trigger } from '../core/index.ts'
import type { SessionLogMessage, SessionLogPage, SourceSessions } from './host.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'

/** Maps one Session message into the normalized shape an assessment reads, marking every non-human author as `bot`. */
function view(message: SessionLogMessage): ContextMessage {
  return { id: message.id, from: message.author === 'person' ? 'local user' : message.author === 'agent' ? 'assistant' : 'dsh-superagent',
    at: message.at, text: message.text, ...message.author === 'person' ? {} : { bot: true } }
}
/** Reads the channel Session backwards from the Trigger's own message; a local conversation has no topic root or reply parent. */
export const localThreadContext = (sessions: SourceSessions): ThreadContext<{ readPageSize: number }> => ({
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (_commands, trigger: Trigger, part, cursor, config): Promise<ContextPart> => {
    // A local Session holds one continuous conversation: it has neither a topic root nor a replied-to message.
    if (part !== 'thread') return { messages: [], body: { status: `no_${part}` }, status: `no_${part}` }
    const sessionId = String(trigger.meta.sessionId ?? '')
    const seq = Number(trigger.meta.seq)
    if (!sessionId || !Number.isSafeInteger(seq) || seq < 0) throw new Error('A local Session Trigger with its message position is required')
    const before = cursor === undefined ? seq + 1 : Number(cursor)
    if (!Number.isSafeInteger(before) || before < 0) throw new Error('Invalid local Session history cursor')
    const page: SessionLogPage = await sessions.page(sessionId, before, config.readPageSize)
    const messages = page.messages.map(view)
    return { messages, ...page.next === undefined ? {} : { next: String(page.next) },
      body: { status: 'available', messages, ...page.next === undefined ? {} : { next: page.next } }, status: 'available' }
  },
})