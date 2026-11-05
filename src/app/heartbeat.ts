/**
 * The periodic heartbeat: one structured follow-up message to the main Session every `intervalMinutes` while the local
 * clock is inside the allowed window. The message starts nothing by itself; it restates the authorization list and the
 * action loop so a project the user authorized keeps moving instead of stopping after one step.
 *
 * The request id is derived from the local minute, so a second tick in the same minute, or a plugin hot reload, computes
 * the same id and `AgentDelivery` drops the duplicate.
 */
import { key } from '../core/index.ts'
import type { HeartbeatConfig, HeartbeatMode } from '../deployment.ts'

export type { HeartbeatConfig, HeartbeatMode }
/** A heartbeat ticks this often; the interval itself is checked against the last delivery, not the tick. */
export const HEARTBEAT_TICK_MS = 60_000
/** What the Runtime uses when no heartbeat is configured: switched off, with the documented defaults. */
export const NO_HEARTBEAT: HeartbeatConfig = { enabled: false, intervalMinutes: 30, activeFrom: '08:00', activeTo: '23:00', projects: [] }
const MODE_LABEL: Record<HeartbeatMode, string> = {
  advance: '可自主推进（完成一个实质步骤、跑验证、写记录）',
  review: '只改到待验收（改完即停，等用户验收后再继续）',
  readonly: '只读（只检查状态，不改文件、不开工）',
}
const pad = (value: number): string => String(value).padStart(2, '0')
/** Minutes after local midnight of a `HH:mm` clock, or `undefined` when the text is not a valid clock. */
export function clockMinutes(clock: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(clock)
  if (!match) return undefined
  const hours = Number(match[1]), minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined
}
/** Whether `now` is inside the local active window; a window whose end is at or before its start wraps past midnight. */
export function inActiveWindow(config: HeartbeatConfig, now: Date): boolean {
  const start = clockMinutes(config.activeFrom), end = clockMinutes(config.activeTo)
  if (start === undefined || end === undefined) return false
  if (start === end) return true
  const current = now.getHours() * 60 + now.getMinutes()
  return start < end ? current >= start && current < end : current >= start || current < end
}
/** Whether the heartbeat owes a message now: switched on, inside the window, and a whole interval after the last one. */
export function heartbeatDue(config: HeartbeatConfig, now: Date, lastAt?: Date): boolean {
  if (!config.enabled || !inActiveWindow(config, now)) return false
  if (!lastAt) return true
  return now.getTime() - lastAt.getTime() >= config.intervalMinutes * 60_000
}
/** The local `yyyy-MM-dd HH:mm` stamp named in the message. */
const localStamp = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
  + `${pad(at.getHours())}:${pad(at.getMinutes())}`
/** The idempotency id of the message for this local minute: one delivery per instance and time bucket. */
export const heartbeatRequestId = (masterId: string, now: Date): string => key('heartbeat', masterId,
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`)
/** The authorization list of the message, one line per project; an empty list says to stay silent. */
function authorization(config: HeartbeatConfig): string {
  if (!config.projects.length) return '当前没有授权项目，本轮只做状态检查并静默。'
  return config.projects.map(project => `- ${project.name}：${MODE_LABEL[project.mode]}`).join('\n')
}
/** The fixed four-part heartbeat message: authorization, each round's actions, the red lines, and the report rule. */
export function heartbeatText(config: HeartbeatConfig, now: Date): string {
  return [
    `【定时心跳】${localStamp(now)}，例行跟进一次。不需要用户先说话，请按下述授权继续推进。`,
    `① 授权清单\n${authorization(config)}`,
    '② 每轮动作\n'
      + '1. 查 git 状态与待办，确认工作树干净、没有未完成的分支；\n'
      + '2. 只选一个授权项目，推进一个实质步骤，不铺开多个；\n'
      + '3. 跑该项目的验证（typecheck / test / build，或项目约定的命令）；\n'
      + '4. 把本轮做了什么、结果如何写进项目记录。',
    '③ 红线\n'
      + '- 清单之外的项目与文件一律不碰；\n'
      + '- 不部署、不推远端、不删除文件；\n'
      + '- 遇到需要用户决策的问题立即停下并报告，不自行猜测。',
    '④ 汇报\n'
      + '- 只有产生实质进展才发消息汇报；\n'
      + '- 连续无进展时降低频率，不要刷屏。',
  ].join('\n\n')
}
/** What one heartbeat delivery needs: its settings, whose Session receives it, the clock, the last delivery, and delivery. */
export interface HeartbeatHost {
  config: HeartbeatConfig
  masterId: string
  now: Date
  lastAt?: Date | undefined
  /** Delivers once per request id, as `Sessions.relay` does. */
  deliver(requestId: string, text: string): void | Promise<void>
}
/** Delivers the heartbeat when it is due; returns its request id, or `undefined` when it is not due or switched off. */
export async function deliverHeartbeat(host: HeartbeatHost): Promise<string | undefined> {
  if (!heartbeatDue(host.config, host.now, host.lastAt)) return undefined
  const requestId = heartbeatRequestId(host.masterId, host.now)
  await host.deliver(requestId, heartbeatText(host.config, host.now))
  return requestId
}
