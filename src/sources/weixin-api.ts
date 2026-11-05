/**
 * iLink Bot HTTP client for the Weixin personal-account bot.
 *
 * Alignment: `@tencent-weixin/openclaw-weixin@2.4.6` (npm, 2026-06-22), as documented by zhayujie/CowAgent
 * `channel/weixin/weixin_api.py` and SiverKing/weixin-ClawBot-API `weixin-openclaw-api-py-docs.md`. The protocol is not a
 * published specification with a stability promise, so every field here is pinned to that version; a field the references
 * disagree on or only imply is marked "推定，未验证" at its definition. This module performs no network call by itself; the
 * Source's login and poll loops drive it, and nothing runs until the plugin is enabled.
 */
import { randomInt } from 'node:crypto'
import { z } from 'zod'

/** The iLink protocol version this client targets; sent as `channel_version` and encoded into `iLink-App-ClientVersion`. */
export const PROTOCOL_VERSION = '2.4.6'
/** `iLink-App-ClientVersion` = (2 << 16) | (4 << 8) | 6 for {@link PROTOCOL_VERSION}; the references encode it this way. */
export const APP_CLIENT_VERSION = '132102'
/** The fixed entry for a login QR code; business calls use the `baseurl` a confirmed login returns. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** Bot identity reported to iLink for log attribution: ASCII `Name/Version (comment)` tokens, at most 256 bytes. */
export const BOT_AGENT = 'dsh-superagent/0.1.0 (node)'

/** The subset of `fetch` this client needs, so tests can answer every request without a network. */
export interface FetchResponse { status: number; text(): Promise<string> }
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponse>
/** Timeouts the references give for 2.4.6; a long poll outlives the server's 35 s hold by a margin. */
export interface WeixinTimeouts { request: number; longPoll: number }

/** A transport or HTTP failure: the request did not produce a JSON business reply. */
export class WeixinHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message) }
}
/** A business failure: HTTP 200 with a non-zero `ret` or `errcode`; the references agree this must not read as success. */
export class WeixinApiError extends Error {
  constructor(readonly ret: number, readonly errcode: number, readonly errmsg: string, what: string) {
    super(`${what} failed: ret=${ret} errcode=${errcode}${errmsg ? ` ${errmsg}` : ''}`)
  }
}
/**
 * Whether a failure means the bot token is stale: the references (2.4.5) define `ret`/`errcode` `-14` as "stale token",
 * not as an ordinary session timeout. A stale token stops business calls and starts a controlled re-login.
 */
export const isAuthError = (error: unknown): boolean => error instanceof WeixinApiError && (error.ret === -14 || error.errcode === -14)

