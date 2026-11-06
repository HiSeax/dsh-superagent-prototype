/**
 * Media of the Weixin (iLink Bot) Source: the AES-128-ECB envelope over the WeChat CDN, the legacy-TLS CDN transport, the
 * stored-media layout under the state directory, and the `[Image: …]` reference an assessment reads.
 *
 * Alignment: `@tencent-weixin/openclaw-weixin@2.4.6` `dist/src/media/media-download.js` and `dist/src/cdn/pic-decrypt.js`,
 * plus zhayujie/CowAgent `channel/weixin/{weixin_api.py,weixin_message.py}` and SiverKing/weixin-ClawBot-API
 * `weixin-openclaw-api-py-docs.md` (2.6.6 and 2.9). Both references read an image's AES key from `image_item.aeskey`
 * (hex) first and from `image_item.media.aes_key` (base64) only when the former is absent, and both treat an empty value
 * as absent. An inbound key is accepted in every encoding seen in the wild — 32 hex characters, base64 of that hex, or
 * base64 of the raw 16 bytes — while the outbound field is base64 of the 32-character hex string.
 *
 * Every media failure is a {@link WeixinMediaError} whose `code` names the stage, so the Trigger can say what failed
 * (`[图片: 获取失败 HTTP 403]`) instead of reporting a blank "unavailable".
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { WeixinApi } from './weixin-api.ts'

/** The WeChat CDN the iLink protocol hands out; legacy upload/download URLs are built on this base. */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** `getuploadurl` `media_type`: the only media this Source sends is an image. */
export const MEDIA_IMAGE = 1
/** The directory under the state directory that received images are stored in, unless the configuration names another. */
export const MEDIA_DIR = 'weixin-media'
/** The references time out a CDN upload at 120 s and a download at 60 s; one conservative limit covers both. */
const CDN_TIMEOUT_MS = 120_000
const AES_BLOCK = 16

/** What a CDN call returned: status, headers, and the whole body, which a download bounds at `maxBytes`. */
export interface CdnResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
/** The CDN calls the protocol makes, injectable so tests answer them without a network or a certificate. */
export interface CdnTransport {
  request(url: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: Uint8Array; maxBytes?: number;
    timeoutMs?: number }): Promise<CdnResponse>
}
/** The stage a media failure belongs to; the Trigger names it in the `[图片: 获取失败 …]` note. */
export type MediaFailureCode = 'no-url' | 'no-key' | 'bad-key' | 'http' | 'timeout' | 'tls' | 'network' | 'too-large'
  | 'decrypt' | 'not-image' | 'store' | 'protocol'
/** A media failure that names its stage, with the CDN status when there was one. */
export class WeixinMediaError extends Error {
  constructor(readonly code: MediaFailureCode, message: string, readonly status = 0) { super(message) }
}
/** The short reason a person and an assessment see in the Trigger text. */
export function mediaFailureText(error: unknown): string {
  if (!(error instanceof WeixinMediaError)) return '未知错误'
  switch (error.code) {
    case 'no-url': return '缺少下载地址'
    case 'no-key': return '缺少 aes_key'
    case 'bad-key': return 'aes_key 解码'
    case 'http': return `HTTP ${error.status || '?'}`
    case 'timeout': return 'CDN 超时'
    case 'tls': return 'CDN TLS'
    case 'network': return 'CDN 连接失败'
    case 'too-large': return '超过大小上限'
    case 'decrypt': return '解密失败'
    case 'not-image': return '不是支持的图片格式'
    case 'store': return '写入失败'
    case 'protocol': return 'CDN 响应异常'
  }
}
/** The part of a CDN reference safe to log: origin and path, never the encrypted query value. */
export function mediaUrlLabel(media: CdnMedia): string {
  if (media.fullUrl) {
    try { const url = new URL(media.fullUrl); return `${url.origin}${url.pathname}` } catch { return '(full_url 无法解析)' }
  }
  return media.encryptQueryParam ? '(encrypt_query_param 已隐藏)' : '(无 URL)'
}
const headerOf = (headers: CdnResponse['headers'], name: string): string => {
  const value = headers[name]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}
const isTlsFailure = (message: string): boolean => /TLS|SSL|CERT|certificate|handshake|dh key|NO_SHARED_CIPHER/i.test(message)

/**
 * The WeChat CDN negotiates only a legacy TLS 1.2 handshake with RSA key exchange, and OpenSSL's default security level 2
 * refuses those suites, so the handshake fails with `SSLV3_ALERT_HANDSHAKE_FAILURE` — which is why the Python reference
 * builds a separate CDN session that lowers the level (`_get_cdn_session`). This agent lowers it for CDN traffic only:
 * the iLink API keeps Node's defaults. 推定，未验证: whether the CDN still needs the lower level follows the reference,
 * not a probe of our own, so a future handshake change shows up as a CDN failure on the Source's health entry.
 */
