/**
 * Normalizes an iLink Bot update into a domain Trigger.
 *
 * Alignment: the inbound `WeixinMessage` shape of zhayujie/CowAgent `channel/weixin/weixin_message.py` and the item
 * vocabulary of SiverKing/weixin-ClawBot-API (openclaw-weixin 2.4.6). iLink delivers direct messages only: the official
 * plugin declares `direct` chats and its send path has no group branch, so a message carrying `group_id` is not a Trigger.
 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'weixin'
/** The admission row: every iLink conversation is a direct chat with the bot, so one row covers the Source. */
export const DIRECT_ROW = 'direct'
/** `MessageItem.type` values of the text-only subset this Source can use; media has no read path here. */
const ITEM_TEXT = 1, ITEM_IMAGE = 2, ITEM_VOICE = 3, ITEM_FILE = 4, ITEM_VIDEO = 5
const TextItemSchema = z.looseObject({ text: z.string().optional() })
const RefMessageSchema = z.looseObject({ title: z.string().optional(),
  message_item: z.looseObject({ type: z.number().optional(), text_item: TextItemSchema.optional() }).optional() })
const ItemSchema = z.looseObject({ type: z.number(), text_item: TextItemSchema.optional(), voice_item: z.looseObject({ text: z.string().optional() }).optional(),
  ref_msg: RefMessageSchema.optional() })
/** One inbound update; `message_id` is optional in the references, which fall back to `seq`. */
export const WeixinMessageSchema = z.looseObject({
  message_id: z.union([z.string(), z.number()]).optional(), seq: z.union([z.string(), z.number()]).optional(),
  from_user_id: z.string().default(''), to_user_id: z.string().default(''),
  context_token: z.string().default(''), create_time_ms: z.union([z.number(), z.string()]).optional(),
  group_id: z.string().optional(), item_list: z.array(z.unknown()).default([]),
})
export type WeixinMessage = z.infer<typeof WeixinMessageSchema>
/** The Thread of one direct chat, keyed `weixin:<wxid>`; iLink has no topic or thread id to split it by. */
export const weixinThreadId = (userId: string): string => userId
/** Channel address of a reply into the chat; `userId` is the sender's wxid, which iLink replies to directly. */
export const weixinChannel = (userId: string): ChannelRef => ({ source: SOURCE, thread: `${SOURCE}:${userId}`, address: { userId } })
/** Deterministic Trigger ID for one inbound message; equal messages always produce the same id. */
export const weixinTriggerId = (userId: string, messageId: string): string => key(SOURCE, userId, messageId)

/** What one update's text and items say: the readable text, and whether a media item this Source cannot read came along. */
export interface ParsedItems { text: string; media: boolean; quoted: string }
/**
 * Flattens a message's `item_list`. A voice item's `text` is the phone's transcription, which the references use as the
 * message's text; an image, file, video or untranscribed voice leaves the text empty and is reported as media. A quoted
 * message contributes `[引用: …]` the way CowAgent renders it.
 */
export function parseItems(items: readonly unknown[]): ParsedItems {
  const texts: string[] = [], quotes: string[] = []
  let media = false
  for (const raw of items) {
    const parsed = ItemSchema.safeParse(raw)
    if (!parsed.success) continue
    const item = parsed.data
    if (item.type === ITEM_TEXT) {
      const value = item.text_item?.text?.trim()
      if (value) texts.push(value)
    } else if (item.type === ITEM_VOICE) {
      const value = item.voice_item?.text?.trim()
      if (value) texts.push(value)
      else media = true
    } else if (item.type === ITEM_IMAGE || item.type === ITEM_FILE || item.type === ITEM_VIDEO) {
      media = true
    }
    const ref = item.ref_msg
    if (ref) {
      const quoted = [ref.title, ref.message_item?.type === ITEM_TEXT ? ref.message_item.text_item?.text : undefined]
        .filter((part): part is string => !!part)
      if (quoted.length) quotes.push(`[引用: ${quoted.join(' | ')}]`)
    }
  }
  return { text: [...quotes, ...texts].join('\n'), media, quoted: quotes.join('\n') }
}
/**
 * Converts one inbound update into a Trigger, or returns undefined for anything this Source cannot represent: a group
 * message (iLink send has no group branch), a missing sender, a text-less media message, or an empty message.
 * @param message - one `msgs[]` entry of a `getUpdates` reply.
 */
export function weixinTrigger(message: WeixinMessage, now = (): number => Date.now()): Trigger | undefined {
  if (message.group_id) return undefined
  if (!message.from_user_id) return undefined
  const parsed = parseItems(message.item_list)
  const text = parsed.text.trim()
  // A picture, file, video or untranscribed voice has no text this Source can carry: the references would download and
  // decrypt it from the CDN, which this Source deliberately does not implement, so such a message is not a Trigger.
  if (!text) return undefined
  const rawId = message.message_id ?? message.seq
  const messageId = rawId === undefined ? key(SOURCE, 'synthetic', message.from_user_id, String(message.create_time_ms ?? now()), text) : String(rawId)
  const at = new Date(message.create_time_ms === undefined ? now() : Number(message.create_time_ms)).toISOString()
  const direct = !message.group_id
  return { id: weixinTriggerId(message.from_user_id, messageId), source: SOURCE,
    threads: [{ source: SOURCE, id: weixinThreadId(message.from_user_id) }], actor: { source: SOURCE, id: message.from_user_id },
    human: true, addressed: 'direct', at, text, channel: weixinChannel(message.from_user_id),
    meta: { userId: message.from_user_id, messageId, direct, createTime: at, ...parsed.media ? { media: true } : {} } }
}