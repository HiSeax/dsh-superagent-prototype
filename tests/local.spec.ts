import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId as sessionId, type SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { LocalSessions } from '../src/app/local-sessions.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { Health, SourceContext, SourceHost, SourceSessions } from '../src/sources/host.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { apply, localKind } from '../src/sources/local.ts'
import { localTrigger, localTriggerId, MASTER_ROW } from '../src/sources/local-trigger.ts'

const HOST = 'orchestrator-test'
/** A `user/message` Session event of a person's text, as DSH emits it. */
const human = (id: string, text: string, seq = 1, at = Date.parse('2026-09-09T00:00:00Z')) => ({
  type: 'user/message', seq, time: at,
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: id } },
})
/** A message this plugin delivers: a candidate card, an acknowledgement or a worker input. */
const plugin = (id: string, text: string, seq = 2) => ({ type: 'user/message', seq, time: Date.parse('2026-09-09T00:01:00Z'),
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-superagent', form: 'relay' } } })
const assistant = (id: string, text: string, seq = 3) => ({ type: 'assistant/message', seq, time: Date.parse('2026-09-09T00:02:00Z'),
  data: { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } })

const thread = (id: string): { key: string; ref: { source: string; id: string }; createdAt: string; subscriptions: string[];
  correlated: string[]; pending: string[]; meta: Record<string, unknown> } =>
  ({ key: `local:${id}`, ref: { source: 'local', id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} })

/** A SourceHost over a registry, with a fake Session capability and a context stub the kind's own callbacks do not read. */
function host(settings: ReturnType<typeof SettingsSchema.parse>) {
  const sources = new SourceRegistry(() => settings)
  const deliver = vi.fn<SourceSessions['deliver']>(async () => 'sent')
  const page = vi.fn<SourceSessions['page']>(async () => ({ messages: [] }))
  const sessions: SourceSessions = { deliver, page, exists: vi.fn(async () => true) }
  const value: SourceHost = { sources, masterId: HOST, dshSessions: sessions, context: () => ({} as SourceContext) }
  return { sources, sessions, deliver, page, host: value }
}
const localSettings = (channels: string[] = ['session-1'], allowed: { id: string }[] = [{ id: 'local' }], master = false) =>
  SettingsSchema.parse({ sources: { local: { enabled: true, config: { master, sessions: channels.map(id => ({ sessionId: id })) } } },
    policy: { sources: { local: { allowed } } } })

describe('local Session trigger', () => {
  it('turns a person\'s message in a channel Session into a direct, human Trigger on the Session\'s Thread', () => {
    const trigger = localTrigger({ sessionId: 'session-1', masterId: HOST, event: human('m1', '  修一下页脚  ') })!
    expect(trigger).toEqual({ id: key('local', 'session-1', 'm1'), source: 'local', threads: [{ source: 'local', id: 'session-1' }],
      actor: { source: 'local', id: 'local' }, human: true, addressed: 'direct', at: '2026-09-09T00:00:00.000Z', text: '修一下页脚',
      channel: { source: 'local', thread: 'local:session-1', address: { sessionId: 'session-1', messageId: 'm1' } },
      meta: { sessionId: 'session-1', messageId: 'm1', seq: 1 } })
    expect(trigger.id).toBe(localTriggerId('session-1', 'm1'))
    // The same message always produces the same Trigger, so accepting it twice creates one Ticket.
    expect(localTrigger({ sessionId: 'session-1', masterId: HOST, event: human('m1', '修一下页脚  ') })!.id).toBe(trigger.id)
  })
  it('turns a person\'s message in the main Session into a Trigger on the main Session\'s Thread', () => {
    const trigger = localTrigger({ sessionId: HOST, masterId: HOST, event: human('m1', 'do it') })!
    expect(trigger.threads).toEqual([{ source: 'local', id: HOST }])
    expect(trigger.id).toBe(key('local', HOST, 'm1'))
    expect(trigger.channel).toEqual({ source: 'local', thread: `local:${HOST}`, address: { sessionId: HOST, messageId: 'm1', master: 'true' } })
    expect(trigger.meta).toEqual({ sessionId: HOST, messageId: 'm1', seq: 1, master: true })
    expect(trigger).toMatchObject({ human: true, addressed: 'direct', actor: { source: 'local', id: 'local' } })
  })
  it('joins text blocks and keeps a message with an image but no text out', () => {
    const content = [{ type: 'text', text: 'one' }, { type: 'image', attachment: { id: 'a' } }, { type: 'text', text: 'two' }]
    const trigger = localTrigger({ sessionId: 's', masterId: HOST,
      event: { type: 'user/message', seq: 0, time: 0, data: { id: 'm1', role: 'user', content, source: { kind: 'user' } } } })!
    expect(trigger.text).toBe('one\ntwo')
    expect(localTrigger({ sessionId: 's', masterId: HOST,
      event: { type: 'user/message', seq: 0, time: 0, data: { id: 'm2', role: 'user', content: [{ type: 'image' }], source: { kind: 'user' } } } }))
      .toBeUndefined()
  })
  it('never turns this plugin\'s own deliveries into Triggers, in the main Session or a channel Session', () => {
    // The regression lock for the self-loop: candidates, acknowledgements, results, questions and worker inputs are all
    // `dsh-superagent` source messages.
    for (const sessionId of [HOST, 'session-1']) {
      expect(localTrigger({ sessionId, masterId: HOST, event: plugin('p1', '{"kind":"candidate"}') }), sessionId).toBeUndefined()
      expect(localTrigger({ sessionId, masterId: HOST, event: plugin('p2', '收到，修复回归。') }), sessionId).toBeUndefined()
      expect(localTrigger({ sessionId, masterId: HOST, event: plugin('p3', 'Ticket input') }), sessionId).toBeUndefined()
    }
    // A person's message in a Session the Source does not listen to is still a Trigger; the Source's listener filters it.
    expect(localTrigger({ sessionId: 'session-2', masterId: HOST, event: human('m3', 'hi') })).not.toBeUndefined()
  })
  it('ignores events that are not a person\'s user message', () => {
    for (const sessionId of [HOST, 'session-1']) {
      // The orchestrator's own assistant messages, also in the main Session, never become Triggers.
      expect(localTrigger({ sessionId, masterId: HOST, event: assistant('a1', 'reply') }), sessionId).toBeUndefined()
      expect(localTrigger({ sessionId, masterId: HOST, event: { type: 'turn/start', seq: 0, time: 0, data: {} } }), sessionId).toBeUndefined()
      expect(localTrigger({ sessionId, masterId: HOST, event: { type: 'user/message', seq: 0, time: 0,
        data: { id: 'm1', role: 'user', content: [], source: { kind: 'user' } } } }), sessionId).toBeUndefined()
    }
  })
})

describe('local Session kind', () => {
  it('scope listens to the main Session only while that is on, and to the configured channel Sessions', () => {
    const off = host(localSettings())
    off.sources.register(localKind(off.host))
    expect(off.sources.scope({ source: 'local', meta: { sessionId: HOST, master: true } }))
      .toEqual({ listened: false, reason: 'session_not_allowed' })
    expect(off.sources.scope({ source: 'local', meta: { sessionId: 'session-1' } })).toEqual({ listened: true, observed: false, row: 'session-1' })
    const on = host(localSettings([], [{ id: 'local' }], true))
    on.sources.register(localKind(on.host))
    expect(on.sources.scope({ source: 'local', meta: { sessionId: HOST, master: true } }))
      .toEqual({ listened: true, observed: false, row: MASTER_ROW })
    expect(on.sources.scope({ source: 'local', meta: { sessionId: 'session-9' } })).toEqual({ listened: false, reason: 'session_not_allowed' })
    expect(on.sources.scope({ source: 'local', meta: {} })).toEqual({ listened: false, reason: 'session_not_allowed' })
    // A trigger of the main Session is accepted only while the switch is on.
    const trigger = localTrigger({ sessionId: HOST, masterId: HOST, event: human('m1', 'do it') })!
    expect(on.sources.scope({ source: 'local', meta: trigger.meta }).listened).toBe(true)
    expect(off.sources.scope({ source: 'local', meta: trigger.meta }).listened).toBe(false)
  })
  it('allows a reply to a listened Session, joins the main Session\'s turn, and delivers once per OutboundMessage id', async () => {
    const { sources, host: sourceHost, deliver } = host(localSettings(['session-1'], [{ id: 'local' }], true))
    const kind = localKind(sourceHost)
    sources.register(kind)
    expect(sources.channelAllowed({ source: 'local', address: { sessionId: 'session-1' } })).toBe(true)
    expect(sources.channelAllowed({ source: 'local', address: { sessionId: 'session-2' } })).toBe(false)
    expect(sources.channelAllowed({ source: 'local', address: { sessionId: HOST, master: 'true' } })).toBe(true)
    const message: OutboundMessage = { id: 'reply-1', channel: { source: 'local', thread: 'local:session-1', address: { sessionId: 'session-1' } },
      text: ' Done ', kind: 'reply' }
    await kind.channel!.send({ commands: {} as Commands }, message)
    await kind.channel!.send({ commands: {} as Commands }, message)
    expect(deliver.mock.calls).toEqual([['session-1', 'reply-1', 'Done', 'queue'], ['session-1', 'reply-1', 'Done', 'queue']])
    // A reply to the main Session is steered into its running turn, as the application's own relays are.
    const toMaster: OutboundMessage = { id: 'reply-2', channel: { source: 'local', thread: `local:${HOST}`,
      address: { sessionId: HOST, messageId: 'm1', master: 'true' } }, text: '收到', kind: 'acknowledgement' }
    expect(await kind.channel!.send({ commands: {} as Commands }, toMaster)).toBe('sent')
    expect(deliver.mock.calls.at(-1)!).toEqual([HOST, 'reply-2', '收到', 'steer'])
    // The main Session may no longer receive a reply once the switch is off.
    const off = host(localSettings(['session-1']))
    off.sources.register(localKind(off.host))
    expect(off.sources.channelAllowed({ source: 'local', address: { sessionId: HOST, master: 'true' } })).toBe(false)
  })
  it('takes the local user as the default allowed sender, making a person\'s message an explicit request', () => {
    const settings = localSettings(['session-1'], [{ id: 'local' }], true)
    const { sources, host: sourceHost } = host(settings)
    sources.register(localKind(sourceHost))
    expect(sources.policyPart('local')).toEqual({ allowed: [{ id: 'local' }], admission: {} })
    const policy = settingsPolicy(settings, sources)
    const trigger = localTrigger({ sessionId: 'session-1', masterId: HOST, event: human('m1', 'do it') })!
    expect(policy.gate(trigger, thread('session-1') as never, [])).toMatchObject({ admissible: true, strength: 'explicit',
      basis: { via: 'addressed', addressed: 'direct', sender: 'local', source: 'local', scope: { sessionId: 'session-1' }, row: 'session-1' } })
    const fromMaster = localTrigger({ sessionId: HOST, masterId: HOST, event: human('m2', 'do it') })!
    expect(policy.gate(fromMaster, thread(HOST) as never, [])).toMatchObject({ admissible: true, strength: 'explicit',
      basis: { via: 'addressed', addressed: 'direct', sender: 'local', scope: { sessionId: HOST, master: true }, row: MASTER_ROW } })
    // Removing the local user from the list leaves the addressed cell of the admission table, which defaults to ignore.
    const unlisted = host(localSettings(['session-1'], []))
    unlisted.sources.register(localKind(unlisted.host))
    expect(settingsPolicy(localSettings(['session-1'], []), unlisted.sources).gate(trigger, thread('session-1') as never, []))
      .toMatchObject({ admissible: false, reason: 'not_a_member' })
  })
  it('reports the main Session as an admission row only while it is listened to', () => {
    const on = host(localSettings(['session-1'], [{ id: 'local' }], true))
    on.sources.register(localKind(on.host))
    expect(on.sources.kind('local')!.policy!.rows!({ master: true, sessions: [{ sessionId: 'session-1' }] }).map(row => row.id))
      .toEqual([MASTER_ROW, 'session-1'])
    const off = host(localSettings(['session-1']))
    off.sources.register(localKind(off.host))
    expect(off.sources.kind('local')!.policy!.rows!({ sessions: [{ sessionId: 'session-1' }] }).map(row => row.id)).toEqual(['session-1'])
  })
  it('reads the listened Session\'s history backwards from the Trigger, page by page', async () => {
    const { sources, host: sourceHost, page } = host(localSettings())
    sources.register(localKind(sourceHost))
    page.mockResolvedValueOnce({ messages: [{ id: 'm0', seq: 2, at: '2026-09-09T00:00:00.000Z', text: 'before', author: 'person' },
      { id: 'm1', seq: 3, at: '2026-09-09T00:01:00.000Z', text: 'context', author: 'plugin' }], next: 2 })
    const trigger = localTrigger({ sessionId: 'session-1', masterId: HOST, event: human('m9', 'now', 9) })!
    const context = sources.threadContext(trigger)!
    expect(context.messageId).toBe('m9')
    await expect(context.read({} as Commands, 'thread')).resolves.toEqual({ messages: [
      { id: 'm0', from: 'local user', at: '2026-09-09T00:00:00.000Z', text: 'before' },
      { id: 'm1', from: 'dsh-superagent', at: '2026-09-09T00:01:00.000Z', text: 'context', bot: true }],
      next: '2', body: { status: 'available', next: 2, messages: [{ id: 'm0', from: 'local user', at: '2026-09-09T00:00:00.000Z', text: 'before' },
        { id: 'm1', from: 'dsh-superagent', at: '2026-09-09T00:01:00.000Z', text: 'context', bot: true }] }, status: 'available' })
    expect(page.mock.calls).toEqual([['session-1', 10, 20]])
    await context.read({} as Commands, 'thread', '2')
    expect(page.mock.calls[1]).toEqual(['session-1', 2, 20])
    await expect(context.read({} as Commands, 'root')).resolves.toMatchObject({ messages: [], status: 'no_root' })
    await expect(context.read({} as Commands, 'parent')).resolves.toMatchObject({ messages: [], status: 'no_parent' })
  })
})

/** Runs the plugin entry over a fake Cordis context, returning the listener that receives Session events and its disposers. */
function entry(settings: ReturnType<typeof SettingsSchema.parse>, sourceHost: SourceHost,
  reported: Record<string, Health>, received: Trigger[], described: string[]) {
  const context = { ready: Promise.resolve(),
    config: <C>(id: string) => id === 'local' && settings.sources.local!.enabled ? settings.sources.local!.config as C : undefined,
    receive: (trigger: Trigger) => { received.push(trigger); return 'stored' as const },
    threads: { describe: (threadKey: string) => { described.push(threadKey) } }, report: (entry: string, health: Health) => { reported[entry] = health } } as unknown as SourceContext
  sourceHost.context = () => context
  const listeners: ((session: { id: string }, event: unknown) => void)[] = []
  const disposers: (() => unknown)[] = []
  const fake = { orchestrator: sourceHost, logger: { warn: () => {} },
    effect: (run: () => unknown) => { disposers.push(run() as () => unknown) },
    on: (_name: string, listener: (session: { id: string }, event: unknown) => void) => { listeners.push(listener); return () => {} } }
  apply(fake as never)
  return { emit: (id: string, event: unknown) => { for (const listener of listeners) listener({ id }, event) }, disposers }
}

describe('local Session plugin entry', () => {
  it('receives person messages from configured channel Sessions and reports their health', async () => {
    const settings = localSettings(['session-1'])
    const state = host(settings)
    const received: Trigger[] = [], described: string[] = [], reports: Record<string, Health> = {}
    const { emit, disposers } = entry(settings, state.host, reports, received, described)
    expect(state.sources.kind('local')).toBeDefined()
    emit('session-1', human('m1', 'hello'))
    emit('session-2', human('m2', 'not a channel'))
    emit('session-1', plugin('m3', 'own reply'))
    emit('session-1', assistant('a4', 'agent reply'))
    emit(HOST, human('m5', 'main Session is not listened to'))
    expect(received.map(trigger => trigger.text)).toEqual(['hello'])
    expect(received[0]!.threads[0]!.id).toBe('session-1')
    await vi.waitFor(() => expect(described).toEqual(['local:session-1']))
    await vi.waitFor(() => expect(reports.local).toMatchObject({ state: 'ready', detail: 'Listening to 1 channel Session' }))
    expect(state.sessions.exists).toHaveBeenCalledWith('session-1')
    expect(state.sessions.exists).not.toHaveBeenCalledWith(HOST)
    for (const dispose of disposers.reverse()) await dispose()
  })
  it('receives person messages from the main Session while it is switched on, and never the plugin\'s own deliveries', async () => {
    const settings = localSettings([], [{ id: 'local' }], true)
    const state = host(settings)
    const received: Trigger[] = [], described: string[] = [], reports: Record<string, Health> = {}
    const { emit, disposers } = entry(settings, state.host, reports, received, described)
    emit(HOST, human('m1', 'fix the footer'))
    // The self-loop lock: candidate cards, acknowledgements and worker inputs delivered into the main Session stay non-Triggers.
    emit(HOST, plugin('p1', '{"kind":"candidate"}'))
    emit(HOST, plugin('p2', '收到，修复页脚。'))
    emit(HOST, plugin('p3', 'assignment: t1'))
    emit(HOST, assistant('a1', 'orchestrator reply'))
    emit(HOST, human('m2', ''))
    expect(received.map(trigger => trigger.text)).toEqual(['fix the footer'])
    expect(received[0]!.meta).toMatchObject({ sessionId: HOST, master: true })
    expect(received[0]!.threads).toEqual([{ source: 'local', id: HOST }])
    await vi.waitFor(() => expect(described).toEqual([`local:${HOST}`]))
    // The main Session exists by construction: health does not stat it, and needs no channel Session to be ready.
    await vi.waitFor(() => expect(reports.local).toMatchObject({ state: 'ready', detail: 'Listening to the main Session' }))
    expect(state.sessions.exists).not.toHaveBeenCalled()
    for (const dispose of disposers.reverse()) await dispose()
  })
  it('leaves every Session alone, including the main one, once the Source is switched off', async () => {
    const settings = localSettings(['session-1'], [{ id: 'local' }], false)
    const disabled = SettingsSchema.parse({ ...settings, sources: { local: { enabled: false, config: settings.sources.local!.config } } })
    const state = host(disabled)
    const received: Trigger[] = [], described: string[] = [], reports: Record<string, Health> = {}
    const { emit, disposers } = entry(disabled, state.host, reports, received, described)
    emit('session-1', human('m1', 'hello'))
    emit(HOST, human('m2', 'hello'))
    expect(received).toEqual([])
    await vi.waitFor(() => expect(reports.local).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    for (const dispose of disposers.reverse()) await dispose()
  })
})

describe('LocalSessions', () => {
  const agent = () => {
    const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
    const steer = vi.fn((message: UserMessage) => { inbox.nextStep.push(message) })
    const followup = vi.fn((message: UserMessage) => { inbox.nextTurn.push(message) })
    return { agent: { id: sessionId('session-1'), session: {}, inbox, steer, followup, inject: vi.fn() } as unknown as Agent,
      inbox, steer, followup }
  }
  const fixture = (record: { type: string; seq: number; time: number; data: unknown }[] = []) => {
    const ctx = new Context()
    const { agent: target, inbox, steer, followup } = agent()
    const agents = new Map([[target.id, target]])
    const reader = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
    const page = vi.fn(async (_id: string, _before: number, _limit: number) => ({ records: record.map(event => ({ type: 'event', event })), hasMore: true }))
    const stat = vi.fn(async () => ({ header: { id: target.id }, inheritedEventCount: 0, revision: 1 }))
    ctx.reflect.provide('agents', agents)
    ctx.reflect.provide('sessionPersistence', { open: async () => reader, flush: async () => {}, stat })
    ctx.reflect.provide('sessionController', {
      resolveAgent: async (id: SessionId) => agents.has(id) ? { agent: agents.get(id)! } : { error: { code: 'session/not-found' } },
      page,
    })
    const sessions = new LocalSessions({ context: ctx, lifetime: new AbortController().signal })
    return { sessions, target, inbox, agents, page, stat, steer, followup }
  }
  it('delivers a reply once per OutboundMessage id and answers gone for a missing Session', async () => {
    const f = fixture()
    expect(await f.sessions.deliver('session-1', 'reply-1', 'Done', 'queue')).toBe('sent')
    expect(await f.sessions.deliver('session-1', 'reply-1', 'Done', 'queue')).toBe('sent')
    expect(f.followup).toHaveBeenCalledOnce()
    // A Session that no longer exists is gone; its stored history has no header either.
    f.agents.clear()
    f.stat.mockResolvedValueOnce(undefined as never)
    expect(await f.sessions.deliver('session-1', 'reply-2', 'Done', 'queue')).toBe('gone')
  })
  it('steers a reply into a running Session, as the same delivery does for this plugin\'s own relays', async () => {
    const f = fixture()
    await f.sessions.deliver('session-1', 'reply-3', '收到', 'steer')
    expect(f.steer).toHaveBeenCalledOnce()
    expect(f.followup).not.toHaveBeenCalled()
  })
  it('delivers with this plugin\'s own source, so the reply it writes back is never taken up as a Trigger', async () => {
    const f = fixture()
    await f.sessions.deliver('session-1', 'reply-9', '收到，修复回归。', 'queue')
    const delivered = f.followup.mock.calls[0]![0]!
    expect(delivered.source).toEqual({ kind: 'dsh-superagent', form: 'relay' })
    // The end-to-end lock: the message this Channel writes into the Session is filtered out by the intake, in a channel
    // Session and in the main Session alike.
    const event = { type: 'user/message', seq: 10, time: Date.parse('2026-09-09T00:05:00Z'), data: delivered }
    expect(localTrigger({ sessionId: 'session-1', masterId: HOST, event })).toBeUndefined()
    expect(localTrigger({ sessionId: HOST, masterId: HOST, event })).toBeUndefined()
  })
  it('reads the messages of a page and reports the exclusive cursor for the next one', async () => {
    const f = fixture([human('m1', 'one', 3), assistant('a1', 'two', 4), { type: 'tool/result', seq: 5, time: 0, data: {} },
      { type: 'user/message', seq: 6, time: 0, data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'relay' }], source: { kind: 'dsh-superagent' } } }])
    f.page.mockResolvedValueOnce({ records: [
      { type: 'event', event: human('m1', 'one', 3) }, { type: 'event', event: assistant('a1', 'two', 4) },
      { type: 'event', event: { type: 'tool/result', seq: 5, time: 0, data: {} } },
      { type: 'event', event: { type: 'user/message', seq: 6, time: 0, data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'relay' }], source: { kind: 'dsh-superagent' } } } }],
      hasMore: true } as never)
    await expect(f.sessions.page('session-1', 10, 20)).resolves.toEqual({ messages: [
      { id: 'm1', seq: 3, at: '2026-09-09T00:00:00.000Z', text: 'one', author: 'person' },
      { id: 'a1', seq: 4, at: '2026-09-09T00:02:00.000Z', text: 'two', author: 'agent' },
      { id: 'm2', seq: 6, at: new Date(0).toISOString(), text: 'relay', author: 'plugin' }], next: 3 })
    expect(f.page.mock.calls[0]![0]).toEqual({ address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 9, maxMessages: 20 })
    await expect(f.sessions.page('session-1', 0, 20)).resolves.toEqual({ messages: [] })
    await expect(f.sessions.exists('session-1')).resolves.toBe(true)
  })
})