/**
 * Tests the Weixin media path without a network or a WeChat account: the AES-128-ECB envelope, the upload request and
 * ciphertext, inbound download and key encodings, the size limits, the stored-media layout, the failure branches, and the
 * inbound and outbound paths through the bot's own poll and send loops.
 */
import { createCipheriv, createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import type { FetchResponse, Fetcher, UploadUrlRequest } from '../src/sources/weixin-api.ts'
import { WEIXIN_LOGIN, WEIXIN_MEDIA, WEIXIN_SEND, WEIXIN_UPLOAD, WeixinBot } from '../src/sources/weixin-bot.ts'
import { WeixinConfigSchema, type WeixinConfig } from '../src/sources/weixin-config.ts'
import { weixinThreadContext } from '../src/sources/weixin-read.ts'
import { SOURCE, inboundImages, mediaFailureMarker } from '../src/sources/weixin-trigger.ts'
import { decryptMedia, downloadMedia, encryptMedia, mediaFailureText, mediaKeys, mediaKeyField, mediaReport, paddedMediaSize,
  resolveMediaKey, sniffImage, storeMedia, uploadMedia, WeixinMediaError, type CdnResponse, type CdnTransport } from '../src/sources/weixin-media.ts'

const CONFIG: WeixinConfig = WeixinConfigSchema.parse({})
const NOW = Date.parse('2026-11-06T01:00:00Z')
const directoryOf = () => mkdtempSync(join(tmpdir(), 'weixin-media-'))
/** A file whose first bytes are a JPEG's, which is all `sniffImage` reads. */
const jpeg = (size = 32): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), Buffer.alloc(Math.max(0, size - 8), 0x11)])
/** Encrypts with Node's own PKCS#7 padding, independent of the module's implementation, so the two can be compared. */
const encryptWith = (data: Buffer, keyHex: string): Buffer => {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}
interface Call { url: string; method: string; headers: Record<string, string>; body: string }
/** A `fetch` stand-in for the iLink API: records every request and answers from `answer`. */
function transport(answer: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = []
  const fetcher: Fetcher = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ?? '' }
    calls.push(call)
    const reply = answer(call)
    return { status: reply.status ?? 200, text: async () => JSON.stringify(reply.body ?? {}) } as FetchResponse
  }
  return { calls, fetcher }
}
/** A CDN transport answering every request from `answer`. */
function cdn(answer: (url: string, init: { method: string; body?: Uint8Array; headers?: Record<string, string> }) => CdnResponse) {
  const calls: { url: string; method: string; body: Buffer; headers: Record<string, string> }[] = []
  const cdnTransport: CdnTransport = { request: async (url, init) => {
    calls.push({ url, method: init.method, body: Buffer.from(init.body ?? []), headers: init.headers ?? {} })
    return answer(url, init)
  } }
  return { calls, cdn: cdnTransport }
}
/** A Source context over an in-memory state map and a temporary state directory. */
function host(directory: string, reports: Record<string, Health>, received: Trigger[] = []) {
  const state = new Map<string, unknown>()
  const context = { ready: Promise.resolve(), configured: () => true, deployment: { stateDir: directory },
    config: (id: string) => id === SOURCE ? CONFIG : undefined,
    state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => { if (value === undefined) state.delete(name); else state.set(name, value) } },
    receive: async (trigger: Trigger) => { received.push(trigger); return 'stored' as const },
    report: (entry: string, health: Health) => { reports[entry] = health } }
  return { context: context as unknown as SourceContext, state, received }
}
const saveLogin = (directory: string) => writeFileSync(join(directory, 'weixin-bot.json'),
  JSON.stringify({ token: 'token-1', botId: 'bot-1', baseUrl: 'https://ilinkai.weixin.qq.com' }))
const botOf = (fetcher: Fetcher, extra: Partial<ConstructorParameters<typeof WeixinBot>[0]> = {}) =>
  new WeixinBot({ fetcher, now: () => NOW, wait: async () => {}, qrPollTimeoutMs: 40, qrTimeoutMs: 60_000, ...extra })
const reply = (id = 'reply-1'): OutboundMessage => ({ id, channel: { source: 'weixin', thread: 'weixin:wxid_alice', address: { userId: 'wxid_alice' } },
  text: '收到，图见下。', kind: 'reply' })

