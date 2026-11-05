/** Local DSH Session outbound channel: delivers a reply into the channel Session once per OutboundMessage id. */
import type { OutboundMessage } from '../core/index.ts'
import type { SourceSessions } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/**
 * Delivers a reply into the channel Session as the next message of its conversation; the OutboundMessage id is the
 * idempotency key, so a retried receipt never delivers the same reply twice.
 */
export async function sendLocal(sessions: SourceSessions, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const sessionId = message.channel.address.sessionId
  if (!sessionId) throw new Error('Missing local Session reply target')
  const text = message.text.trim()
  if (!text) throw new Error('A local Session reply needs text')
  return sessions.deliver(sessionId, message.id, text, 'queue')
}
/** A local Session has no page outside the host itself, so its link carries only the label. */
export const localLink = (_address: Record<string, string>, _links: ChannelLinks): ChannelLink =>
  ({ url: '', label: { zh: '本地会话', en: 'Local Session' } })