/** The headers of one business POST; `X-WECHAT-UIN` is fresh per request, as the references generate it. */
function headers(token?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomInt(0, 0x1_0000_0000)), 'utf8').toString('base64'),
    'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': APP_CLIENT_VERSION, ...token ? { Authorization: `Bearer ${token}` } : {} }
}
/** The minimal application headers the references send on the QR status GET (no token, no JSON body). */
const appHeaders = (): Record<string, string> => ({ 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': APP_CLIENT_VERSION })
const endpoint = (base: string, path: string): string => `${base.replace(/\/+$/, '')}/${path}`
const timeoutOf = (error: unknown): boolean => error instanceof Error
  && (error.name === 'TimeoutError' || error.name === 'AbortError' || (error as { code?: string }).code === 'ETIMEDOUT')

/** Reads one response as JSON; any HTTP failure or unreadable body is an error, never an empty success. */
async function call(fetcher: Fetcher, url: string, init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number, what: string): Promise<Record<string, unknown>> {
  let response: FetchResponse
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new WeixinHttpError(`${what} did not complete: ${error instanceof Error ? error.message : String(error)}`, 0, '')
  }
  let text: string
  try { text = await response.text() } catch { text = '' }
  if (response.status < 200 || response.status >= 300) throw new WeixinHttpError(`${what} answered HTTP ${response.status}`, response.status, text.slice(0, 300))
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WeixinHttpError(`${what} answered unreadable JSON`, response.status, text.slice(0, 300))
  return parsed as Record<string, unknown>
}
/** Business success requires `ret` and `errcode` to be zero or absent (2.4.5 checks this on sends too). */
function ensureOk(reply: Record<string, unknown>, what: string): void {
  const ret = Number(reply.ret ?? 0), errcode = Number(reply.errcode ?? 0)
  if (ret || errcode) throw new WeixinApiError(ret, errcode, String(reply.errmsg ?? ''), what)
}
const UpdatesSchema = z.looseObject({ ret: z.number().optional(), errcode: z.number().optional(), errmsg: z.string().optional(),
  msgs: z.array(z.unknown()).default([]), get_updates_buf: z.string().optional(), longpolling_timeout_ms: z.number().optional() })
const QrCodeSchema = z.looseObject({ qrcode: z.string().min(1), qrcode_img_content: z.string().default('') })
const UploadUrlSchema = z.looseObject({ upload_full_url: z.string().optional(), upload_param: z.string().optional() })
const QrStatusSchema = z.looseObject({ status: z.string(), redirect_host: z.string().optional(), bot_token: z.string().optional(),
  ilink_bot_id: z.string().optional(), ilink_user_id: z.string().optional(), baseurl: z.string().optional() })
export type QrStatus = z.infer<typeof QrStatusSchema>
/** One `getUpdates` page: the messages and the cursor to echo next. */
export interface UpdatesPage { msgs: unknown[]; cursor?: string; longPollMs?: number }
/**
 * One `getuploadurl` request: `rawSize`/`rawMd5` describe the plaintext file, `cipherSize` the AES-128-ECB ciphertext, and
 * `mediaType` is 1 for an image (2 video, 3 file). The references send the AES key as 32 hex characters.
 */
export interface UploadUrlRequest { filekey: string; mediaType: number; toUserId: string; rawSize: number; rawMd5: string
  cipherSize: number; aesKeyHex: string }
/**
 * The CDN ticket `getuploadurl` returns: `uploadFullUrl` is preferred when the server names one, and `uploadParam` is the
 * legacy parameter the transport appends to the CDN's own upload URL. 推定，未验证: whether 2.4.6 can omit both.
 */
export interface UploadUrlTicket { uploadFullUrl?: string; uploadParam?: string }
/** What one `image_item` needs after an upload: the CDN download parameter, the base64 media key, and the ciphertext size. */
export interface OutboundImage { encryptQueryParam: string; aesKeyBase64: string; ciphertextSize: number }

/** Authenticated iLink business calls; a new instance is built for each confirmed login. */
export class WeixinApi {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetcher: Fetcher,
    private readonly timeouts: WeixinTimeouts) {}
  private baseInfo(): Record<string, unknown> { return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT } }
  private async post(path: string, body: Record<string, unknown>, timeoutMs: number, what: string): Promise<Record<string, unknown>> {
    const reply = await call(this.fetcher, endpoint(this.baseUrl, path),
      { method: 'POST', headers: headers(this.token), body: JSON.stringify({ ...body, base_info: this.baseInfo() }) }, timeoutMs, what)
    return reply
  }
  /**
   * Long-polls for messages. A client timeout is an empty poll (the server holds the request about 35 s), not a failure;
   * a business error is the caller's to handle, and `-14` means the token is stale.
   */
  async updates(cursor: string): Promise<UpdatesPage> {
    let reply: Record<string, unknown>
    try {
      reply = await this.post('ilink/bot/getupdates', { get_updates_buf: cursor }, this.timeouts.longPoll, 'getUpdates')
    } catch (error) {
      if (timeoutOf(error)) return { msgs: [] }
      throw error
    }
    ensureOk(reply, 'getUpdates')
    const page = UpdatesSchema.parse(reply)
    // 推定，未验证: the server's suggested next client timeout is honoured only when it is a sane positive value.
    const suggested = page.longpolling_timeout_ms !== undefined && page.longpolling_timeout_ms > 0
      ? Math.min(Math.max(page.longpolling_timeout_ms + 5_000, 10_000), 120_000) : undefined
    return { msgs: page.msgs, ...page.get_updates_buf ? { cursor: page.get_updates_buf } : {}, ...suggested !== undefined ? { longPollMs: suggested } : {} }
  }
  /** Sends one text message; `clientId` travels as `client_id`, the protocol's per-send identity. */
  async sendText(to: string, text: string, contextToken: string, clientId: string): Promise<void> {
    const reply = await this.post('ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: to, client_id: clientId,
      message_type: 2, message_state: 2, context_token: contextToken, item_list: [{ type: 1, text_item: { text } }] } },
    this.timeouts.request, 'sendMessage')
    ensureOk(reply, 'sendMessage')
  }
  /**
   * Asks for a CDN upload ticket for one media file. The reply is the entry to the upload, not the upload itself: the
   * caller encrypts the file, POSTs it to the returned URL, and keeps the `x-encrypted-param` header for `sendImage`.
   */
  async getUploadUrl(request: UploadUrlRequest): Promise<UploadUrlTicket> {
    const reply = await this.post('ilink/bot/getuploadurl', { filekey: request.filekey, media_type: request.mediaType,
      to_user_id: request.toUserId, rawsize: request.rawSize, rawfilemd5: request.rawMd5, filesize: request.cipherSize,
      aeskey: request.aesKeyHex, no_need_thumb: true }, this.timeouts.request, 'getUploadUrl')
    ensureOk(reply, 'getUploadUrl')
    const ticket = UploadUrlSchema.parse(reply)
    return { ...ticket.upload_full_url ? { uploadFullUrl: ticket.upload_full_url } : {},
      ...ticket.upload_param ? { uploadParam: ticket.upload_param } : {} }
  }
  /**
   * Sends one uploaded image as its own message, the way the references send media: `item_list` carries one item, and a
   * text the caller wrote travels in a separate send. `mid_size` is the ciphertext size, `encrypt_type` 1.
   */
  async sendImage(to: string, contextToken: string, clientId: string, image: OutboundImage): Promise<void> {
    const reply = await this.post('ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: to, client_id: clientId,
      message_type: 2, message_state: 2, context_token: contextToken, item_list: [{ type: 2, image_item: {
        media: { encrypt_query_param: image.encryptQueryParam, aes_key: image.aesKeyBase64, encrypt_type: 1 },
        mid_size: image.ciphertextSize } }] } }, this.timeouts.request, 'sendMessage')
    ensureOk(reply, 'sendMessage')
  }
  /** Returns the typing ticket of one sender; iLink needs it only for the typing indicator, never for sends. */
  async getConfig(userId: string, contextToken: string): Promise<string> {
    const reply = await this.post('ilink/bot/getconfig', { ilink_user_id: userId, ...contextToken ? { context_token: contextToken } : {} },
      this.timeouts.request, 'getConfig')
    ensureOk(reply, 'getConfig')
    return z.looseObject({ typing_ticket: z.string().optional() }).parse(reply).typing_ticket ?? ''
  }
  async sendTyping(userId: string, typingTicket: string, status: 1 | 2): Promise<void> {
    const reply = await this.post('ilink/bot/sendtyping', { ilink_user_id: userId, typing_ticket: typingTicket, status },
      this.timeouts.request, 'sendTyping')
    ensureOk(reply, 'sendTyping')
  }
  /** Announces client start/stop; the references make both best-effort, so callers only log a failure. */
  async notify(kind: 'start' | 'stop'): Promise<void> {
    const reply = await this.post(`ilink/bot/msg/notify${kind}`, {}, 10_000, `notify${kind}`)
    ensureOk(reply, `notify${kind}`)
  }
}