describe('weixin media envelope', () => {
  it('is AES-128-ECB with PKCS#7, as the references decrypt it', () => {
    // FIPS-197 vector: key 2b7e…, plaintext 6bc1…, ciphertext 3ad7…; its last byte is 0x2a, not a pad length.
    const plain = Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex')
    const vector = Buffer.from('3ad77bb40d7a3660a89ecaf32466ef97', 'hex')
    expect(decryptMedia(vector, Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex'))).toEqual(plain)
    const data = Buffer.from('hello 微信')
    const encrypted = encryptMedia(data, Buffer.alloc(16, 1))
    expect(encrypted).toHaveLength(paddedMediaSize(data.length))
    expect(encrypted).toHaveLength(Math.ceil((data.length + 1) / 16) * 16)
    expect(decryptMedia(encrypted, Buffer.alloc(16, 1))).toEqual(data)
    expect(() => decryptMedia(Buffer.alloc(3), Buffer.alloc(16, 1))).toThrow('AES blocks')
    expect(() => encryptMedia(data, Buffer.alloc(8))).toThrow('16 bytes')
  })
  it('accepts every media key encoding in the references and writes the outbound one', () => {
    const raw = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    expect(resolveMediaKey(raw.toString('hex'))).toEqual(raw)
    expect(resolveMediaKey(raw.toString('base64'))).toEqual(raw)
    expect(resolveMediaKey(Buffer.from(raw.toString('hex')).toString('base64'))).toEqual(raw)
    expect(mediaKeyField(raw)).toBe(Buffer.from(raw.toString('hex')).toString('base64'))
    expect(() => resolveMediaKey('definitely-not-a-key')).toThrow('media key')
  })
  it('names the stage of a media failure for the Trigger text', () => {
    expect(mediaFailureText(new WeixinMediaError('http', 'x', 403))).toBe('HTTP 403')
    expect(mediaFailureText(new WeixinMediaError('no-key', 'x'))).toBe('缺少 aes_key')
    expect(mediaFailureText(new WeixinMediaError('bad-key', 'x'))).toBe('aes_key 解码')
    expect(mediaFailureText(new WeixinMediaError('too-large', 'x'))).toBe('超过大小上限')
    expect(mediaFailureText(new WeixinMediaError('tls', 'x'))).toBe('CDN TLS')
    expect(mediaFailureText(new Error('boom'))).toBe('未知错误')
  })
  it('reads the AES key where both references do: image_item.aeskey first, then media.aes_key, empty as absent', () => {
    const hex = '00112233445566778899aabbccddeeff'
    // The real-world shape: an empty media.aes_key must not shadow the item's hex key.
    expect(inboundImages([{ type: 2, image_item: { aeskey: hex, media: { encrypt_query_param: 'p', aes_key: '' } } }]))
      .toEqual([{ encryptQueryParam: 'p', aesKey: hex, aesKeySource: 'image_item.aeskey' }])
    const base64Raw = Buffer.from(hex, 'hex').toString('base64')
    expect(inboundImages([{ type: 2, image_item: { media: { encrypt_query_param: 'p', aes_key: base64Raw } } }])[0]!.aesKey).toBe(base64Raw)
    expect(inboundImages([{ type: 2, image_item: { media: { full_url: 'https://cdn.example.test/x', aes_key: base64Raw } } }])[0])
      .toEqual({ fullUrl: 'https://cdn.example.test/x', aesKey: base64Raw, aesKeySource: 'media.aes_key' })
    // protobuf JSON sends unset fields as null; that must not drop the item.
    expect(inboundImages([{ type: 2, image_item: { aeskey: null, media: { encrypt_query_param: 'p', aes_key: null } } }]))
      .toEqual([{ encryptQueryParam: 'p' }])
    expect(inboundImages([{ type: 2, image_item: {} }])).toEqual([{}])
    expect(inboundImages([{ type: 1, text_item: { text: 'hi' } }])).toEqual([])
  })
  it('sniffs only the image types a model reads', () => {
    expect(sniffImage(jpeg())).toEqual({ mime: 'image/jpeg', ext: '.jpg' })
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
    expect(sniffImage(png)).toEqual({ mime: 'image/png', ext: '.png' })
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeUndefined()
  })
})

describe('weixin media upload', () => {
  it('asks for a ticket, uploads the PKCS#7 ciphertext, and keeps the CDN download parameter', async () => {
    const requests = cdn(() => ({ status: 200, headers: { 'x-encrypted-param': 'download-param' }, body: Buffer.alloc(0) }))
    let ticket: UploadUrlRequest | undefined
    const api = { getUploadUrl: async (request: UploadUrlRequest) => { ticket = request; return { uploadParam: 'upload-param' } } }
    const data = jpeg(48)
    const uploaded = await uploadMedia(api, requests.cdn, { data, toUserId: 'wxid_alice' })
    expect(ticket).toMatchObject({ mediaType: 1, toUserId: 'wxid_alice', rawSize: data.length, rawMd5: createHash('md5').update(data).digest('hex'),
      cipherSize: paddedMediaSize(data.length) })
    expect(ticket!.aesKeyHex).toMatch(/^[0-9a-f]{32}$/)
    expect(requests.calls[0]!.url).toBe(`https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=upload-param&filekey=${ticket!.filekey}`)
    expect(requests.calls[0]!.method).toBe('POST')
    const ciphertext = requests.calls[0]!.body
    expect(ciphertext).toHaveLength(ticket!.cipherSize)
    expect(decryptMedia(ciphertext, Buffer.from(ticket!.aesKeyHex, 'hex'))).toEqual(data)
    expect(uploaded).toEqual({ encryptQueryParam: 'download-param', ciphertextSize: ciphertext.length, rawSize: data.length,
      aesKeyBase64: mediaKeyField(Buffer.from(ticket!.aesKeyHex, 'hex')) })
  })
  it('produces the exact wire envelope for a fixed key: AES-128-ECB/PKCS#7 body and base64(hex32) aes_key', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const plaintext = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('weixin image bytes')])
    const requests = cdn(() => ({ status: 200, headers: { 'x-encrypted-param': 'download-param' }, body: Buffer.alloc(0) }))
    let ticket: UploadUrlRequest | undefined
    const uploaded = await uploadMedia({
      getUploadUrl: async (request: UploadUrlRequest) => { ticket = request; return { uploadParam: 'upload-param' } },
    }, requests.cdn, { data: plaintext, toUserId: 'wxid_alice', aesKey: key })
    expect(ticket).toMatchObject({ mediaType: 1, rawSize: plaintext.length,
      rawMd5: createHash('md5').update(plaintext).digest('hex'), cipherSize: paddedMediaSize(plaintext.length), aesKeyHex: key.toString('hex') })
    // Crypto is computed by Node's own PKCS#7 padding, independently of the module's encryptMedia.
    const expected = encryptWith(plaintext, key.toString('hex'))
    expect(requests.calls[0]!.method).toBe('POST')
    expect(requests.calls[0]!.headers).toMatchObject({ 'Content-Type': 'application/octet-stream' })
    expect(requests.calls[0]!.body).toEqual(expected)
    expect(requests.calls[0]!.body.length).toBe(paddedMediaSize(plaintext.length))
    // The sendMessage field is base64 of the 32-character hex key, the form both references send.
    expect(uploaded).toEqual({ encryptQueryParam: 'download-param', ciphertextSize: expected.length, rawSize: plaintext.length,
      aesKeyBase64: Buffer.from(key.toString('hex')).toString('base64') })
  })
  it('prefers upload_full_url and surfaces a CDN refusal instead of a silent send', async () => {
    const requests = cdn(() => ({ status: 200, headers: { 'x-encrypted-param': 'param' }, body: Buffer.alloc(0) }))
    await uploadMedia({ getUploadUrl: async () => ({ uploadFullUrl: 'https://cdn.example.test/upload?ticket=1' }) }, requests.cdn,
      { data: jpeg(), toUserId: 'u' })
    expect(requests.calls[0]!.url).toBe('https://cdn.example.test/upload?ticket=1')
    const refused = cdn(() => ({ status: 400, headers: {}, body: Buffer.from('bad ticket') }))
    await expect(uploadMedia({ getUploadUrl: async () => ({ uploadParam: 'p' }) }, refused.cdn, { data: jpeg(), toUserId: 'u' }))
      .rejects.toThrow('HTTP 400')
    const silent = cdn(() => ({ status: 200, headers: {}, body: Buffer.alloc(0) }))
    await expect(uploadMedia({ getUploadUrl: async () => ({ uploadParam: 'p' }) }, silent.cdn, { data: jpeg(), toUserId: 'u' }))
      .rejects.toThrow('x-encrypted-param')
    await expect(uploadMedia({ getUploadUrl: async () => ({}) }, silent.cdn, { data: jpeg(), toUserId: 'u' }))
      .rejects.toThrow('neither upload_full_url nor upload_param')
  })
})