const legacyTlsAgent = new HttpsAgent({ keepAlive: true, minVersion: 'TLSv1.2', ciphers: 'DEFAULT@SECLEVEL=1' })

/** The real CDN transport; every other operation here takes a transport so tests replace this one. */
export const nodeCdnTransport: CdnTransport = {
  request(url, init) {
    const target = new URL(url)
    if (target.protocol !== 'https:') return Promise.reject(new WeixinMediaError('network', `The WeChat CDN URL is not HTTPS (${target.protocol})`))
    return new Promise<CdnResponse>((resolve, reject) => {
      const headers: Record<string, string> = { ...init.body ? { 'Content-Length': String(init.body.byteLength) } : {}, ...init.headers }
      const request = httpsRequest(target, { method: init.method, agent: legacyTlsAgent, headers }, response => {
        const chunks: Buffer[] = []
        let size = 0
        let overflow: WeixinMediaError | undefined
        response.on('data', (chunk: Buffer) => {
          if (overflow) return
          size += chunk.length
          if (init.maxBytes !== undefined && size > init.maxBytes) {
            overflow = new WeixinMediaError('too-large', `The WeChat CDN reply is larger than ${init.maxBytes} bytes`)
            request.destroy(overflow)
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => { if (!overflow) resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }) })
      })
      request.setTimeout(init.timeoutMs ?? CDN_TIMEOUT_MS, () => request.destroy(
        new WeixinMediaError('timeout', `The WeChat CDN request timed out after ${init.timeoutMs ?? CDN_TIMEOUT_MS} ms`)))
      request.on('error', error => {
        if (error instanceof WeixinMediaError) { reject(error); return }
        const message = error instanceof Error ? error.message : String(error)
        reject(new WeixinMediaError(isTlsFailure(message) ? 'tls' : 'network', `The WeChat CDN request failed: ${message}`))
      })
      if (init.body) request.write(init.body)
      request.end()
    })
  },
}

/** The PKCS#7 padded size of `size` bytes, the `filesize` field of `getuploadurl`: `ceil((size + 1) / 16) * 16`. */
export const paddedMediaSize = (size: number): number => Math.ceil((size + 1) / AES_BLOCK) * AES_BLOCK
/** Encrypts one file for the CDN with AES-128-ECB and PKCS#7 padding, as both references do. */
export function encryptMedia(data: Uint8Array, key: Uint8Array): Buffer {
  if (key.length !== AES_BLOCK) throw new WeixinMediaError('bad-key', 'An iLink media key is exactly 16 bytes')
  const pad = AES_BLOCK - data.length % AES_BLOCK
  const padded = Buffer.alloc(data.length + pad)
  Buffer.from(data).copy(padded)
  padded.fill(pad, data.length)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()])
}
/**
 * Decrypts one CDN reply with AES-128-ECB, removing PKCS#7 padding. A last byte outside 1..16 is not a pad length, so the
 * plaintext is returned whole — the same defence the Python reference applies against discarding everything.
 */
export function decryptMedia(data: Uint8Array, key: Uint8Array): Buffer {
  if (key.length !== AES_BLOCK) throw new WeixinMediaError('bad-key', 'An iLink media key is exactly 16 bytes')
  const body = Buffer.from(data)
  if (!body.length || body.length % AES_BLOCK) throw new WeixinMediaError('decrypt', 'The iLink media ciphertext is not a whole number of AES blocks')
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false)
  const padded = Buffer.concat([decipher.update(body), decipher.final()])
  const pad = padded[padded.length - 1]!
  return pad >= 1 && pad <= AES_BLOCK ? padded.subarray(0, padded.length - pad) : padded
}
/**
 * Reads a media key in any of the forms the references document: 32 hex characters (`image_item.aeskey`), base64 of that
 * hex string, or base64 of the raw 16 bytes (`media.aes_key`). Anything else fails as `bad-key`, which the Trigger names.
 */
export function resolveMediaKey(value: string): Buffer {
  const text = value.trim()
  if (!text) throw new WeixinMediaError('no-key', 'The iLink media key is empty')
  if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex')
  const decoded = Buffer.from(text, 'base64')
  if (decoded.length === 32) {
    const hex = decoded.toString('utf8')
    if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex')
  }
  if (decoded.length === AES_BLOCK) return decoded
  throw new WeixinMediaError('bad-key', 'The iLink media key is neither 32 hex characters, their base64, nor a base64 16-byte key')
}
/** The outbound `CDNMedia.aes_key` form: base64 of the 32-character hex string. */
export const mediaKeyField = (key: Uint8Array): string => Buffer.from(Buffer.from(key).toString('hex'), 'utf8').toString('base64')

