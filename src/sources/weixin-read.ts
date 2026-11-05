/**
 * Trigger-scoped context reader for the Weixin Source.
 *
 * iLink Bot's public operations are `getUpdates`, `sendMessage`, `getConfig`, `sendTyping` and media helpers; neither the
 * references nor the official plugin expose a history read, so the reader reports `no_history` and returns no messages
 * rather than inventing a page. An assessment still has the Trigger's own text, and its own images: the runtime downloads
 * them at intake, and `image` commits one stored file as a model-visible attachment, the way the Feishu reader does.
 */
import { readFile, stat } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type { Trigger } from '../core/index.ts'
import type { ContextPart, ThreadContext } from './kind.ts'
import type { WeixinConfig } from './weixin-config.ts'
import { mediaKeys, storedImages, within } from './weixin-media.ts'

/** One stored image of the Trigger's own message, committed as an attachment the main Session's model can see. */
export interface AdmissionImage { source_message_id: string; image_key: string; image: ImageAttachmentRef }

/** The context reader of a Source whose protocol has no history operation but which carries its own images. */
export const weixinThreadContext: ThreadContext<WeixinConfig> = {
  messageId: (trigger: Trigger) => String(trigger.meta.messageId ?? ''),
  read: async (): Promise<ContextPart> => ({ messages: [], status: 'no_history',
    body: { status: 'no_history', note: 'The iLink Bot API has no history read; assess the Trigger itself' } }),
  images: mediaKeys,
  /**
   * Reads one stored image of the Trigger's message as an attachment for `agent`. The path must be the one intake recorded
   * and stay inside the state directory, the model must accept image input, and the file must be within the attachment
   * service's byte limits, so a stale record or an edited Trigger can never reach an arbitrary file.
   */
  async image(agent: Agent, _commands, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<AdmissionImage> {
    const stored = storedImages(trigger).find(item => item.key === key)
    if (!stored) throw new Error('Choose an image key from this WeChat message')
    // iLink has no history read, so only the Trigger's own message has stored images; a context message has none.
    if (message.id !== String(trigger.meta.messageId ?? '')) throw new Error('Only the Trigger\'s own message has a stored image')
    if (!within(stateDir, stored.path)) throw new Error('The stored image lies outside the state directory')
    const attachments = agent.ctx.get('attachments')
    if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
    const route = agent.session.requestHeader()?.config
    const provider = route?.provider ?? agent.options.provider
    const model = route?.model ?? agent.options.model
    const llm = agent.ctx.get('llm')
    if (!llm || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (!info.inputModalities?.includes('image')) throw new Error(`Model ${model} does not support image input; the image has not been inspected`)
    signal.throwIfAborted()
    const file = await stat(stored.path)
    const limit = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
    if (!file.isFile() || file.size > limit) throw new Error('The stored image exceeds the deployment byte limit or is not a regular file')
    const data = await readFile(stored.path, { signal })
    signal.throwIfAborted()
    const image = await attachments.saveImage({ data, mediaType: stored.mime as ImageMediaType, name: stored.key })
    signal.throwIfAborted()
    return { source_message_id: message.id, image_key: key, image }
  },
}