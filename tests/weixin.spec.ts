import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import type { FetchResponse, Fetcher } from '../src/sources/weixin-api.ts'
import { WEIXIN_LOGIN, WEIXIN_POLL, WEIXIN_SEND, WeixinBot } from '../src/sources/weixin-bot.ts'
import { WeixinConfigSchema, type WeixinConfig } from '../src/sources/weixin-config.ts'
import { qrPng } from '../src/sources/weixin-qr.ts'
import { weixinThreadContext } from '../src/sources/weixin-read.ts'
import { SOURCE, weixinTrigger, weixinTriggerId } from '../src/sources/weixin-trigger.ts'

const CONFIG: WeixinConfig = WeixinConfigSchema.parse({})
const NOW = Date.parse('2026-11-06T01:00:00Z')
/** One inbound update, shaped as the references' `WeixinMessage`; `message_id` and `seq` are both optional there. */
const message = (overrides: Record<string, unknown> = {}) => ({ message_id: 'm1', from_user_id: 'wxid_alice', to_user_id: 'bot@im.bot',
  context_token: 'ctx-1', create_time_ms: Date.parse('2026-11-06T00:00:00Z'),
  item_list: [{ type: 1, text_item: { text: ' 修一下页脚 ' } }], ...overrides })
interface Answer { status?: number; body?: unknown }
interface Call { url: string; method: string; headers: Record<string, string>; body: string }
/** A `fetch` stand-in: records every request and answers from `answer`, so no test touches the network. */
function transport(answer: (call: Call) => Answer) {
  const calls: Call[] = []
  const fetcher: Fetcher = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ?? '' }
    calls.push(call)
    const reply = answer(call)
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
    return { status: reply.status ?? 200, text: async () => body } as FetchResponse
  }
  return { calls, fetcher }
}
/** A Source context over an in-memory state map and a temporary state directory. */
function host(directory: string, config: WeixinConfig | undefined, reports: Record<string, Health>, received: Trigger[] = []) {
  const state = new Map<string, unknown>()
  const context = { ready: Promise.resolve(), configured: () => true, deployment: { stateDir: directory },
    config: (id: string) => id === SOURCE ? config : undefined,
    state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => { if (value === undefined) state.delete(name); else state.set(name, value) } },
    receive: async (trigger: Trigger) => { received.push(trigger); return 'stored' as const },
    report: (entry: string, health: Health) => { reports[entry] = health } }
  return { context: context as unknown as SourceContext, state, received }
}
const directoryOf = () => mkdtempSync(join(tmpdir(), 'weixin-'))
const saveLogin = (directory: string, values: Record<string, unknown> = {}) => {
  const file = join(directory, 'weixin-bot.json')
  writeFileSync(file, JSON.stringify({ token: 'token-1', botId: 'bot-1', baseUrl: 'https://ilinkai.weixin.qq.com', ...values }))
  return file
}
const botOf = (fetcher: Fetcher, extra: Partial<ConstructorParameters<typeof WeixinBot>[0]> = {}) =>
  new WeixinBot({ fetcher, now: () => NOW, wait: async () => {}, qrPollTimeoutMs: 40, qrTimeoutMs: 60_000, ...extra })
const reply = (id = 'reply-1'): OutboundMessage => ({ id, channel: { source: 'weixin', thread: 'weixin:wxid_alice', address: { userId: 'wxid_alice' } },
  text: '收到，修复页脚。', kind: 'acknowledgement' })

