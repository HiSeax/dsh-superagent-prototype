import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { AgentDelivery } from '../src/app/delivery.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { deliverHeartbeat, heartbeatDue, heartbeatRequestId, heartbeatText, inActiveWindow, NO_HEARTBEAT, type HeartbeatConfig } from '../src/app/heartbeat.ts'

const HOST = 'orchestrator-test'
/** The documented heartbeat settings, with the fields a test cares about overridden. */
const config = (overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig => ({ ...NO_HEARTBEAT, enabled: true, ...overrides })
/** A delivery target that remembers what reached it, as `AgentDelivery`'s deduplication expects. */
function delivery() {
  const ctx = new Context()
  const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
  const followup = vi.fn((message: UserMessage) => { inbox.nextTurn.push(message) })
  const agent = { id: HOST, session: {}, inbox, followup, steer: vi.fn(), inject: vi.fn() } as unknown as Agent
  ctx.reflect.provide('agents', new Map([[agent.id, agent]]))
  ctx.reflect.provide('sessionPersistence', { flush: async () => {}, open: async () => ({
    read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) })
  const agentDelivery = new AgentDelivery(ctx)
  const deliver = (requestId: string, text: string) => agentDelivery.send(agent, requestId, text, 'queue', new AbortController().signal)
  return { deliver, followup, inbox }
}

describe('heartbeat configuration', () => {
  it('reads the documented defaults, overrides and bounds', () => {
    expect(Config({ stateDir: '/srv/state' }).heartbeat)
      .toEqual({ enabled: false, intervalMinutes: 30, activeFrom: '08:00', activeTo: '23:00', projects: [] })
    const read = Config({ stateDir: '/srv/state', heartbeat: { enabled: true, intervalMinutes: 15, projects: [{ name: 'alpha', mode: 'advance' }] } })
    expect(read.heartbeat).toEqual({ enabled: true, intervalMinutes: 15, activeFrom: '08:00', activeTo: '23:00', projects: [{ name: 'alpha', mode: 'advance' }] })
    expect(machineOf(read).heartbeat).toEqual(read.heartbeat)
    expect(() => Config({ stateDir: '/srv/state', heartbeat: { intervalMinutes: 4 } })).toThrow()
    expect(() => Config({ stateDir: '/srv/state', heartbeat: { activeFrom: '8:00' } })).toThrow()
    expect(() => Config({ stateDir: '/srv/state', heartbeat: { projects: [{ name: 'alpha', mode: 'ship' }] } })).toThrow()
  })
})

describe('heartbeat window and interval', () => {
  const noon = new Date(2026, 10, 6, 12, 0)
  it('fires inside the active window and not outside it', () => {
    const day = config({ activeFrom: '08:00', activeTo: '23:00' })
    expect(inActiveWindow(day, new Date(2026, 10, 6, 7, 59))).toBe(false)
    expect(inActiveWindow(day, new Date(2026, 10, 6, 8, 0))).toBe(true)
    expect(inActiveWindow(day, new Date(2026, 10, 6, 22, 59))).toBe(true)
    expect(inActiveWindow(day, new Date(2026, 10, 6, 23, 0))).toBe(false)
    expect(heartbeatDue(day, noon)).toBe(true)
    expect(heartbeatDue(day, new Date(2026, 10, 6, 23, 30))).toBe(false)
  })
  it('handles a window that wraps past midnight', () => {
    const night = config({ activeFrom: '22:00', activeTo: '06:00' })
    expect(inActiveWindow(night, new Date(2026, 10, 6, 22, 0))).toBe(true)
    expect(inActiveWindow(night, new Date(2026, 10, 6, 23, 30))).toBe(true)
    expect(inActiveWindow(night, new Date(2026, 10, 7, 5, 59))).toBe(true)
    expect(inActiveWindow(night, new Date(2026, 10, 7, 6, 0))).toBe(false)
    expect(inActiveWindow(night, noon)).toBe(false)
  })
  it('waits a whole interval after the last message', () => {
    const every30 = config({ intervalMinutes: 30 })
    expect(heartbeatDue(every30, noon, new Date(noon.getTime() - 29 * 60_000))).toBe(false)
    expect(heartbeatDue(every30, noon, new Date(noon.getTime() - 30 * 60_000))).toBe(true)
    expect(heartbeatDue(every30, noon, new Date(noon.getTime() + 60_000))).toBe(false)
    expect(heartbeatDue(every30, noon)).toBe(true)
  })
  it('does nothing when the switch is off', async () => {
    const deliver = vi.fn()
    expect(heartbeatDue(config({ enabled: false }), noon)).toBe(false)
    expect(await deliverHeartbeat({ config: config({ enabled: false }), masterId: HOST, now: noon, deliver })).toBeUndefined()
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe('heartbeat message', () => {
  it('carries the four parts and renders the three authorization modes', () => {
    const text = heartbeatText(config({
      projects: [{ name: 'alpha', mode: 'advance' }, { name: 'beta', mode: 'review' }, { name: 'gamma', mode: 'readonly' }],
    }), new Date(2026, 10, 6, 14, 30))
    expect(text).toContain('【定时心跳】2026-11-06 14:30')
    expect(text).toContain('① 授权清单')
    expect(text).toContain('- alpha：可自主推进')
    expect(text).toContain('- beta：只改到待验收')
    expect(text).toContain('- gamma：只读')
    expect(text).toContain('② 每轮动作')
    expect(text).toContain('③ 红线')
    expect(text).toContain('④ 汇报')
    expect(text).toContain('不部署、不推远端、不删除文件')
    expect(text).toContain('连续无进展时降低频率')
  })
  it('keeps the round silent when no project is authorized', () => {
    const text = heartbeatText(config({ projects: [] }), new Date(2026, 10, 6, 14, 30))
    expect(text).toContain('当前没有授权项目，本轮只做状态检查并静默。')
    expect(text).toContain('① 授权清单')
    expect(text).toContain('④ 汇报')
  })
})

describe('heartbeat delivery', () => {
  it('delivers once per time bucket, and again in the next bucket', async () => {
    const target = delivery()
    const at = new Date(2026, 10, 6, 14, 30, 0)
    const every30 = config({ projects: [{ name: 'alpha', mode: 'advance' }] })
    expect(await deliverHeartbeat({ config: every30, masterId: HOST, now: at, deliver: target.deliver }))
      .toBe(heartbeatRequestId(HOST, at))
    // The same local minute, as a second tick or a hot reload computes it: the same id and no second message.
    await deliverHeartbeat({ config: every30, masterId: HOST, now: new Date(at.getTime() + 45_000), deliver: target.deliver })
    expect(target.followup).toHaveBeenCalledOnce()
    // A later bucket after the interval is a new message.
    const later = new Date(at.getTime() + 30 * 60_000)
    await deliverHeartbeat({ config: every30, masterId: HOST, now: later, lastAt: at, deliver: target.deliver })
    expect(target.followup).toHaveBeenCalledTimes(2)
    expect(heartbeatRequestId(HOST, later)).not.toBe(heartbeatRequestId(HOST, at))
  })
  it('stays silent before the interval has passed', async () => {
    const deliver = vi.fn()
    const at = new Date(2026, 10, 6, 14, 30)
    expect(await deliverHeartbeat({ config: config(), masterId: HOST, now: at,
      lastAt: new Date(at.getTime() - 10 * 60_000), deliver })).toBeUndefined()
    expect(deliver).not.toHaveBeenCalled()
  })
})
