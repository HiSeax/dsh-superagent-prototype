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
import { localTrigger, localTriggerId } from '../src/sources/local-trigger.ts'

const HOST = 'orchestrator-test'
/** A `user/message` Session event of a person's text, as DSH emits it. */
const human = (id: string, text: string, seq = 1, at = Date.parse('2026-09-09T00:00:00Z')) => ({
  type: 'user/message', seq, time: at,
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: id } },
})
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
const localSettings = (channels: string[] = ['session-1'], allowed: { id: string }[] = [{ id: 'local' }]) =>
  SettingsSchema.parse({ sources: { local: { enabled: true, config: { sessions: channels.map(id => ({ sessionId: id })) } } },
    policy: { sources: { local: { allowed } } } })

describe('local Session trigger', () => {
  it('turns a person\'s message in the channel Session into a direct, human Trigger on the Session\'s Thread', () => {
    const trigger = localTrigger({ sessionId: 'session-1', masterId: HOST, event: human('m1', '  修一下页脚  ') })!
    expect(trigger).toEqual({ id: key('local', 'session-1', 'm1'), source: 'local', threads: [{ source: 'local', id: 'session-1' }],
      actor: { source: 'local', id: 'local' }, human: true, addressed: 'direct', at: '2026-09-09T00:00:00.000Z', text: '修一下页脚',
      channel: { source: 'local', thread: 'local:session-1', address: { sessionId: 'session-1', messageId: 'm1' } },
      meta: { sessionId: 'session-1', messageId: 'm1', seq: 1 } })
    expect(trigger.id).toBe(localTriggerId('session-1', 'm1'))
    // The same message always produces the same Trigger, so accepting it twice creates one Ticket.
    expect(localTrigger({ sessionId: 'session-1', masterId: HOST, event: human('m1', '修一下页脚  ') })!.id).toBe(trigger.id)
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
  it('never turns the main Session\'s messages or this plugin\'s own deliveries into Triggers', () => {
    expect(localTrigger({ sessionId: HOST, masterId: HOST, event: human('m1', 'hi') })).toBeUndefined()
    expect(localTrigger({ sessionId: 'session-1', masterId: HOST, event: plugin('m2', '{"kind":"candidate"}') })).toBeUndefined()
    // A person's message in a session the Source does not channel is still a Trigger; the Source's listener filters it.
    expect(localTrigger({ sessionId: 'session-2', masterId: HOST, event: human('m3', 'hi') })).not.toBeUndefined()
  })
  it('ignores events that are not a person\'s user message', () => {
    expect(localTrigger({ sessionId: 's', masterId: HOST, event: assistant('a1', 'reply') })).toBeUndefined()
    expect(localTrigger({ sessionId: 's', masterId: HOST, event: { type: 'turn/start', seq: 0, time: 0, data: {} } })).toBeUndefined()
    expect(localTrigger({ sessionId: 's', masterId: HOST, event: { type: 'user/message', seq: 0, time: 0,
      data: { id: 'm1', role: 'user', content: [], source: { kind: 'user' } } } })).toBeUndefined()
  })
})

describe('local Session kind', () => {
  it('scope listens to the configured channel Sessions and to nothing else', () => {
    const { sources, host: sourceHost } = host(localSettings(['session-1', 'session-2']))
    const kind = localKind(sourceHost)
    sources.register(kind)
    expect(sources.scope({ source: 'local', meta: { sessionId: 'session-1' } })).toEqual({ listened: true, observed: false, row: 'session-1' })
    expect(sources.scope({ source: 'local', meta: { sessionId: 'session-9' } })).toEqual({ listened: false, reason: 'session_not_allowed' })
    expect(sources.scope({ source: 'local', meta: {} })).toEqual({ listened: false, reason: 'session_not_allowed' })
  })
  it('allows a reply only to a configured channel Session, and delivers it once per OutboundMessage id', async () => {
    const { sources, host: sourceHost, deliver } = host(localSettings())
    const kind = localKind(sourceHost)
    sources.register(kind)
    expect(sources.channelAllowed({ source: 'local', address: { sessionId: 'session-1' } })).toBe(true)
    expect(sources.channelAllowed({ source: 'local', address: { sessionId: 'session-2' } })).toBe(false)
    const message: OutboundMessage = { id: 'reply-1', channel: { source: 'local', thread: 'local:session-1', address: { sessionId: 'session-1' } },
      text: ' Done ', kind: 'reply' }
    await kind.channel!.send({ commands: {} as Commands }, message)
    await kind.channel!.send({ commands: {} as Commands }, message)
    expect(deliver.mock.calls).toEqual([['session-1', 'reply-1', 'Done', 'queue'], ['session-1', 'reply-1', 'Done', 'queue']])
    deliver.mockResolvedValueOnce('gone')
    expect(await kind.channel!.send({ commands: {} as Commands }, message)).toBe('gone')
  })
  it('takes the local user as the default allowed sender, making a person\'s message an explicit request', () => {
    const settings = localSettings()
    const { sources, host: sourceHost } = host(settings)
    sources.register(localKind(sourceHost))
    expect(sources.policyPart('local')).toEqual({ allowed: [{ id: 'local' }], admission: {} })
    const policy = settingsPolicy(settings, sources)
    const trigger = localTrigger({ sessionId: 'session-1', masterId: HOST, event: human('m1', 'do it') })!
    expect(policy.gate(trigger, thread('session-1') as never, [])).toMatchObject({ admissible: true, strength: 'explicit',
      basis: { via: 'addressed', addressed: 'direct', sender: 'local', source: 'local', scope: { sessionId: 'session-1' }, row: 'session-1' } })
    // Removing the local user from the list leaves the addressed cell of the admission table, which defaults to ignore.
    const unlisted = host(localSettings(['session-1'], []))
    unlisted.sources.register(localKind(unlisted.host))
    expect(settingsPolicy(localSettings(['session-1'], []), unlisted.sources).gate(trigger, thread('session-1') as never, []))
      .toMatchObject({ admissible: false, reason: 'not_a_member' })
  })
  it('reads the channel Session\'s history backwards from the Trigger, page by page', async () => {
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

describe('local Session plugin entry', () => {
  it('registers its kind, receives only person messages from configured channel Sessions, and reports their health', async () => {
    const settings = localSettings(['session-1'])
    const { sources, host: sourceHost, sessions } = host(settings)
    const received: Trigger[] = []
    const described: string[] = []
    const reports: Record<string, Health> = {}
    const context = { ready: Promise.resolve(), config: <C>(id: string) => id === 'local' ? settings.sources.local!.config as C : undefined,
      receive: (trigger: Trigger) => { received.push(trigger); return 'stored' as const },
      threads: { describe: (threadKey: string) => { described.push(threadKey) } }, report: (entry: string, health: Health) => { reports[entry] = health } } as unknown as SourceContext
    sourceHost.context = () => context
    const listeners: ((session: { id: string }, event: unknown) => void)[] = []
    const disposers: (() => unknown)[] = []
    const fake = { orchestrator: sourceHost, logger: { warn: () => {} },
      effect: (run: () => unknown) => { disposers.push(run() as () => unknown) },
      on: (_name: string, listener: (session: { id: string }, event: unknown) => void) => { listeners.push(listener); return () => {} } }
    apply(fake as never)
    expect(sources.kind('local')).toBeDefined()
    const emit = (id: string, event: unknown) => { for (const listener of listeners) listener({ id }, event) }
    emit('session-1', human('m1', 'hello'))
    emit('session-2', human('m2', 'not a channel'))
    emit('session-1', plugin('m3', 'own reply'))
    emit(HOST, human('m4', 'orchestrator\'s own'))
    expect(received.map(trigger => trigger.text)).toEqual(['hello'])
    expect(received[0]!.threads[0]!.id).toBe('session-1')
    await vi.waitFor(() => expect(described).toEqual(['local:session-1']))
    await vi.waitFor(() => expect(reports.local).toMatchObject({ state: 'ready', detail: '1 channel Sessions' }))
    expect(sessions.exists).toHaveBeenCalledWith('session-1')
    for (const dispose of disposers.reverse()) await dispose()
  })
})

describe('LocalSessions', () => {
  const agent = () => {
    const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
    return { agent: { id: sessionId('session-1'), session: {}, inbox,
      steer: vi.fn((message: UserMessage) => { inbox.nextStep.push(message) }),
      followup: vi.fn((message: UserMessage) => { inbox.nextTurn.push(message) }), inject: vi.fn() } as unknown as Agent, inbox }
  }
  const fixture = (record: { type: string; seq: number; time: number; data: unknown }[] = []) => {
    const ctx = new Context()
    const { agent: target, inbox } = agent()
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
    return { sessions, target, inbox, agents, page, stat }
  }
  it('delivers a reply once per OutboundMessage id and answers gone for a missing Session', async () => {
    const f = fixture()
    expect(await f.sessions.deliver('session-1', 'reply-1', 'Done', 'queue')).toBe('sent')
    expect(await f.sessions.deliver('session-1', 'reply-1', 'Done', 'queue')).toBe('sent')
    expect(f.target.followup).toHaveBeenCalledOnce()
    // A Session that no longer exists is gone; its stored history has no header either.
    f.agents.clear()
    f.stat.mockResolvedValueOnce(undefined as never)
    expect(await f.sessions.deliver('session-1', 'reply-2', 'Done', 'queue')).toBe('gone')
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