/** The image types a model can read and the file extensions they are stored with. */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
const IMAGES: Record<ImageMime, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
export const isImageMime = (value: string): value is ImageMime => Object.hasOwn(IMAGES, value)
/** The image type of a file's first bytes, or undefined for anything this Source cannot hand to a model. */
export function sniffImage(data: Uint8Array): { mime: ImageMime; ext: string } | undefined {
  const head = Buffer.from(data.subarray(0, 16))
  const mime = head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG' ? 'image/png'
    : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'image/jpeg'
      : head.toString('latin1', 0, 4) === 'GIF8' ? 'image/gif'
        : head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : undefined
  return mime ? { mime, ext: IMAGES[mime] } : undefined
}

/** The `image_item.media` reference of one inbound image: what a download needs, as the item carries it. */
export interface CdnMedia {
  encryptQueryParam?: string
  fullUrl?: string
  aesKey?: string
  /** Which field the key came from, logged (never the key itself) so a decoding failure names its source. */
  aesKeySource?: 'image_item.aeskey' | 'media.aes_key'
}
/** What `uploadMedia` needs to build the `image_item` a sendMessage carries. */
export interface MediaUpload { encryptQueryParam: string; aesKeyBase64: string; ciphertextSize: number; rawSize: number }

/**
 * Uploads one image for `toUserId`: `getuploadurl` for a CDN ticket, then the AES-128-ECB ciphertext to the CDN, and the
 * `x-encrypted-param` reply header as the download parameter a later `image_item` names.
 */
export async function uploadMedia(api: Pick<WeixinApi, 'getUploadUrl'>, transport: CdnTransport,
  input: { data: Uint8Array; toUserId: string; mediaType?: number; cdnBaseUrl?: string
    /** The AES key to use; omitted in production (random per upload) and fixed by a test that checks the exact ciphertext. */
    aesKey?: Uint8Array }): Promise<MediaUpload> {
  const data = Buffer.from(input.data)
  if (!data.length) throw new WeixinMediaError('protocol', 'An iLink media upload needs a non-empty file')
  const key = input.aesKey ? Buffer.from(input.aesKey) : randomBytes(AES_BLOCK)
  if (key.length !== AES_BLOCK) throw new WeixinMediaError('bad-key', 'An iLink media key is exactly 16 bytes')
  const filekey = randomBytes(AES_BLOCK).toString('hex')
  const cipher = encryptMedia(data, key)
  const ticket = await api.getUploadUrl({ filekey, mediaType: input.mediaType ?? MEDIA_IMAGE, toUserId: input.toUserId,
    rawSize: data.length, rawMd5: createHash('md5').update(data).digest('hex'), cipherSize: cipher.length, aesKeyHex: key.toString('hex') })
  const base = input.cdnBaseUrl ?? CDN_BASE_URL
  const url = ticket.uploadFullUrl || (ticket.uploadParam
    ? `${base}/upload?encrypted_query_param=${encodeURIComponent(ticket.uploadParam)}&filekey=${encodeURIComponent(filekey)}` : '')
  if (!url) throw new WeixinMediaError('protocol', 'getUploadUrl returned neither upload_full_url nor upload_param')
  const response = await transport.request(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: cipher })
  if (response.status < 200 || response.status >= 300) throw new WeixinMediaError('http',
    `The media upload answered HTTP ${response.status}`, response.status)
  const param = headerOf(response.headers, 'x-encrypted-param')
  if (!param) throw new WeixinMediaError('protocol', 'The media upload did not return an x-encrypted-param header', response.status)
  return { encryptQueryParam: param, aesKeyBase64: mediaKeyField(key), ciphertextSize: cipher.length, rawSize: data.length }
}
/**
 * Downloads and decrypts one inbound image. `maxBytes` bounds both the encrypted reply (plus one AES block of padding) and
 * the decrypted file, so a hostile item cannot fill the disk.
 *
 * The URL is `full_url` when the item has one, else the legacy `{cdnBaseUrl}/download?encrypted_query_param=…` — the same
 * rule as the official plugin's `downloadAndDecryptBuffer` and `buildCdnDownloadUrl`.
 */