describe('weixin media download', () => {
  it('downloads by encrypt_query_param or full_url and decrypts with any key encoding', async () => {
    const raw = '00112233445566778899aabbccddeeff'
    const data = jpeg(64)
    const ciphertext = encryptWith(data, raw)
    const result = cdn(() => ({ status: 200, headers: {}, body: ciphertext }))
    for (const aesKey of [raw, Buffer.from(raw, 'utf8').toString('base64')]) {
      const downloaded = await downloadMedia(result.cdn, { media: { encryptQueryParam: 'param', aesKey }, maxBytes: 1024 })
      expect(downloaded.data).toEqual(data)
      expect(downloaded.mime).toBe('image/jpeg')
    }
    expect(result.calls[0]!.url).toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=param')
    expect(result.calls[0]!.method).toBe('GET')
    await downloadMedia(result.cdn, { media: { fullUrl: 'https://cdn.example.test/download?x=1', aesKey: raw }, maxBytes: 1024 })
    expect(result.calls.at(-1)!.url).toBe('https://cdn.example.test/download?x=1')
    await expect(downloadMedia(result.cdn, { media: { encryptQueryParam: 'param', aesKey: raw }, maxBytes: 16 })).rejects.toThrow('Media size limit')
    await expect(downloadMedia(result.cdn, { media: { encryptQueryParam: 'param' }, maxBytes: 1024 })).rejects.toThrow('no AES key')
    await expect(downloadMedia(result.cdn, { media: { aesKey: raw }, maxBytes: 1024 })).rejects.toThrow('neither full_url nor encrypt_query_param')
  })
})

