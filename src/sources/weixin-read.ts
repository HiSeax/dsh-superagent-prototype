/**
 * Trigger-scoped context reader for the Weixin Source.
 *
 * iLink Bot's public operations are `getUpdates`, `sendMessage`, `getConfig`, `sendTyping` and media helpers; neither the
 * references nor the official plugin expose a history read, so the reader reports `no_history` and returns no messages
 * rather than inventing a page. An assessment still has the Trigger's own text.
 */
import type { Trigger } from '../core/index.ts'
import type { ContextPart, ThreadContext } from './kind.ts'
import type { WeixinConfig } from './weixin-config.ts'

/** The context reader of a Source whose protocol has no history operation. */
export const weixinThreadContext: ThreadContext<WeixinConfig> = {
  messageId: (trigger: Trigger) => String(trigger.meta.messageId ?? ''),
  read: async (): Promise<ContextPart> => ({ messages: [], status: 'no_history',
    body: { status: 'no_history', note: 'The iLink Bot API has no history read; assess the Trigger itself' } }),
}