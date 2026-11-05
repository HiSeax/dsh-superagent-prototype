/** Host capability for a Source that uses a local DSH Session as its channel: idempotent delivery, bounded history, and existence. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { SessionLogMessage, SessionLogPage, SourceSessions } from '../sources/host.ts'
import { AgentDelivery } from './delivery.ts'

const WireMessage = z.looseObject({ id: z.string().min(1), content: z.array(z.unknown()), source: z.looseObject({ kind: z.string() }) })
/** Concatenates a message's text blocks; an unreadable message or one without text reads as no message. */
function messageOf(record: { type: string; seq: number; time: number; data: unknown }): SessionLogMessage[] {
  if (record.type !== 'user/message' && record.type !== 'assistant/message') return []
  const parsed = WireMessage.safeParse(record.data)
  if (!parsed.success) return []
  const text = parsed.data.content.flatMap(block => block && typeof block === 'object' && 'type' in block && block.type === 'text'
    && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
  if (!text) return []
  const author = record.type === 'assistant/message' ? 'agent' as const : parsed.data.source.kind === 'user' ? 'person' as const : 'plugin' as const
  return [{ id: parsed.data.id, seq: record.seq, at: new Date(record.time).toISOString(), text, author }]
}
/**
 * Serves the local Session Source: delivers a reply into an ordinary Session once per OutboundMessage id (through the same
 * idempotent `AgentDelivery` as the orchestrator's own messages), reads a bounded page of its history, and reports whether
 * a Session exists without activating its agent.
 */
export class LocalSessions implements SourceSessions {
  private readonly delivery: AgentDelivery
  constructor(private readonly host: { context: Context; lifetime: AbortSignal }) {
    this.delivery = new AgentDelivery(host.context)
  }
  async deliver(id: string, requestId: string, text: string, mode: 'queue' | 'steer'): Promise<'sent' | 'gone'> {
    const resolved = await this.host.context.sessionController.resolveAgent(id as SessionId)
    if (!('error' in resolved)) {
      await this.delivery.send(resolved.agent, requestId, text, mode, this.host.lifetime)
      return 'sent'
    }
    // A Session that no longer exists can never receive the reply; any other failure may succeed on a later retry.
    if ((resolved.error as { code?: unknown }).code === 'session/not-found' || !(await this.exists(id))) return 'gone'
    throw resolved.error
  }
  async page(id: string, before: number, limit: number): Promise<SessionLogPage> {
    if (!Number.isSafeInteger(before) || before <= 0) return { messages: [] }
    const request = { address: { kind: 'session' as const, sessionId: id as SessionId }, throughSeq: before - 1, maxMessages: limit }
    const result = await this.host.context.sessionController.page(request, this.host.lifetime)
    const oldest = result.records[0]
    return { messages: result.records.flatMap(record => record.type === 'event' ? messageOf(record.event) : []),
      ...result.hasMore && oldest ? { next: oldest.event.seq } : {} }
  }
  async exists(id: string): Promise<boolean> {
    try { return await this.host.context.sessionPersistence.stat(id as SessionId) !== undefined }
    catch { return false }
  }
}