describe('weixin media store', () => {
  it('stores one image once by content hash, refuses oversize and non-images, and only reports older files', () => {
    const directory = join(directoryOf(), 'weixin-media')
    const data = jpeg(40)
    const first = storeMedia({ directory, data, maxBytes: 1024 })
    const second = storeMedia({ directory, data, maxBytes: 1024 })
    expect(first.key).toMatch(/^weixin-[0-9a-f]{32}\.jpg$/)
    expect(second.path).toBe(first.path)
    expect(readdirSync(directory)).toEqual([first.key])
    expect(readFileSync(first.path)).toEqual(data)
    expect(mediaKeys(`before [Image: ${first.key}] after [Image: ${first.key}]`)).toEqual([first.key])
    expect(() => storeMedia({ directory, data: Buffer.from('not an image'), maxBytes: 1024 })).toThrow('not a PNG, JPEG, WebP or GIF')
    expect(() => storeMedia({ directory, data, maxBytes: 4 })).toThrow('Media size limit')
    const report = mediaReport({ directory, retentionMs: 0, now: Date.now() + 1000 })
    expect(report).toMatchObject({ files: 1, bytes: data.length, stale: 1 })
    // Reporting never deletes: the file is still there for a person to clear.
    expect(readdirSync(directory)).toEqual([first.key])
  })
})

