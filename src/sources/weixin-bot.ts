/**
 * The Weixin (iLink Bot) Source's runtime: saved login, QR login state machine, long-poll intake, and idempotent replies.
 *
 * Alignment: `@tencent-weixin/openclaw-weixin@2.4.6` (npm, 2026-06-22) as documented by zhayujie/CowAgent
 * `channel/weixin/{weixin_channel.py,weixin_api.py}` and SiverKing/weixin-ClawBot-API `weixin-openclaw-api-py-docs.md`.
 * The protocol is not a published, stability-promised specification; every client policy taken from those references
 * (refresh limits, backoff, retry windows) is marked "推定，未验证" where it matters.
 *
 * Two hard rules of this Source, both from the references:
 * - iLink lets the bot push a message only within 24 hours of the person's last inbound message. A deferred reply may
 *   therefore be rejected; the rejection is reported on the `weixin-send` health entry with the instruction to have the
 *   person message the bot again, never dropped silently. (The protocol documents no distinct error code for the window,
 *   so any non-zero business failure of a send is reported with that hint; 推定，未验证.)
 * - `ret`/`errcode` `-14` means the bot token is stale: stop business calls and run one controlled QR login, not a tight
 *   retry loop. A failed login is left for a restart instead of issuing QR codes nobody scans.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { OutboundAttachment, OutboundMessage } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, type SourceContext } from './host.ts'
import { DEFAULT_BASE_URL, WeixinApi, fetchQrCode, isAuthError, pollQrStatus, type Fetcher, type QrStatus } from './weixin-api.ts'
import type { WeixinConfig } from './weixin-config.ts'
import { loginQr, type LoginQrFiles } from './weixin-qr.ts'
import { downloadMedia, isImageMime, mediaDirectory, mediaFailureText, mediaReport, mediaUrlLabel, nodeCdnTransport, sniffImage,
  storeMedia, uploadMedia, MEDIA_IMAGE, type CdnTransport, type StoredMedia } from './weixin-media.ts'
import { SOURCE, WeixinMessageSchema, inboundImages, weixinTrigger, type WeixinMessage } from './weixin-trigger.ts'

/** Login state of the Source: the saved token, the pending QR scan, or the error that stopped it. */
export const WEIXIN_LOGIN = 'weixin'
/** Health of the `getUpdates` long poll. */
export const WEIXIN_POLL = 'weixin-poll'
/** Health of replies, including the 24-hour send window. */
export const WEIXIN_SEND = 'weixin-send'
/** Health of received media: how many images are stored, and how many are past the retention; nothing is ever deleted. */
export const WEIXIN_MEDIA = 'weixin-media'
/** The health entries the kind claims, in display order. */
export const WEIXIN_HEALTH = [WEIXIN_LOGIN, WEIXIN_POLL, WEIXIN_SEND, WEIXIN_MEDIA]
/** `MessageItem` text is chunked at 4000 characters, the limit CowAgent's Weixin channel sends. */
const TEXT_CHUNK = 4000
/** How many images one message may carry in either direction; more are counted as unread and reported, not sent. */
const MAX_IMAGES = 4
/** The references refresh an expired QR code at most three times before ending the login attempt. 推定，未验证. */
const QR_MAX_REFRESHES = 3
/** A single QR status poll holds about 35 s on the server; the client waits slightly longer, as the references do. */
const QR_STATUS_TIMEOUT = 40_000
/** Poll retry policy of the references: 2 s, and 30 s once three attempts in a row failed. 推定，未验证. */
const POLL_RETRY_MS = 2_000
const POLL_BACKOFF_MS = 30_000
/** How long a disabled or unconfigured Source waits before re-reading its settings. */
const IDLE_MS = 30_000
/** The saved login of one confirmed scan, in the credentials file. */
export interface WeixinCredentials { token: string; baseUrl: string; botId: string; userId?: string }
/** Replaceable integrations, so tests drive the whole runtime without a network or a real clock. */
export interface WeixinBotOptions {
  fetcher?: Fetcher
  now?: () => number
  /** Pause between poll attempts; resolves after `ms`, or earlier when `signal` aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
  /** One QR status long-poll timeout; tests shorten it. */
  qrPollTimeoutMs?: number
  /** The whole QR login lifetime; overrides the configured minutes in tests. */
  qrTimeoutMs?: number
  /** The CDN transport for media; tests answer uploads and downloads through it instead of a network call. */
  cdn?: CdnTransport
  /** A warning sink for media failures, such as the plugin's logger; the line names the message and never a CDN token. */
  log?: (line: string) => void
}
const describe = (error: unknown): string => error instanceof Error ? `${error.name}: ${error.message}` : String(error)
/**
 * Splits reply text into the protocol's message-sized chunks, preferring a paragraph or line boundary the way CowAgent
 * does; only chunks with content are returned, so an empty reply is the caller's error, not a silent send.
 */
