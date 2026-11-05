import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentDelivery } from '../src/app/delivery.ts'
import { bootNoticeText, bootRequestId, deliverBootNotice, hostBootAt, lastBootLine, watchdogLog } from '../src/app/boot-notice.ts'

const HOST = 'orchestrator-test'
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

describe('boot self-check', () => {
  it('reaches the main Session once for one host boot, and again after a host restart', async () => {
    const target = delivery()
    const bootAt = new Date('2026-11-06T00:29:45+08:00')
    expect(await deliverBootNotice({ enabled: true, masterId: HOST, bootAt, deliver: target.deliver }))
      .toBe(bootRequestId(HOST, bootAt))
    // The same boot again, as a plugin hot reload computes it: the same request id, and no second message.
    await deliverBootNotice({ enabled: true, masterId: HOST, bootAt: new Date(bootAt.getTime()), deliver: target.deliver })
    expect(target.followup).toHaveBeenCalledOnce()
    // A real host restart a few minutes later is a different boot.
    await deliverBootNotice({ enabled: true, masterId: HOST, bootAt: new Date(bootAt.getTime() + 5 * 60_000), deliver: target.deliver })
    expect(target.followup).toHaveBeenCalledTimes(2)
  })
  it('recomputes the same boot instant across a reload in one process', () => {
    const first = hostBootAt(), second = hostBootAt()
    expect(second.toISOString()).toBe(first.toISOString())
    expect(bootRequestId(HOST, second)).toBe(bootRequestId(HOST, first))
  })
  it('does nothing when the switch is off', async () => {
    const deliver = vi.fn()
    expect(await deliverBootNotice({ enabled: false, masterId: HOST, bootAt: new Date(), deliver })).toBeUndefined()
    expect(deliver).not.toHaveBeenCalled()
  })
  it('names the boot time and the watchdog\'s newest start line, and omits the line when unreadable', () => {
    const bootAt = new Date(2026, 10, 6, 0, 29, 45)
    expect(bootNoticeText(bootAt)).toContain('【启动自检】宿主启动于 2026-11-06 00:29:45')
    expect(bootNoticeText(bootAt)).not.toContain('重启记录')
    expect(bootNoticeText(bootAt, '[2026-11-06 00:29:45] watchdog started (pid 3808)'))
      .toContain('重启记录：[2026-11-06 00:29:45] watchdog started (pid 3808)')
    const directory = mkdtempSync(join(tmpdir(), 'boot-'))
    const file = join(directory, 'desktop-watchdog.log')
    writeFileSync(file, '[2026-11-05 20:00:00] watchdog stopped\n[2026-11-06 00:29:45] watchdog started (pid 3808)\n')
    expect(lastBootLine(file)).toBe('[2026-11-06 00:29:45] watchdog started (pid 3808)')
    expect(lastBootLine(join(directory, 'missing.log'))).toBeUndefined()
    expect(watchdogLog()).toContain('desktop-watchdog.log')
  })
})