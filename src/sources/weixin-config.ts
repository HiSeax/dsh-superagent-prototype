/** Configuration of the Weixin (iLink Bot) Source: the saved login file, the protocol tunables, and the media limits. */
import { z } from 'zod'
import { DEFAULT_BASE_URL } from './weixin-api.ts'
import { CDN_BASE_URL, MEDIA_DIR } from './weixin-media.ts'

/** The default media size limit: the references size inbound media at up to 100 MiB, which is far more than an image a model needs. */
export const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024
/** How long a received image is expected to stay before a person clears it; the Source reports older files, it never deletes them. */
export const DEFAULT_MEDIA_RETENTION_DAYS = 14

export const WeixinConfigSchema = z.object({
  /** Where the confirmed login is kept, relative to the state directory or absolute; the QR image sits beside it. */
  credentials: z.string().trim().min(1).max(200).default('weixin-bot.json'),
  baseUrl: z.url().default(DEFAULT_BASE_URL),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  longPollTimeoutMs: z.number().int().min(5000).max(120000).default(40000),
  qrTimeoutMinutes: z.number().int().min(1).max(60).default(8),
  /** Where received images are kept, relative to the state directory or absolute; files are named by content hash. */
  mediaDir: z.string().trim().min(1).max(200).default(MEDIA_DIR),
  /** The largest image this Source downloads or sends, in bytes; a larger one is refused, not truncated. */
  maxMediaBytes: z.number().int().min(64 * 1024).max(100 * 1024 * 1024).default(DEFAULT_MAX_MEDIA_BYTES),
  /** The WeChat CDN that carries media; only a deployment mirroring iLink elsewhere changes it. */
  cdnBaseUrl: z.url().default(CDN_BASE_URL),
  /** Age at which a stored image is reported as due for cleanup; the Source never deletes it. */
  mediaRetentionDays: z.number().int().min(1).max(365).default(DEFAULT_MEDIA_RETENTION_DAYS),
}).strict()
export type WeixinConfig = z.infer<typeof WeixinConfigSchema>