export function chunkText(text: string, limit = TEXT_CHUNK): string[] {
  if (text.length <= limit) return text ? [text] : []
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    const chunk = rest.slice(0, cut)
    if (chunk) chunks.push(chunk)
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * One Weixin Source instance: the login it saved, the API client built from it, the poll cursor and the outbound path.
 * The plugin entry attaches a `SourceContext`; until then every operation that needs it fails cleanly instead of touching
 * the host, and nothing is started unless the plugin itself is enabled.
 */
export class WeixinBot {
  private context?: SourceContext
  private credentials?: WeixinCredentials
  private api?: WeixinApi
  private pollFailures = 0
  private received = 0
  private qr?: LoginQrFiles
  private readonly fetcher: Fetcher
  private readonly clock: () => number
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly qrPollTimeoutMs: number
  private readonly qrTimeoutMs?: number
  private readonly cdn: CdnTransport
  private readonly log: (line: string) => void
  constructor(options: WeixinBotOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch as unknown as Fetcher
    this.clock = options.now ?? (() => Date.now())
    this.wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }).then(() => {}, () => {}))
    this.qrPollTimeoutMs = options.qrPollTimeoutMs ?? QR_STATUS_TIMEOUT
    this.qrTimeoutMs = options.qrTimeoutMs
    this.cdn = options.cdn ?? nodeCdnTransport
    this.log = options.log ?? (() => {})
  }
  /** Gives the bot the Source context of the active plugin instance; the entry detaches it when the plugin unloads. */
  attach(context: SourceContext): void { this.context = context }
  detach(): void { this.context = undefined; this.api = undefined; this.credentials = undefined }
  private ctx(): SourceContext {
    if (!this.context) throw new Error('The Weixin Source is not attached to dsh-superagent')
    return this.context
  }
  /** Configuration while the Source instance is enabled, or undefined while it is off or uninstalled. */
  private config(): WeixinConfig | undefined { return this.context?.config<WeixinConfig>(SOURCE) }
  private stateDir(): string { return this.ctx().deployment.stateDir }
  private credentialsPath(config: WeixinConfig): string {
    return isAbsolute(config.credentials) ? config.credentials : resolve(this.stateDir(), config.credentials)
  }
  /** The directory received images are stored in; its name and limit are configuration, not constants of the protocol. */
  private mediaDir(config: WeixinConfig): string { return mediaDirectory(this.stateDir(), config.mediaDir) }
  /** The pending QR files of the last login attempt, for the panel's health detail and tests. */
  qrFiles(): LoginQrFiles | undefined { return this.qr }
  /** Reads the confirmed login; undefined when the file is absent, corrupt or has no token. */
  readCredentials(): WeixinCredentials | undefined {
    const config = this.config()
    if (!config) return undefined
    try {
      const raw = JSON.parse(readFileSync(this.credentialsPath(config), 'utf8')) as Record<string, unknown>
      const token = typeof raw.token === 'string' ? raw.token : '', botId = typeof raw.botId === 'string' ? raw.botId : ''
      if (!token || !botId) return undefined
      return { token, botId, baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : config.baseUrl,
        ...typeof raw.userId === 'string' ? { userId: raw.userId } : {} }
    } catch { return undefined }
  }
  /** Writes the login atomically (temp file + rename), so a stopped process never leaves half a credentials file. */
  private writeCredentials(config: WeixinConfig, credentials: WeixinCredentials): void {
    const path = this.credentialsPath(config)
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  }
  /** Moves a stale login out of the way (no deletion) so a fresh scan can start; the old file stays for inspection. */
  private expireCredentials(config: WeixinConfig): void {
    const path = this.credentialsPath(config)
    try { if (existsSync(path)) renameSync(path, `${path}.expired-${this.clock()}`) }
    catch { /* A move that fails only costs keeping the unusable file; the login below decides the outcome. */ }
    this.credentials = undefined
    this.api = undefined
  }
  /**
   * Builds the API client from the saved login. False when no usable login is stored, which is the signal to scan.
   * Public so a test can exercise the outbound path without running the loops.
   */
  connect(): boolean {
    const config = this.config()
    if (!config) return false
    const credentials = this.readCredentials()
    if (!credentials) return false
    this.credentials = credentials
    this.api = new WeixinApi(credentials.baseUrl, credentials.token, this.fetcher,
      { request: config.requestTimeoutMs, longPoll: config.longPollTimeoutMs })
    return true
  }
  /**
   * Sends one reply into a direct chat once per OutboundMessage id. `client_id` carries the same derived id on a retry
   * (推定，未验证 whether iLink deduplicates it), and the delivered-id records in `KV.weixin.sent` make a local retry a
   * no-op regardless. A stale token re-reports the login state; any other business failure reports the 24-hour window.
   * @throws when the reply could not be delivered; Outbox retries, and the health entry names why.
   */
  async send(message: OutboundMessage): Promise<'sent' | 'gone'> {
    const context = this.ctx()
    const userId = message.channel.address.userId
    if (!userId) throw new Error('Missing WeChat reply target')
    const text = message.text.trim()
    const attachments = message.attachments ?? []
    if (!text && !attachments.length) throw new Error('A WeChat reply needs text or an image')
    if (attachments.length > MAX_IMAGES) throw new Error(`A WeChat reply carries at most ${MAX_IMAGES} images`)
    const contextToken = context.state.get(KV.weixin.context(userId))
    if (!contextToken) {
      this.failSend('this person has no context token yet, which iLink stores from their latest message')
      throw new Error('The iLink send has no context token for this sender yet')
    }
    if (!this.api && !this.connect()) {
      this.failSend('the Weixin bot is not logged in')
      throw new Error('The Weixin bot is not logged in; scan the QR code shown on the Source card')
    }
    const api = this.api!
    const chunks = chunkText(text)
    for (const [index, chunk] of chunks.entries()) {
      const replyId = chunks.length === 1 ? message.id : `${message.id}#${index}`
      if (context.state.get(KV.weixin.sent(replyId))) continue
      try {
        await api.sendText(userId, chunk, contextToken, `dsh-superagent-${replyId}`)
      } catch (error) {
        if (isAuthError(error)) {
          context.report(WEIXIN_LOGIN, { state: 'error', at: this.stamp(), detail: 'The bot token is stale; scan the QR code again' })
        }
        this.failSend(describe(error))
        throw error
      }
      context.state.set(KV.weixin.sent(replyId), true)
    }
    for (const [index, attachment] of attachments.entries()) {
      // An image travels as its own message, once per message id, as the references send media.
      const replyId = `${message.id}@image-${index}`
      if (context.state.get(KV.weixin.sent(replyId))) continue
      try {
        await this.sendImage(api, userId, contextToken, attachment, `dsh-superagent-image-${replyId}`)
      } catch (error) {
        if (isAuthError(error)) {
          context.report(WEIXIN_LOGIN, { state: 'error', at: this.stamp(), detail: 'The bot token is stale; scan the QR code again' })
        }
        this.failSend(describe(error))
        throw error
      }
      context.state.set(KV.weixin.sent(replyId), true)
    }
    context.report(WEIXIN_SEND, { state: 'ready', at: this.stamp(), detail: 'The last reply was delivered' })
    return 'sent'
  }
  /**
   * Uploads one local image to the WeChat CDN and sends it as an `image_item`. Only the image types a model reads are
   * carried, and the configured size limit applies before anything is encrypted or uploaded.
   */
  private async sendImage(api: WeixinApi, userId: string, contextToken: string, attachment: OutboundAttachment, clientId: string): Promise<void> {
    const config = this.config()
    if (!config) throw new Error('The Weixin Source is not configured')
    if (attachment.mime && !isImageMime(attachment.mime)) throw new Error(`WeChat cannot carry ${attachment.mime}; only PNG, JPEG, WebP and GIF images are supported`)
    const data = readFileSync(attachment.path)
    if (data.length > config.maxMediaBytes) throw new Error(`the image is larger than the Media size limit of ${config.maxMediaBytes} bytes`)
    const image = sniffImage(data)
    if (!image) throw new Error(`the file ${attachment.path} is not a PNG, JPEG, WebP or GIF image`)
    const upload = await uploadMedia(api, this.cdn, { data, toUserId: userId, mediaType: MEDIA_IMAGE, cdnBaseUrl: config.cdnBaseUrl })
    await api.sendImage(userId, contextToken, clientId, { encryptQueryParam: upload.encryptQueryParam,
      aesKeyBase64: upload.aesKeyBase64, ciphertextSize: upload.ciphertextSize })
  }
  private failSend(detail: string): void {
    this.context?.report(WEIXIN_SEND, { state: 'error', at: this.stamp(),
      detail: `Could not send the reply: ${detail}. iLink lets the bot push only within 24 hours of the person's last message, so they must send the bot another message to reopen the window.` })
  }
  private stamp(): string { return new Date(this.clock()).toISOString() }
  private reportLogin(state: 'starting' | 'ready' | 'paused' | 'error', detail: string): void {
    this.context?.report(WEIXIN_LOGIN, { state, detail, at: this.stamp() })
  }
  private reportPoll(state: 'starting' | 'ready' | 'paused' | 'error', detail: string, values?: Record<string, string>): void {
    this.context?.report(WEIXIN_POLL, values ? { state, detail, at: this.stamp(), ...values } : { state, detail, at: this.stamp() })
  }
  /**
   * Runs the QR login until a scan confirms or the attempt must stop. The QR image and link are written beside the
   * credentials file and named in the health detail; a pairing code cannot be entered from the management panel, so a
   * login that asks for one ends with that instruction (推定，未验证: this version offers no pairing-code input).
   */
  async login(signal: AbortSignal): Promise<boolean> {
    const context = this.ctx()
    const config = this.config()
    if (!config) return false
    const saved = this.readCredentials()
    const localTokens = saved?.token ? [saved.token] : []
    const base = saved?.baseUrl || config.baseUrl || DEFAULT_BASE_URL
    const deadline = this.clock() + (this.qrTimeoutMs ?? config.qrTimeoutMinutes * 60_000)
    let refreshes = 0
    this.reportLogin('starting', 'Requesting a login QR code')
    while (!signal.aborted) {
      let ticket: { qrcode: string; url: string }
      try {
        ticket = await fetchQrCode(this.fetcher, base, localTokens, config.requestTimeoutMs)
      } catch (error) {
        this.reportLogin('error', `Could not get a login QR code: ${describe(error)}`)
        return false
      }
      try {
        this.qr = loginQr(this.stateDir(), ticket.url)
      } catch (error) {
        this.reportLogin('error', `Could not write the login QR code: ${describe(error)}`)
        return false
      }
      const qr = this.qr
      this.reportLogin('starting', `Waiting for the QR scan; the image is ${qr.png} and its link is ${qr.url}`)
      let pollBase = base, scanned = false, expired = false
      while (!signal.aborted && this.clock() < deadline) {
        let status: QrStatus
        try {
          status = await pollQrStatus(this.fetcher, pollBase, ticket.qrcode, this.qrPollTimeoutMs)
        } catch (error) {
          this.reportLogin('error', `The QR login status poll failed: ${describe(error)}`)
          return false
        }
        if (status.status === 'scaned') {
          if (!scanned) { scanned = true; this.reportLogin('starting', 'The QR code was scanned; confirm the login on the phone') }
        } else if (status.status === 'scaned_but_redirect') {
          const host = (status.redirect_host ?? '').trim()
          if (host) pollBase = /^https?:\/\//i.test(host) ? host : `https://${host}`
        } else if (status.status === 'expired' || status.status === 'verify_code_blocked') {
          expired = true
          break
        } else if (status.status === 'need_verifycode') {
          this.reportLogin('error', 'WeChat asked for a pairing code, which this Source cannot enter; start the login again later')
          return false
        } else if (status.status === 'binded_redirect') {
          // 推定，未验证: the references only accept this status when a local token is kept; this path has none.
          this.reportLogin('error', 'This WeChat account is already bound to another client; remove it there and scan again')
          return false
        } else if (status.status === 'confirmed') {
          const token = status.bot_token ?? '', botId = status.ilink_bot_id ?? ''
          if (!token || !botId) {
            this.reportLogin('error', 'WeChat confirmed the login without a token; scan again')
            return false
          }
          this.writeCredentials(config, { token, botId, baseUrl: status.baseurl || base,
            ...status.ilink_user_id ? { userId: status.ilink_user_id } : {} })
          this.credentials = undefined
          this.api = undefined
          this.reportLogin('ready', `Logged in as ${botId}`)
          return true
        }
      }
      if (signal.aborted) return false
      if (!expired) {
        this.reportLogin('error', 'The QR login did not finish in time; restart dsh-superagent to request a new code')
        return false
      }
      refreshes += 1
      if (refreshes > QR_MAX_REFRESHES) {
        this.reportLogin('error', `The QR code expired ${QR_MAX_REFRESHES + 1} times without a scan; restart dsh-superagent to try again`)
        return false
      }
      this.reportLogin('starting', `The QR code expired; requesting a new one (${refreshes}/${QR_MAX_REFRESHES})`)
    }
    return false
  }
  /**
   * Long-polls updates until the token goes stale or the Source stops. Ordinary failures back off and are reported, never
   * turned into a tight retry loop; a successful batch re-reads the cursor before the next poll.
   */
  async poll(signal: AbortSignal): Promise<'auth' | 'aborted'> {
    const context = this.ctx()
    const botId = this.credentials?.botId ?? ''
    const saved = context.state.get(KV.weixin.cursor)
    // 推定，未验证: a cursor belongs to the account that produced it, so a re-scan (new bot id) starts from an empty one.
    let cursor = saved && saved.botId === botId ? saved.buf : ''
    this.pollFailures = 0
    this.reportPoll('starting', 'Waiting for the first messages')
    while (!signal.aborted) {
      let page: Awaited<ReturnType<WeixinApi['updates']>>
      try {
        page = await this.api!.updates(cursor)
      } catch (error) {
        if (isAuthError(error)) {
          this.reportPoll('error', 'The bot token is stale; a new QR login is needed')
          return 'auth'
        }
        this.pollFailures += 1
        // Three failures in a row need a person; the fixed pollFailures text is worded by the panel.
        if (this.pollFailures >= 3) this.context?.report(WEIXIN_POLL,
          { ...health('error', 'pollFailures', { count: String(this.pollFailures), error: describe(error) }), at: this.stamp() })
        else this.reportPoll('starting', `${this.pollFailures} failed poll(s); last: ${describe(error)}`)
        await this.wait(this.pollFailures < 3 ? POLL_RETRY_MS : POLL_BACKOFF_MS, signal)
        continue
      }
      this.pollFailures = 0
      if (page.cursor) {
        cursor = page.cursor
        context.state.set(KV.weixin.cursor, { botId, buf: cursor })
      }
      for (const raw of page.msgs) await this.accept(raw)
      this.reportPoll('ready', `Listening to direct messages; ${this.received} received`)
    }
    return 'aborted'
  }
  /** Stores what a reply needs from one inbound message, then hands its Trigger to the Engine. */
  private async accept(raw: unknown): Promise<void> {
    const context = this.context
    if (!context) return
    const parsed = WeixinMessageSchema.safeParse(raw)
    if (!parsed.success) return
    const message = parsed.data
    if (message.group_id) return // iLink's send path has no group branch; the official plugin declares direct chats only.
    if (!message.from_user_id) return
    if (message.context_token) context.state.set(KV.weixin.context(message.from_user_id), message.context_token)
    context.state.set(KV.weixin.inbound(message.from_user_id), this.stamp())
    const images = await this.acceptImages(message)
    const trigger = weixinTrigger(message, this.clock, images.media, images.failures)
    if (!trigger) return
    this.received += 1
    await context.receive(trigger)
  }
  /**
   * Downloads, decrypts and stores the images of one message before its Trigger is built, so the Trigger can name them and
   * its assessment can read them. A failure is turned into a short stage name that the Trigger text carries
   * (`[图片: 获取失败 HTTP 403]`), reported on the media health entry, and logged with the message id and the URL's origin
   * only — never the encrypted query parameter. The size and count limits apply before anything is decrypted or written.
   */
  private async acceptImages(message: WeixinMessage): Promise<{ media: StoredMedia[]; failures: string[] }> {
    const refs = inboundImages(message.item_list)
    const config = this.config()
    if (!refs.length) return { media: [], failures: [] }
    if (!config) return { media: [], failures: refs.map(() => '来源未配置') }
    const directory = this.mediaDir(config)
    const media: StoredMedia[] = []
    const failures: string[] = refs.slice(MAX_IMAGES).map(() => '数量超出上限')
    const details = failures.map(reason => `${reason}: more than ${MAX_IMAGES} images in one message`)
    const messageId = String(message.message_id ?? message.seq ?? '(无 id)')
    for (const ref of refs.slice(0, MAX_IMAGES)) {
      try {
        const download = await downloadMedia(this.cdn, { media: ref, maxBytes: config.maxMediaBytes, cdnBaseUrl: config.cdnBaseUrl })
        media.push(storeMedia({ directory, data: download.data, maxBytes: config.maxMediaBytes }))
      } catch (error) {
        const reason = mediaFailureText(error)
        failures.push(reason)
        details.push(`${reason}: ${describe(error)}`)
        // The key itself is never logged; its source and length are enough to tell a wrong field from a wrong encoding.
        this.log(`image failed message=${messageId} url=${mediaUrlLabel(ref)} aeskey=${ref.aesKeySource ?? 'none'} keyLength=${ref.aesKey?.length ?? 0} reason=${reason}: ${describe(error)}`)
      }
    }
    // A success report says what the store holds; a failure report comes after it, so the entry keeps the reason a
    // person debugging the picture needs instead of being replaced by a later "ready".
    if (media.length) this.reportMedia(config)
    if (details.length) this.reportMediaError(details.join('; '))
    return { media, failures }
  }
  /**
   * Reports what the media directory holds, and how many files are past the retention. Cleanup is a person's action: this
   * Source never deletes received files, so the count stays visible instead of the directory growing silently.
   */
  private reportMedia(config: WeixinConfig): void {
    const report = mediaReport({ directory: this.mediaDir(config), retentionMs: config.mediaRetentionDays * 86_400_000, now: this.clock() })
    this.context?.report(WEIXIN_MEDIA, { state: 'ready', at: this.stamp(), values: {
      files: String(report.files), bytes: String(report.bytes), stale: String(report.stale), directory: report.directory },
    detail: `${report.files} received image(s), ${(report.bytes / 1_048_576).toFixed(1)} MiB, in ${report.directory}; ${report.stale} are older than ${config.mediaRetentionDays} days. The Source never deletes them, so clear that directory yourself when it grows.` })
  }
  private reportMediaError(detail: string): void {
    this.context?.report(WEIXIN_MEDIA, { state: 'error', at: this.stamp(), detail: `Could not receive an image: ${detail}` })
  }
  /**
   * The Source's lifecycle: wait for setup, then keep the saved login alive. A stale token starts one controlled QR login;
   * a login that does not finish leaves the error on the health entry and stops instead of issuing codes nobody scans.
   */
  async run(signal: AbortSignal): Promise<void> {
    const context = this.ctx()
    await context.ready
    while (!signal.aborted) {
      if (!context.configured()) {
        this.context?.report(WEIXIN_LOGIN, { ...health('paused', 'setupPending'), at: this.stamp() })
        this.context?.report(WEIXIN_POLL, { ...health('paused', 'setupPending'), at: this.stamp() })
        await this.wait(IDLE_MS, signal)
        continue
      }
      if (!this.config()) {
        this.context?.report(WEIXIN_LOGIN, { ...health('paused', 'sourceOff'), at: this.stamp() })
        this.context?.report(WEIXIN_POLL, { ...health('paused', 'sourceOff'), at: this.stamp() })
        await this.wait(IDLE_MS, signal)
        continue
      }
      if (!this.connect()) {
        const loggedIn = await this.login(signal)
        if (!loggedIn || signal.aborted) return
        if (!this.connect()) return
      }
      const credentials = this.credentials!
      this.reportLogin('ready', `Logged in as ${credentials.botId}`)
      // Best-effort lifecycle notices, 推定，未验证: the references say a failure must not block the message loop.
      await this.api!.notify('start').catch(() => {})
      const outcome = await this.poll(signal)
      await this.api!.notify('stop').catch(() => {})
      if (signal.aborted) return
      if (outcome !== 'auth') return
      const config = this.config()
      if (config) this.expireCredentials(config)
      this.reportLogin('error', 'The bot token expired; requesting a new login QR code')
      // The loop's next pass scans again.
    }
  }
}