export async function downloadMedia(transport: CdnTransport,
  input: { media: CdnMedia; maxBytes: number; cdnBaseUrl?: string }): Promise<{ data: Buffer; mime?: ImageMime; ext?: string }> {
  const keyText = input.media.aesKey?.trim() ?? ''
  if (!keyText) throw new WeixinMediaError('no-key', 'The inbound media item carries no AES key')
  const key = resolveMediaKey(keyText)
  const base = input.cdnBaseUrl ?? CDN_BASE_URL
  const url = input.media.fullUrl?.trim() || (input.media.encryptQueryParam?.trim()
    ? `${base}/download?encrypted_query_param=${encodeURIComponent(input.media.encryptQueryParam.trim())}` : '')
  if (!url) throw new WeixinMediaError('no-url', 'The inbound media item carries neither full_url nor encrypt_query_param')
  const response = await transport.request(url, { method: 'GET', maxBytes: input.maxBytes + AES_BLOCK })
  if (response.status < 200 || response.status >= 300) throw new WeixinMediaError('http',
    `The media download answered HTTP ${response.status}`, response.status)
  const data = decryptMedia(response.body, key)
  if (data.length > input.maxBytes) throw new WeixinMediaError('too-large',
    `The downloaded media is larger than the Media size limit of ${input.maxBytes} bytes`)
  const image = sniffImage(data)
  return { data, ...image ? { mime: image.mime, ext: image.ext } : {} }
}

/** One received image kept under the media directory; `key` is the file name an assessment reads by. */
export interface StoredMedia { key: string; path: string; mime: ImageMime; bytes: number }
const StoredMediaSchema = z.object({ key: z.string().min(1), path: z.string().min(1), mime: z.string().min(1),
  bytes: z.number().int().nonnegative() })
/** The images a Trigger's own message stored, as its `meta.images` records them; anything else is not one of ours. */
export function storedImages(trigger: Pick<Trigger, 'meta'>): StoredMedia[] {
  const parsed = z.array(StoredMediaSchema).safeParse(trigger.meta.images)
  return parsed.success ? parsed.data as StoredMedia[] : []
}
/** The state directory a configured media directory resolves against, absolute as given. */
export const mediaDirectory = (stateDir: string, configured: string): string =>
  isAbsolute(configured) ? resolvePath(configured) : resolvePath(stateDir, configured)
/**
 * Stores one received image under `directory`, named by a hash of its bytes so the same picture is stored once. Nothing
 * here deletes anything: the media lifecycle is reporting plus a person's own cleanup.
 */
export function storeMedia(input: { directory: string; data: Uint8Array; maxBytes: number }): StoredMedia {
  const data = Buffer.from(input.data)
  if (data.length > input.maxBytes) throw new WeixinMediaError('too-large',
    `The received media is larger than the Media size limit of ${input.maxBytes} bytes`)
  const image = sniffImage(data)
  if (!image) throw new WeixinMediaError('not-image', 'The received media is not a PNG, JPEG, WebP or GIF image')
  const key = `weixin-${createHash('sha256').update(data).digest('hex').slice(0, 32)}${image.ext}`
  const path = join(input.directory, key)
  try {
    mkdirSync(input.directory, { recursive: true, mode: 0o700 })
    if (!existsSync(path)) {
      const temporary = `${path}.tmp-${process.pid}`
      writeFileSync(temporary, data, { mode: 0o600 })
      renameSync(temporary, path)
    }
  } catch (error) {
    throw new WeixinMediaError('store', `The received image could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { key, path, mime: image.mime, bytes: data.length }
}
/** The text reference one stored image adds to its message, which `mediaKeys` reads back and the client renders as `[图片]`. */
export const mediaMarker = (key: string): string => `[Image: ${key}]`
/** The keys of the stored images a message text references, in order, each once. */
export function mediaKeys(text: string): string[] {
  const pattern = /\[Image: (weixin-[0-9a-f]{8,64}\.(?:png|jpg|jpeg|gif|webp))\]/g
  return [...new Set([...text.matchAll(pattern)].map(match => match[1]!))]
}

/** What the media directory holds, for the Source's health entry: never a deletion list, only a report. */
export interface MediaReport { directory: string; files: number; bytes: number; stale: number }
/**
 * Counts the stored media and the files older than `retentionMs`. Cleanup is deliberately left to a person, so the Source
 * reports rather than deletes; the count keeps growth visible instead of silent.
 */
export function mediaReport(input: { directory: string; retentionMs: number; now: number }): MediaReport {
  let names: string[]
  try { names = readdirSync(input.directory) } catch { return { directory: input.directory, files: 0, bytes: 0, stale: 0 } }
  let files = 0, bytes = 0, stale = 0
  for (const name of names) {
    if (!/^weixin-[0-9a-f]+\.(?:png|jpg|jpeg|gif|webp)$/.test(name)) continue
    try {
      const info = statSync(join(input.directory, name))
      if (!info.isFile()) continue
      files += 1
      bytes += info.size
      if (input.now - info.mtimeMs > input.retentionMs) stale += 1
    } catch { /* A file that vanished between the listing and the stat is simply not counted. */ }
  }
  return { directory: input.directory, files, bytes, stale }
}
/** Whether `path` is `root` or under it, so a stored path cannot leave the state directory. */
export const within = (root: string, path: string): boolean => {
  const base = resolvePath(root), target = resolvePath(path)
  return target === base || target.startsWith(base + sep)
}