describe('weixin bot media', () => {
  it('turns a pure image message into a Trigger that names the stored image', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}, received: Trigger[] = []
    const { context } = host(directory, reports, received)
    const raw = Buffer.alloc(16, 7), image = jpeg(56), ciphertext = encryptWith(image, raw.toString('hex'))
    const media = cdn(() => ({ status: 200, headers: {}, body: ciphertext }))
    const controller = new AbortController()
    let polls = 0
    const { fetcher } = transport(() => {
      polls += 1
      if (polls === 2) controller.abort()
      return { body: { ret: 0, msgs: polls === 1 ? [{ message_id: 'm-img', from_user_id: 'wxid_alice', context_token: 'ctx-1',
        create_time_ms: Date.parse('2026-11-06T00:00:00Z'),
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'param', aes_key: raw.toString('base64') }, mid_size: ciphertext.length } }] }] : [] } }
    })
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    await bot.poll(controller.signal)
    expect(received).toHaveLength(1)
    const trigger = received[0]!
    const images = (trigger.meta as { images: { key: string; path: string; mime: string; bytes: number }[] }).images
    expect(images).toHaveLength(1)
    expect(trigger.text).toBe(`[Image: ${images[0]!.key}]`)
    expect(trigger.meta).toMatchObject({ media: true })
    expect(images[0]!.mime).toBe('image/jpeg')
    expect(readFileSync(images[0]!.path)).toEqual(image)
    expect(reports[WEIXIN_MEDIA]).toMatchObject({ state: 'ready', values: { files: '1', bytes: String(image.length) } })
    expect(media.calls[0]!.url).toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=param')
    // The reader finds the image the Trigger names and refuses a key that is not its own.
    expect(weixinThreadContext.images!(trigger.text)).toEqual([images[0]!.key])
    await expect(weixinThreadContext.image!({} as never, {} as never, trigger, { id: 'm-img', text: trigger.text }, 'weixin-unknown.jpg',
      directory, new AbortController().signal)).rejects.toThrow('Choose an image key')
  })
  it('keeps a picture it could not download as a Trigger naming it, and reports the failure', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}, received: Trigger[] = []
    const { context } = host(directory, reports, received)
    const media = cdn(() => ({ status: 502, headers: {}, body: Buffer.from('bad gateway') }))
    const message = { message_id: 'm-bad', from_user_id: 'wxid_alice', context_token: 'ctx-1',
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'param', aes_key: Buffer.alloc(16, 3).toString('base64') } } }] }
    const controller = new AbortController()
    let polls = 0
    const { fetcher } = transport(() => {
      polls += 1
      if (polls === 2) controller.abort()
      return { body: { ret: 0, msgs: polls === 1 ? [message] : [] } }
    })
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    await bot.poll(controller.signal)
    expect(received.map(item => item.text)).toEqual([mediaFailureMarker('HTTP 502')])
    expect(reports[WEIXIN_MEDIA]).toMatchObject({ state: 'error' })
    expect(String(reports[WEIXIN_MEDIA]!.detail)).toContain('HTTP 502')
  })
  it('names the stage on the Trigger and logs the message and URL origin when the CDN refuses the image', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}, received: Trigger[] = [], logs: string[] = []
    const { context } = host(directory, reports, received)
    const raw = Buffer.alloc(16, 9)
    const media = cdn(() => ({ status: 403, headers: {}, body: Buffer.from('forbidden') }))
    const message = { message_id: 'm-403', from_user_id: 'wxid_alice', context_token: 'ctx-1', item_list: [{ type: 2, image_item: {
      aeskey: raw.toString('hex'), media: { encrypt_query_param: 'secret-param', full_url: 'https://cdn.example.test/c2c/download?x=1' } } }] }
    const controller = new AbortController()
    let polls = 0
    const { fetcher } = transport(() => {
      polls += 1
      if (polls === 2) controller.abort()
      return { body: { ret: 0, msgs: polls === 1 ? [message] : [] } }
    })
    const bot = botOf(fetcher, { cdn: media.cdn, log: line => logs.push(line) })
    bot.attach(context); expect(bot.connect()).toBe(true)
    await bot.poll(controller.signal)
    expect(received[0]!.text).toBe('[图片: 获取失败 HTTP 403]')
    expect(String(reports[WEIXIN_MEDIA]!.detail)).toContain('HTTP 403')
    // Nothing was written for a failed download, which is why the media directory stays absent.
    expect(existsSync(join(directory, 'weixin-media'))).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('message=m-403')
    expect(logs[0]).toContain('https://cdn.example.test/c2c/download')
    expect(logs[0]).toContain('HTTP 403')
    expect(logs[0]).toContain('aeskey=image_item.aeskey keyLength=32')
    // The encrypted parameter is never logged, only the URL's origin and path.
    expect(logs[0]).not.toContain('secret-param')
    expect(logs[0]).not.toContain('x=1')
  })
  it('downloads with image_item.aeskey first and with media.aes_key in either encoding, and builds the legacy URL', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}, received: Trigger[] = []
    const { context } = host(directory, reports, received)
    const raw = Buffer.alloc(16, 5), image = jpeg(72), ciphertext = encryptWith(image, raw.toString('hex'))
    const hex = raw.toString('hex')
    const base64Raw = raw.toString('base64'), base64Hex = Buffer.from(hex).toString('base64')
    const media = cdn(url => {
      expect(url.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=param-')).toBe(true)
      return { status: 200, headers: {}, body: ciphertext }
    })
    const messages = [
      // The item's hex key with an empty media.aes_key: the empty value must not shadow it.
      { message_id: 'm-hex', item_list: [{ type: 2, image_item: { aeskey: hex, media: { encrypt_query_param: 'param-1', aes_key: '' } } }] },
      { message_id: 'm-b64-hex', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'param-2', aes_key: base64Hex } } }] },
      { message_id: 'm-b64-raw', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'param-3', aes_key: base64Raw } } }] },
    ].map(item => ({ from_user_id: 'wxid_alice', context_token: 'ctx-1', ...item }))
    const controller = new AbortController()
    let polls = 0
    const { fetcher } = transport(() => {
      polls += 1
      if (polls === 2) controller.abort()
      return { body: { ret: 0, msgs: polls === 1 ? messages : [] } }
    })
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    await bot.poll(controller.signal)
    expect(received).toHaveLength(3)
    for (const trigger of received) expect(trigger.text).toMatch(/^\[Image: weixin-[0-9a-f]{32}\.jpg\]$/)
    expect(new Set(received.map(trigger => trigger.text)).size).toBe(1)
    expect(reports[WEIXIN_MEDIA]).toMatchObject({ state: 'ready', values: { files: '1' } })
    const stored = (received[0]!.meta as { images: { path: string }[] }).images[0]!.path
    expect(readFileSync(stored)).toEqual(image)
    expect(media.calls.map(call => call.url)).toEqual([1, 2, 3].map(index =>
      `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=param-${index}`))
    // A full_url is preferred when present, as the official plugin does.
    expect(inboundImages([{ type: 2, image_item: { media: { encrypt_query_param: 'p', full_url: 'https://cdn.example.test/x', aes_key: base64Raw } } }])[0]!.fullUrl)
      .toBe('https://cdn.example.test/x')
  })
  it('names a missing or malformed AES key on the Trigger without touching the CDN', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}, received: Trigger[] = []
    const { context } = host(directory, reports, received)
    const media = cdn(() => ({ status: 200, headers: {}, body: Buffer.alloc(0) }))
    const messages = [
      { message_id: 'm-nokey', from_user_id: 'wxid_alice', context_token: 'ctx-1', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p' } } }] },
      { message_id: 'm-badkey', from_user_id: 'wxid_alice', context_token: 'ctx-1', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p', aes_key: 'definitely-not-a-key' } } }] },
    ]
    const controller = new AbortController()
    let polls = 0
    const { fetcher } = transport(() => {
      polls += 1
      if (polls === 2) controller.abort()
      return { body: { ret: 0, msgs: polls === 1 ? messages : [] } }
    })
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    await bot.poll(controller.signal)
    expect(received.map(item => item.text)).toEqual([mediaFailureMarker('缺少 aes_key'), mediaFailureMarker('aes_key 解码')])
    expect(media.calls).toHaveLength(0)
    expect(reports[WEIXIN_MEDIA]).toMatchObject({ state: 'error' })
  })
  it('keeps the failure reason on the health entry even when another image of the batch arrived', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}, received: Trigger[] = []
    const { context } = host(directory, reports, received)
    const raw = Buffer.alloc(16, 11), image = jpeg(40)
    const media = cdn(url => url.includes('param-ok')
      ? { status: 200, headers: {}, body: encryptWith(image, raw.toString('hex')) }
      : { status: 403, headers: {}, body: Buffer.from('forbidden') })
    const messages = ['param-ok', 'param-refused'].map((param, index) => ({ message_id: `m-${index}`, from_user_id: 'wxid_alice',
      context_token: 'ctx-1', item_list: [{ type: 2, image_item: { aeskey: raw.toString('hex'), media: { encrypt_query_param: param } } }] }))
    const controller = new AbortController()
    let polls = 0
    const { fetcher } = transport(() => {
      polls += 1
      if (polls === 2) controller.abort()
      return { body: { ret: 0, msgs: polls === 1 ? messages : [] } }
    })
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    await bot.poll(controller.signal)
    expect(received).toHaveLength(2)
    expect(received[0]!.text).toMatch(/^\[Image: weixin-/)
    expect(received[1]!.text).toBe('[图片: 获取失败 HTTP 403]')
    expect(reports[WEIXIN_MEDIA]).toMatchObject({ state: 'error' })
    expect(String(reports[WEIXIN_MEDIA]!.detail)).toContain('HTTP 403')
    expect(readdirSync(join(directory, 'weixin-media'))).toHaveLength(1)
  })
  it('sends an image beside the text: ticket, upload, then an image_item send, each once', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const file = join(directory, 'plot.jpg')
    const image = jpeg(24)
    writeFileSync(file, image)
    const reports: Record<string, Health> = {}
    const { context, state } = host(directory, reports)
    state.set(KV.weixin.context('wxid_alice'), 'ctx-1')
    const media = cdn(url => url.includes('/upload') ? { status: 200, headers: { 'x-encrypted-param': 'dl-param' }, body: Buffer.alloc(0) }
      : { status: 500, headers: {}, body: Buffer.alloc(0) })
    const { calls, fetcher } = transport(call => {
      if (call.url.includes('/ilink/bot/getuploadurl')) return { body: { ret: 0, upload_param: 'upload-param' } }
      if (call.url.includes('/ilink/bot/sendmessage')) return { body: { ret: 0 } }
      throw new Error(`unexpected ${call.url}`)
    })
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    expect(await bot.send({ ...reply('with-image'), attachments: [{ path: file, mime: 'image/jpeg' }] })).toBe('sent')
    // The text goes first, then the image as its own message, as the references send media.
    expect(calls.map(call => call.url.includes('/ilink/bot/getuploadurl') ? 'upload' : 'send')).toEqual(['send', 'upload', 'send'])
    const ticket = JSON.parse(calls[1]!.body) as Record<string, unknown>
    expect(ticket).toMatchObject({ media_type: 1, to_user_id: 'wxid_alice', rawsize: image.length, filesize: paddedMediaSize(image.length), no_need_thumb: true })
    const hexKey = String(ticket.aeskey)
    expect(hexKey).toMatch(/^[0-9a-f]{32}$/)
    const sends = calls.filter(call => call.url.includes('/ilink/bot/sendmessage')).map(call => JSON.parse(call.body) as { msg: { item_list: unknown[] } })
    expect(sends).toHaveLength(2)
    expect(sends[0]!.msg.item_list).toEqual([{ type: 1, text_item: { text: '收到，图见下。' } }])
    // The full image_item of the sendMessage: the CDN header's parameter, base64(hex32) key, ciphertext size, encrypt_type 1.
    expect(sends[1]!.msg.item_list).toEqual([{ type: 2, image_item: {
      media: { encrypt_query_param: 'dl-param', aes_key: Buffer.from(hexKey).toString('base64'), encrypt_type: 1 },
      mid_size: paddedMediaSize(image.length) } }])
    expect(media.calls[0]!.method).toBe('POST')
    expect(state.get(KV.weixin.sent('with-image@image-0'))).toBe(true)
    // A retry of the same OutboundMessage sends nothing again.
    expect(await bot.send({ ...reply('with-image'), attachments: [{ path: file, mime: 'image/jpeg' }] })).toBe('sent')
    expect(calls).toHaveLength(3)
    expect(reports[WEIXIN_SEND]).toMatchObject({ state: 'ready' })
    expect(reports[WEIXIN_UPLOAD]).toMatchObject({ state: 'ready' })
  })
  it('reports the upload stage separately when the CDN refuses the image', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const file = join(directory, 'plot.jpg')
    writeFileSync(file, jpeg(24))
    const reports: Record<string, Health> = {}
    const { context, state } = host(directory, reports)
    state.set(KV.weixin.context('wxid_alice'), 'ctx-1')
    const media = cdn(() => ({ status: 403, headers: {}, body: Buffer.from('forbidden') }))
    const { fetcher } = transport(call => {
      if (call.url.includes('/ilink/bot/getuploadurl')) return { body: { ret: 0, upload_param: 'upload-param' } }
      return { body: { ret: 0 } }
    })
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    await expect(bot.send({ ...reply('upload-refused'), attachments: [{ path: file }] })).rejects.toThrow('HTTP 403')
    expect(reports[WEIXIN_UPLOAD]).toMatchObject({ state: 'error' })
    expect(String(reports[WEIXIN_UPLOAD]!.detail)).toContain('Could not upload')
    expect(String(reports[WEIXIN_UPLOAD]!.detail)).toContain('HTTP 403')
    // The send stage never ran; its entry says which stage failed instead of blaming the 24-hour window alone.
    expect(reports[WEIXIN_SEND]).toMatchObject({ state: 'error' })
    expect(String(reports[WEIXIN_SEND]!.detail)).toContain('(upload)')
  })
  it('reports a sendMessage failure as the send stage after the upload succeeded', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const file = join(directory, 'plot.jpg')
    writeFileSync(file, jpeg(24))
    const reports: Record<string, Health> = {}
    const { context, state } = host(directory, reports)
    state.set(KV.weixin.context('wxid_alice'), 'ctx-1')
    const media = cdn(() => ({ status: 200, headers: { 'x-encrypted-param': 'dl-param' }, body: Buffer.alloc(0) }))
    const { fetcher } = transport(call => call.url.includes('/ilink/bot/getuploadurl')
      ? { body: { ret: 0, upload_param: 'upload-param' } } : { body: { ret: 500, errmsg: 'busy' } })
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    // Attachment-only, so the first sendMessage is the image and the upload stage really ran.
    await expect(bot.send({ ...reply('send-failed'), text: '', attachments: [{ path: file }] })).rejects.toThrow('sendMessage failed')
    expect(reports[WEIXIN_UPLOAD]).toMatchObject({ state: 'ready' })
    expect(reports[WEIXIN_SEND]).toMatchObject({ state: 'error' })
    expect(String(reports[WEIXIN_SEND]!.detail)).toContain('(send)')
    expect(String(reports[WEIXIN_SEND]!.detail)).toContain('sendMessage failed')
  })
  it('accepts a null upload_full_url from getuploadurl and falls back to upload_param', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const file = join(directory, 'plot.jpg')
    writeFileSync(file, jpeg(24))
    const reports: Record<string, Health> = {}
    const { context, state } = host(directory, reports)
    state.set(KV.weixin.context('wxid_alice'), 'ctx-1')
    const media = cdn(() => ({ status: 200, headers: { 'x-encrypted-param': 'dl-param' }, body: Buffer.alloc(0) }))
    const { calls, fetcher } = transport(call => {
      // protobuf JSON often carries the unset alternative as null; a strict schema would have failed the upload here.
      if (call.url.includes('/ilink/bot/getuploadurl')) return { body: { ret: 0, upload_full_url: null, upload_param: ' upload-param ' } }
      return { body: { ret: 0 } }
    })
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    expect(await bot.send({ ...reply('null-ticket'), text: '', attachments: [{ path: file }] })).toBe('sent')
    const ticket = JSON.parse(calls[0]!.body) as { filekey: string }
    expect(media.calls[0]!.url).toBe(`https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=upload-param&filekey=${ticket.filekey}`)
    expect(reports[WEIXIN_UPLOAD]).toMatchObject({ state: 'ready' })
  })
  it('refuses an attachment that is not an image and reports why, keeping text sends distinct', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const file = join(directory, 'notes.txt')
    writeFileSync(file, 'plain text')
    const reports: Record<string, Health> = {}
    const { context, state } = host(directory, reports)
    state.set(KV.weixin.context('wxid_alice'), 'ctx-1')
    const media = cdn(() => ({ status: 200, headers: {}, body: Buffer.alloc(0) }))
    const { calls, fetcher } = transport(() => ({ body: { ret: 0 } }))
    const bot = botOf(fetcher, { cdn: media.cdn })
    bot.attach(context); expect(bot.connect()).toBe(true)
    await expect(bot.send({ ...reply('bad-image'), attachments: [{ path: file }] })).rejects.toThrow('not a PNG, JPEG, WebP or GIF image')
    expect(reports[WEIXIN_UPLOAD]).toMatchObject({ state: 'error' })
    expect(String(reports[WEIXIN_UPLOAD]!.detail)).toContain('prepare')
    expect(reports[WEIXIN_SEND]).toMatchObject({ state: 'error' })
    expect(String(reports[WEIXIN_SEND]!.detail)).toContain('(prepare)')
    expect(calls).toHaveLength(1) // only the text went out; nothing was uploaded
    await expect(bot.send({ ...reply('declared-type'), attachments: [{ path: file, mime: 'text/plain' }] })).rejects.toThrow('cannot carry text/plain')
  })
  it('reports a stale token on a send instead of the push-window hint alone', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}
    const { context, state } = host(directory, reports)
    state.set(KV.weixin.context('wxid_alice'), 'ctx-1')
    const { fetcher } = transport(() => ({ body: { ret: -14, errmsg: 'stale token' } }))
    const bot = botOf(fetcher)
    bot.attach(context); expect(bot.connect()).toBe(true)
    await expect(bot.send(reply('stale'))).rejects.toThrow('stale token')
    expect(reports[WEIXIN_LOGIN]).toMatchObject({ state: 'error' })
    expect(reports[WEIXIN_SEND]).toMatchObject({ state: 'error' })
  })
})