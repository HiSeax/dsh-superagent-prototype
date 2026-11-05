/** Local DSH Session Source loops: the channel Sessions' health and the intake of a person's message. */
import { setTimeout as delay } from 'node:timers/promises'
import { threadKey, type Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext, type SourceHost } from './host.ts'
import type { SourceKind } from './kind.ts'
import type { LocalConfig } from './local.ts'
import { SOURCE } from './local-trigger.ts'

/** The Source's one health entry: whether every configured channel Session still exists. */
export const LOCAL_HEALTH = 'local'
/** How often the configured channel Sessions are checked. */
const CHECK_MS = 30_000
/** Hands one Trigger to the Engine and labels its Thread after the channel Session's configured name. */
export async function receiveLocal(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const name = ctx.config<LocalConfig>(SOURCE)?.sessions.find(row => row.sessionId === trigger.meta.sessionId)?.name
  const label = name || String(trigger.meta.sessionId ?? '')
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { label })
}
/** Reports whether the configured channel Sessions exist, naming the ones that do not; runs until `signal` aborts. */
export async function runLocal(host: SourceHost, kind: SourceKind<LocalConfig>, signal: AbortSignal): Promise<void> {
  const ctx = sourceContext(host, kind)
  await ctx.ready
  while (!signal.aborted) {
    const config = ctx.config<LocalConfig>(SOURCE)
    if (!config) ctx.report(LOCAL_HEALTH, health('paused', 'sourceOff'))
    else if (!config.sessions.length) ctx.report(LOCAL_HEALTH, { state: 'paused', detail: 'No local DSH Session is configured as a channel' })
    else {
      const missing: string[] = []
      for (const row of config.sessions) if (!await host.dshSessions.exists(row.sessionId)) missing.push(row.sessionId)
      ctx.report(LOCAL_HEALTH, missing.length
        ? { state: 'error', at: new Date().toISOString(), detail: `No such local DSH Session: ${missing.join(', ')}` }
        : { state: 'ready', at: new Date().toISOString(), detail: `${config.sessions.length} channel Sessions` })
    }
    await delay(CHECK_MS, undefined, { signal }).catch(() => { /* Aborted while waiting; the loop ends below. */ })
  }
}