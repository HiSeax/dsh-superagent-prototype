/**
 * Normalizes an iLink Bot update into a domain Trigger.
 *
 * Alignment: the inbound `WeixinMessage` shape of zhayujie/CowAgent `channel/weixin/weixin_message.py`, the item
 * vocabulary of SiverKing/weixin-ClawBot-API and `Tencent/openclaw-weixin` (2.4.6), and the media sections 2.9 and 5.4 of
 * the ClawBot docs for the `image_item` fields. iLink delivers direct messages only: the official plugin declares `direct`
 * chats and its send path has no group branch, so a message carrying `group_id` is not a Trigger.
 *
 * An image item has no text of its own: the runtime downloads it from the CDN, stores it under the state directory, and
 * passes the stored media here, which adds the `[Image: <key>]` reference an assessment reads the file by. A message whose
 * images could not be downloaded still becomes a Trigger, naming them unread, so a person's picture is not dropped silently.
 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { mediaMarker, type CdnMedia, type StoredMedia } from './weixin-media.ts'

export const SOURCE = 'weixin'
/** The admission row: every iLink conversation is a direct chat with the bot, so one row covers the Source. */
export const DIRECT_ROW = 'direct'
/** `MessageItem.type` values: text, image, voice, file and video; media has a read path only for images. */
const ITEM_TEXT = 1, ITEM_IMAGE = 2, ITEM_VOICE = 3, ITEM_FILE = 4, ITEM_VIDEO = 5
// nullish rather than optional: the protocol is protobuf JSON, where a field present but unset may arrive as `null`, and a
// schema that rejects it would drop the whole item (and with it the message) instead of reporting what is missing.
const TextItemSchema = z.looseObject({ text: z.string().nullish() })
/** `CDNMedia`: the encrypted download parameter, an optional full URL, and the AES key in whichever encoding the item used. */
const MediaSchema = z.looseObject({ encrypt_query_param: z.string().nullish(), aes_key: z.string().nullish(),
  full_url: z.string().nullish(), encrypt_type: z.number().nullish() })
const ImageItemSchema = z.looseObject({ media: MediaSchema.nullish(), aeskey: z.string().nullish(), mid_size: z.number().nullish() })
const RefMessageSchema = z.looseObject({ title: z.string().nullish(),
  message_item: z.looseObject({ type: z.number().optional(), text_item: TextItemSchema.optional() }).nullish() })
const ItemSchema = z.looseObject({ type: z.number(), text_item: TextItemSchema.optional(),
  voice_item: z.looseObject({ text: z.string().nullish() }).optional(), image_item: ImageItemSchema.optional(), ref_msg: RefMessageSchema.optional() })
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

/** What one update's text and items say: the readable text, and whether a media item came along that has no text of its own. */
export interface ParsedItems { text: string; media: boolean; quoted: string }
/**
 * Flattens a message's `item_list`. A voice item's `text` is the phone's transcription, which the references use as the
 * message's text; an untranscribed voice, an image, file or video leaves the text empty and is reported as media. A quoted
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
 * The download references of a message's image items, in order.
 *
 * Field priority follows both references, which read the key from `image_item.aeskey` first and from
 * `image_item.media.aes_key` only when that is empty: `@tencent-weixin/openclaw-weixin@2.4.6`
 * `dist/src/media/media-download.js` does `img.aeskey ? Buffer.from(img.aeskey, "hex").toString("base64") : img.media.aes_key`,
 * and CowAgent's `weixin_message.py` does `info.get("aeskey", "") or media.get("aes_key", "")`. An empty string counts as
 * absent, which is why the `||` is not a style choice here. A reference missing everything is kept, so the Trigger can say
 * which part is missing rather than silently dropping the picture.
 */
export function inboundImages(items: readonly unknown[]): CdnMedia[] {
  const refs: CdnMedia[] = []
  for (const raw of items) {
    const parsed = ItemSchema.safeParse(raw)
    if (!parsed.success || parsed.data.type !== ITEM_IMAGE) continue
    const image = parsed.data.image_item
    if (!image) continue
    const itemKey = image.aeskey?.trim() || ''
    const mediaKey = image.media?.aes_key?.trim() || ''
    const aesKey = itemKey || mediaKey
    refs.push({
      ...image.media?.encrypt_query_param?.trim() ? { encryptQueryParam: image.media.encrypt_query_param.trim() } : {},
      ...image.media?.full_url?.trim() ? { fullUrl: image.media.full_url.trim() } : {},
      ...aesKey ? { aesKey, aesKeySource: itemKey ? 'image_item.aeskey' as const : 'media.aes_key' as const } : {},
    })
  }
  return refs
}
/** The text reference of one image that could not be fetched, naming the stage from {@link mediaFailureText}. */
export const mediaFailureMarker = (reason: string): string => `[图片: 获取失败 ${reason}]`
/**
 * Converts one inbound update into a Trigger, or returns undefined for anything this Source cannot represent: a group
 * message (iLink send has no group branch), a missing sender, a text-less media message nothing was stored for, or an empty
 * message.
 * @param message - one `msgs[]` entry of a `getUpdates` reply.
 * @param media - the images the runtime stored for this message; each adds its `[Image: <key>]` reference to the text.
 * @param failures - why each image item could not be downloaded, one short reason per image; each adds its own note.
 */
export function weixinTrigger(message: WeixinMessage, now = (): number => Date.now(), media: readonly StoredMedia[] = [],
  failures: readonly string[] = []): Trigger | undefined {
  if (message.group_id) return undefined
  if (!message.from_user_id) return undefined
  const parsed = parseItems(message.item_list)
  const markers = [...media.map(item => mediaMarker(item.key)), ...failures.map(reason => mediaFailureMarker(reason))]
  const text = [parsed.text.trim(), ...markers].filter(part => part).join('\n')
  // A picture, file, video or untranscribed voice the runtime could not fetch has no text to carry: without a stored image
  // or an unread note there is nothing an assessment could act on, so it is not a Trigger.
  if (!text) return undefined
  const rawId = message.message_id ?? message.seq
  const messageId = rawId === undefined ? key(SOURCE, 'synthetic', message.from_user_id, String(message.create_time_ms ?? now()), text) : String(rawId)
  const at = new Date(message.create_time_ms === undefined ? now() : Number(message.create_time_ms)).toISOString()
  const direct = !message.group_id
  return { id: weixinTriggerId(message.from_user_id, messageId), source: SOURCE,
    threads: [{ source: SOURCE, id: weixinThreadId(message.from_user_id) }], actor: { source: SOURCE, id: message.from_user_id },
    human: true, addressed: 'direct', at, text, channel: weixinChannel(message.from_user_id),
    meta: { userId: message.from_user_id, messageId, direct, createTime: at, ...parsed.media || markers.length ? { media: true } : {},
      ...media.length ? { images: media.map(item => ({ key: item.key, path: item.path, mime: item.mime, bytes: item.bytes })) } : {} } }
}