describe('weixin trigger', () => {
  it('turns a direct message into a direct, human Trigger of the sender\'s Thread', () => {
    const trigger = weixinTrigger(message(), () => NOW)!
    expect(trigger).toEqual({ id: key('weixin', 'wxid_alice', 'm1'), source: 'weixin',
      threads: [{ source: 'weixin', id: 'wxid_alice' }], actor: { source: 'weixin', id: 'wxid_alice' }, human: true, addressed: 'direct',
      at: '2026-11-06T00:00:00.000Z', text: '修一下页脚',
      channel: { source: 'weixin', thread: 'weixin:wxid_alice', address: { userId: 'wxid_alice' } },
      meta: { userId: 'wxid_alice', messageId: 'm1', direct: true, createTime: '2026-11-06T00:00:00.000Z' } })
    expect(trigger.id).toBe(weixinTriggerId('wxid_alice', 'm1'))
  })
  it('keeps quoted text and a voice transcription, and drops what it cannot read', () => {
    const quoted = weixinTrigger(message({ item_list: [{ type: 1, text_item: { text: ' yes ' },
      ref_msg: { title: 'the footer', message_item: { type: 1, text_item: { text: 'fix it' } } } }] }))!
    expect(quoted.text).toBe('[引用: the footer | fix it]\nyes')
    expect(weixinTrigger(message({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }))!.text).toBe('语音转写')
    expect(weixinTrigger(message({ item_list: [{ type: 3, voice_item: {} }] }))).toBeUndefined()
    expect(weixinTrigger(message({ item_list: [{ type: 2, image_item: {} }] }))).toBeUndefined()
    expect(weixinTrigger(message({ group_id: 'g1' }))).toBeUndefined()
    expect(weixinTrigger(message({ from_user_id: '' }))).toBeUndefined()
    expect(weixinTrigger(message({ item_list: [{ type: 1, text_item: { text: '   ' } }] }))).toBeUndefined()
  })
  it('falls back to seq for the message id and marks unreadable media', () => {
    const trigger = weixinTrigger(message({ message_id: undefined, seq: 7,
      item_list: [{ type: 1, text_item: { text: 'hi' } }, { type: 2 }] }))!
    expect(trigger.meta).toMatchObject({ messageId: '7', media: true })
  })
})