/**
 * Asks for a login QR code. The references POST to the fixed entry with `bot_type=3` and the locally held tokens, so the
 * server can bind a known account; `qrcode_img_content` is the URL the QR encodes (not image data).
 */
export async function fetchQrCode(fetcher: Fetcher, baseUrl: string, localTokens: string[], timeoutMs: number,
  botType = '3'): Promise<{ qrcode: string; url: string }> {
  const reply = await call(fetcher, `${endpoint(baseUrl, 'ilink/bot/get_bot_qrcode')}?bot_type=${encodeURIComponent(botType)}`,
    { method: 'POST', headers: headers(), body: JSON.stringify({ local_token_list: localTokens }) }, timeoutMs, 'getBotQrcode')
  const parsed = QrCodeSchema.parse(reply)
  return { qrcode: parsed.qrcode, url: parsed.qrcode_img_content }
}

/**
 * Long-polls one QR login status. A client timeout means "no status change yet"; the references treat it as `wait`. The
 * status vocabulary and its handling live in `weixin-bot.ts`, where login is a state machine.
 */
export async function pollQrStatus(fetcher: Fetcher, baseUrl: string, qrcode: string, timeoutMs: number): Promise<QrStatus> {
  try {
    const reply = await call(fetcher, `${endpoint(baseUrl, 'ilink/bot/get_qrcode_status')}?qrcode=${encodeURIComponent(qrcode)}`,
      { method: 'GET', headers: appHeaders() }, timeoutMs, 'getQrcodeStatus')
    return QrStatusSchema.parse(reply)
  } catch (error) {
    if (timeoutOf(error)) return { status: 'wait' }
    throw error
  }
}