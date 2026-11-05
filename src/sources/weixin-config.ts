/** Configuration of the Weixin (iLink Bot) Source: the saved login file and the tunables of the protocol calls. */
import { z } from 'zod'
import { DEFAULT_BASE_URL } from './weixin-api.ts'

export const WeixinConfigSchema = z.object({
  /** Where the confirmed login is kept, relative to the state directory or absolute; the QR image sits beside it. */
  credentials: z.string().trim().min(1).max(200).default('weixin-bot.json'),
  baseUrl: z.url().default(DEFAULT_BASE_URL),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  longPollTimeoutMs: z.number().int().min(5000).max(120000).default(40000),
  qrTimeoutMinutes: z.number().int().min(1).max(60).default(8),
}).strict()
export type WeixinConfig = z.infer<typeof WeixinConfigSchema>