describe('weixin bot', () => {
  it('persists the long-poll cursor after a batch and echoes it on the next poll', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}, received: Trigger[] = []
    const { context, state } = host(directory, CONFIG, reports, received)
    const controller = new AbortController()
    let polls = 0
    const { calls, fetcher } = transport(call => {
      expect(call.url).toContain('/ilink/bot/getupdates')
      polls += 1
      if (polls === 2) controller.abort()
      return { body: { ret: 0, errcode: 0, msgs: polls === 1 ? [message()] : [], get_updates_buf: polls === 1 ? 'buf-1' : '' } }
    })
    const bot = botOf(fetcher)
    bot.attach(context)
    expect(bot.connect()).toBe(true)
    await bot.poll(controller.signal)
    expect(received.map(item => item.text)).toEqual(['修一下页脚'])
    expect(state.get(KV.weixin.cursor)).toEqual({ botId: 'bot-1', buf: 'buf-1' })
    expect((JSON.parse(calls[0]!.body) as { get_updates_buf: string }).get_updates_buf).toBe('')
    expect((JSON.parse(calls[1]!.body) as { get_updates_buf: string }).get_updates_buf).toBe('buf-1')
    // A reply needs the sender's latest context_token, which the same batch stores.
    expect(state.get(KV.weixin.context('wxid_alice'))).toBe('ctx-1')
    expect(state.get(KV.weixin.inbound('wxid_alice'))).toBe('2026-11-06T01:00:00.000Z')
    expect(reports[WEIXIN_POLL]).toMatchObject({ state: 'ready' })
  })
  it('does not reuse a cursor another bot account produced', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}
    const { context, state } = host(directory, CONFIG, reports)
    state.set(KV.weixin.cursor, { botId: 'old-bot', buf: 'old-buf' })
    const controller = new AbortController()
    const { calls, fetcher } = transport(() => { controller.abort(); return { body: { ret: 0, msgs: [] } } })
    const bot = botOf(fetcher)
    bot.attach(context); expect(bot.connect()).toBe(true)
    await bot.poll(controller.signal)
    expect((JSON.parse(calls[0]!.body) as { get_updates_buf: string }).get_updates_buf).toBe('')
  })
  it('sends a reply once per message id, then reports the 24-hour window when iLink rejects it', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}
    const { context, state } = host(directory, CONFIG, reports)
    state.set(KV.weixin.context('wxid_alice'), 'ctx-1')
    let reject = false
    const { calls, fetcher } = transport(() => reject ? { body: { ret: 200_003, errmsg: 'outside window' } } : { body: { ret: 0 } })
    const bot = botOf(fetcher)
    bot.attach(context); expect(bot.connect()).toBe(true)
    expect(await bot.send(reply())).toBe('sent')
    expect(await bot.send(reply())).toBe('sent')
    expect(calls).toHaveLength(1)
    expect((JSON.parse(calls[0]!.body) as { msg: Record<string, unknown> }).msg).toMatchObject({ to_user_id: 'wxid_alice',
      client_id: 'dsh-superagent-reply-1', context_token: 'ctx-1', message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text: '收到，修复页脚。' } }] })
    expect(state.get(KV.weixin.sent('reply-1'))).toBe(true)
    reject = true
    await expect(bot.send(reply('reply-2'))).rejects.toThrow('sendMessage failed')
    expect(reports[WEIXIN_SEND]).toMatchObject({ state: 'error' })
    expect(String(reports[WEIXIN_SEND]!.detail)).toContain('24 hours')
  })
  it('retries only the chunks of a long reply that were not delivered', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}
    const { context } = host(directory, CONFIG, reports)
    context.state.set(KV.weixin.context('wxid_alice'), 'ctx-1')
    let failed = false
    const { calls, fetcher } = transport(() => {
      if (calls.length === 2 && !failed) { failed = true; return { body: { ret: 500, errmsg: 'busy' } } }
      return { body: { ret: 0 } }
    })
    const bot = botOf(fetcher)
    bot.attach(context); expect(bot.connect()).toBe(true)
    const long = 'a'.repeat(9_000)
    await expect(bot.send({ ...reply('long-1'), text: long })).rejects.toThrow('sendMessage failed')
    expect(calls).toHaveLength(2)
    expect(await bot.send({ ...reply('long-1'), text: long })).toBe('sent')
    // The first chunk was already recorded as delivered and is not sent again.
    expect(calls).toHaveLength(4)
    expect(context.state.get(KV.weixin.sent('long-1#0'))).toBe(true)
    expect(context.state.get(KV.weixin.sent('long-1#2'))).toBe(true)
  })
  it('requests a new login when the token goes stale, then polls with the new token', async () => {
    const directory = directoryOf(); const file = saveLogin(directory)
    const reports: Record<string, Health> = {}
    const { context } = host(directory, CONFIG, reports)
    const controller = new AbortController()
    const seen: string[] = []
    let polls = 0
    const { fetcher } = transport(call => {
      if (call.url.includes('/ilink/bot/msg/notify')) return { body: { ret: 0 } }
      if (call.url.includes('/ilink/bot/getupdates')) {
        polls += 1
        seen.push(call.headers.Authorization ?? '')
        if (polls === 1) return { body: { ret: -14, errmsg: 'stale token' } }
        controller.abort()
        return { body: { ret: 0, msgs: [] } }
      }
      throw new Error(`unexpected ${call.url}`)
    })
    const bot = botOf(fetcher)
    vi.spyOn(bot, 'login').mockImplementation(async () => {
      writeFileSync(file, JSON.stringify({ token: 'token-2', botId: 'bot-2', baseUrl: 'https://ilinkai.weixin.qq.com' }))
      return true
    })
    bot.attach(context)
    await bot.run(controller.signal)
    expect(seen).toEqual(['Bearer token-1', 'Bearer token-2'])
    expect(readdirSync(directory).some(name => name.startsWith('weixin-bot.json.expired-'))).toBe(true)
    expect(reports[WEIXIN_LOGIN]).toMatchObject({ state: 'ready', detail: 'Logged in as bot-2' })
  })
  it('reports three failed polls in a row instead of retrying tightly', async () => {
    const directory = directoryOf(); saveLogin(directory)
    const reports: Record<string, Health> = {}
    const { context } = host(directory, CONFIG, reports)
    const controller = new AbortController()
    let waits = 0
    const { calls, fetcher } = transport(() => ({ body: { ret: 500, errmsg: 'boom' } }))
    const bot = new WeixinBot({ fetcher, now: () => NOW, qrPollTimeoutMs: 40,
      wait: async () => { waits += 1; if (waits >= 3) controller.abort() } })
    bot.attach(context); expect(bot.connect()).toBe(true)
    await bot.poll(controller.signal)
    expect(calls).toHaveLength(3)
    expect(waits).toBe(3)
    expect(reports[WEIXIN_POLL]).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '3' } })
  })
  it('writes the login QR as a PNG and a link text, then saves the confirmed login', async () => {
    const directory = directoryOf()
    const reports: Record<string, Health> = {}
    const { context } = host(directory, CONFIG, reports)
    const statuses: unknown[] = [{ status: 'wait' }, { status: 'scaned' },
      { status: 'confirmed', bot_token: 'token-9', ilink_bot_id: 'bot-9', ilink_user_id: 'me', baseurl: 'https://ilinkai2.weixin.qq.com' }]
    const { fetcher } = transport(call => call.url.includes('/ilink/bot/get_bot_qrcode')
      ? { body: { qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' } }
      : { body: statuses.shift() ?? { status: 'wait' } })
    const bot = botOf(fetcher)
    bot.attach(context)
    expect(await bot.login(new AbortController().signal)).toBe(true)
    const png = readFileSync(join(directory, 'weixin-qrcode.png'))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(readFileSync(join(directory, 'weixin-qrcode.txt'), 'utf8')).toContain('https://liteapp.weixin.qq.com/q/abc')
    expect(JSON.parse(readFileSync(join(directory, 'weixin-bot.json'), 'utf8'))).toMatchObject({ token: 'token-9', botId: 'bot-9',
      baseUrl: 'https://ilinkai2.weixin.qq.com', userId: 'me' })
    expect(reports[WEIXIN_LOGIN]).toMatchObject({ state: 'ready', detail: 'Logged in as bot-9' })
    expect(bot.qrFiles()).toMatchObject({ png: join(directory, 'weixin-qrcode.png') })
  })
  it('leaves a login nobody scanned on the health entry instead of looping over QR codes', async () => {
    const directory = directoryOf()
    const reports: Record<string, Health> = {}
    const { context } = host(directory, CONFIG, reports)
    const { calls, fetcher } = transport(call => call.url.includes('/ilink/bot/get_bot_qrcode')
      ? { body: { qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' } }
      : { body: { status: 'wait' } })
    const bot = botOf(fetcher, { qrTimeoutMs: 0 })
    bot.attach(context)
    await bot.run(new AbortController().signal)
    expect(calls.filter(call => call.url.includes('/ilink/bot/get_bot_qrcode'))).toHaveLength(1)
    expect(reports[WEIXIN_LOGIN]).toMatchObject({ state: 'error' })
    expect(readFileSync(join(directory, 'weixin-qrcode.png')).length).toBeGreaterThan(100)
  })
})

describe('weixin login QR image', () => {
  it('renders a valid greyscale PNG whose pixels are the QR modules', () => {
    const buffer = qrPng('https://liteapp.weixin.qq.com/q/abc')
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
    expect(width).toBeGreaterThan(100)
    expect(width).toBe(height)
    let offset = 8
    const idat: Buffer[] = []
    while (offset < buffer.length) {
      const length = buffer.readUInt32BE(offset)
      const type = buffer.toString('ascii', offset + 4, offset + 8)
      if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length))
      offset += 12 + length
    }
    const raw = inflateSync(Buffer.concat(idat))
    expect(raw).toHaveLength((width + 1) * height)
    const values = new Set<number>()
    for (let y = 0; y < height; y++) {
      expect(raw[y * (width + 1)]).toBe(0)
      for (let x = 0; x < width; x++) values.add(raw[y * (width + 1) + 1 + x]!)
    }
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255])
  })
})

describe('weixin thread context', () => {
  it('names the Trigger\'s message and reports that iLink has no history read', async () => {
    const trigger = weixinTrigger(message(), () => NOW)!
    expect(weixinThreadContext.messageId(trigger)).toBe('m1')
    await expect(weixinThreadContext.read({} as never, trigger, 'thread', undefined, CONFIG)).resolves
      .toMatchObject({ messages: [], status: 'no_history' })
  })
})