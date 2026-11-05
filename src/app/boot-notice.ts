/**
 * The host-start self-check: one wake-up message to the orchestrator's own Session per host boot.
 *
 * It carries no instruction to start work and changes no state; the main Session reads it and decides. The message id is
 * derived from the host's start instant, so a plugin hot reload in the same host process computes the same id and
 * `AgentDelivery` drops the duplicate, while a real host restart produces a new one.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { key } from '../core/index.ts'

/** The desktop watchdog's log, below `DSH_HOME`; its newest start line names when the host last came up. */
export const WATCHDOG_LOG = 'daemon/desktop-watchdog.log'
/** How much of the log's tail is read: enough for the last start line without loading a long log. */
const TAIL_BYTES = 64 * 1024
/** The host's watchdog log, overridable for deployments that keep it elsewhere. */
export const watchdogLog = (): string => process.env.DSH_SUPERAGENT_WATCHDOG_LOG
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), WATCHDOG_LOG)
/** The instant this host process started, floored to a whole second so a reload recomputes the same value. */
export const hostBootAt = (): Date => new Date(Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000)
/** The idempotency id of this host boot's notice: the boot instant and the main Session, so a restart differs. */
export const bootRequestId = (masterId: string, bootAt: Date): string => key('boot-notice', masterId, bootAt.toISOString())
const pad = (value: number): string => String(value).padStart(2, '0')
/** The local wall-clock stamp the message names: `yyyy-MM-dd HH:mm:ss`. */
const localStamp = (bootAt: Date): string => `${bootAt.getFullYear()}-${pad(bootAt.getMonth() + 1)}-${pad(bootAt.getDate())} `
  + `${pad(bootAt.getHours())}:${pad(bootAt.getMinutes())}:${pad(bootAt.getSeconds())}`
/** The fixed self-check message, with the watchdog's last start line when one could be read. */
export function bootNoticeText(bootAt: Date, watchdog?: string): string {
  const body = `【启动自检】宿主启动于 ${localStamp(bootAt)}。请检查：①未完成的工单与队友状态；②上次会话是否被中断；`
    + '③如需继续按清单恢复，不需要用户先说话。'
  return watchdog ? `${body}\n重启记录：${watchdog}` : body
}
/** The newest start line of the watchdog log, or the last line when none mentions a start; unreadable is `undefined`. */
export function lastBootLine(file: string): string | undefined {
  try {
    const size = statSync(file).size
    if (!size) return undefined
    const start = Math.max(0, size - TAIL_BYTES), length = size - start
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    try { readSync(fd, buffer, 0, length, start) } finally { closeSync(fd) }
    const lines = buffer.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const startLine = [...lines].reverse().find(line => /start|boot|启动/i.test(line)) ?? lines.at(-1)
    return startLine ? startLine.slice(0, 300) : undefined
  } catch { return undefined }
}
/** What the boot notice needs: whether it is enabled, whose Session gets it, and how a message is delivered once. */
export interface BootNoticeHost {
  enabled: boolean
  masterId: string
  bootAt: Date
  watchdog?: string | undefined
  /** Delivers once per request id, as `Sessions.prompt` or a durable relay does. */
  deliver(requestId: string, text: string): void | Promise<void>
}
/** Delivers the self-check once for this host boot; returns its request id, or `undefined` when switched off. */
export async function deliverBootNotice(host: BootNoticeHost): Promise<string | undefined> {
  if (!host.enabled) return undefined
  const requestId = bootRequestId(host.masterId, host.bootAt)
  await host.deliver(requestId, bootNoticeText(host.bootAt, host.watchdog))
  return requestId
}