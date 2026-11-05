#!/usr/bin/env node
/**
 * Windows-friendly manager for a local dsh-superagent service (one DSH profile, default `superagent`).
 *
 * This is a port of `scripts/dsh-superagent` (Python + tmux + fcntl), which cannot run on Windows:
 * there is no tmux and no fcntl. It keeps the documented exit codes and JSON output:
 * `status`, `start`, and `restart` exit 0 while the service runs normally; 1 when it is stopped,
 * duplicated, unreachable, or reporting a runtime error, which `restart` may fix; 2 when it runs
 * while a component such as a Source reports an error; and 3 when it runs and waits for setup.
 *
 * Differences from the Unix script on Windows:
 * - The service is a detached child process (`dsh --profile <profile> --no-open`), not a tmux pane.
 * - `stop` pauses processing through the management API, waits for running Executors, then
 *   terminates the process tree with `taskkill`. Before it does, it verifies that the recorded PID
 *   still belongs to this profile's dsh process: Windows reuses PIDs, and a stale `service.pid`
 *   must never let `taskkill /T /F` hit an unrelated process tree.
 * - Discovery uses `<control>/service.pid`; it does not scan the process table.
 * - Extra environment for the service (for example `GH_CONFIG_DIR`) is read from
 *   `<repo>/.artifacts/service-env.json`, and `DSH_SUPERAGENT_DSH` may name the DSH entry point.
 * - The DSH entry point must be 0.2 or newer: a 0.1.x `dsh` on PATH has no `--profile`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ARTIFACTS = join(ROOT, '.artifacts')
const CONTROL = join(ARTIFACTS, 'control')
const KEEP_LOGS = 20
const PART_ERROR = 2
const SETUP_WAITS = 3
/** The plugin locks `<stateDir>.lock` through proper-lockfile with a 30 s staleness window; a force-killed process never releases it. */
const LOCK_STALE_MS = 30_000
/** The first DSH version whose CLI takes `--profile`. */
const MIN_DSH = [0, 2]

/** Read the profile's `stateDir` machine setting, the path the plugin locks. */
function stateDirOf(profile) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    const text = readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
    const match = /^\s*stateDir:\s*(\S.*)$/m.exec(text)
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '')
  } catch { /* The profile may not exist yet. */ }
  return undefined
}

/** Remove a leftover state lock; without `force`, only once proper-lockfile would treat it as stale. */
function clearLock(profile, { force = false } = {}) {
  const stateDir = stateDirOf(profile)
  if (!stateDir) return false
  const lock = stateDir + '.lock'
  try {
    const age = Date.now() - statSync(lock).mtimeMs
    if (!force && age < LOCK_STALE_MS + 1000) return false
    rmSync(lock, { recursive: true, force: true })
    return true
  } catch { return false }
}

const control = profile => {
  const directory = join(CONTROL, 'profiles', profile)
  mkdirSync(directory, { recursive: true })
  return directory
}
const stopped = profile => existsSync(join(control(profile), 'manually-stopped'))

/** Read the JSON map of extra environment variables for the service, if one exists. */
function serviceEnv() {
  const file = join(ARTIFACTS, 'service-env.json')
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

/** Parse the version of a DSH entry point, or undefined when it cannot be read. */
function dshVersion(dsh) {
  const result = spawnSync(dsh, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000, shell: /\.(cmd|bat)$/i.test(dsh) })
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(result.stdout ?? '') + String(result.stderr ?? ''))
  return match ? match.slice(1).map(Number) : undefined
}

/**
 * Resolve the DSH entry point: `--dsh`, the service environment, a bundled CLI under `src/dsh-cli`, or `dsh` on PATH.
 * A version older than 0.2 is refused: `dsh plugin` and `dsh --profile` do not exist there, and the service would start
 * the operator's other profile instead.
 */
function dshCommand(args) {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const candidates = [args.dsh, serviceEnv().DSH_SUPERAGENT_DSH, join(ROOT, '..', 'dsh-cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
  const found = []
  for (const candidate of candidates) if (candidate && existsSync(candidate)) found.push(candidate)
  const which = spawnSync(finder, ['dsh'], { encoding: 'utf8', windowsHide: true })
  found.push(...String(which.stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean))
  for (const candidate of found) {
    const version = dshVersion(candidate)
    if (version && (version[0] > MIN_DSH[0] || version[0] === MIN_DSH[0] && version[1] >= MIN_DSH[1])) return candidate
    if (version) console.error(`skipping ${candidate}: dsh ${version.join('.')} is older than ${MIN_DSH.join('.')}`)
  }
  throw new Error('no dsh 0.2 or newer was found; pass --dsh <path to the DSH entry point> or set DSH_SUPERAGENT_DSH')
}

/** Fetch health and setup status from the management API, or return null if unreachable. */
async function state(url) {
  try {
    const response = await fetch(url.replace(/\/+$/, '') + '/orchestrator/api/state',
      { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(2000) })
    if (!response.ok) return null
    const value = await response.json()
    // Keys omitted by another version read as empty so the service is not mistaken for unreachable.
    const health = value?.health ?? {}
    const setup = value?.setup ?? {}
    const entries = Object.fromEntries(Object.entries(health).map(([name, entry]) => [name, entry && typeof entry === 'object' ? entry : {}]))
    return {
      health: Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.state])),
      errors: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.state === 'error').map(([name, entry]) => [name, String(entry.detail ?? '')])),
      setup: setup.problem ?? null,
      feishu: setup.feishuProblem ?? null,
      load: value?.load ?? null,
      paused: value?.paused === true,
    }
  } catch { return null }
}

/** Send one management API request; returns the parsed body or null. */
async function call(url, method, path, body) {
  try {
    const response = await fetch(url.replace(/\/+$/, '') + '/orchestrator/api/' + path, {
      method,
      headers: { 'x-orchestrator-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    })
    return await response.json().catch(() => null)
  } catch { return null }
}

const runtimeUp = current => current !== null && ['ready', 'paused'].includes(current.health.runtime)
const partErrors = current => Object.fromEntries(Object.entries(current?.errors ?? {}).filter(([name]) => name !== 'runtime').sort(([a], [b]) => a.localeCompare(b)))

/** Compute the CLI exit code from running PIDs and management API state. */
function outcome(pids, current) {
  if (pids.length !== 1 || !runtimeUp(current)) return 1
  if (current.setup) return SETUP_WAITS
  return Object.keys(partErrors(current)).length ? PART_ERROR : 0
}

const runningPids = profile => {
  let pid
  try { pid = Number(readFileSync(join(control(profile), 'service.pid'), 'utf8').trim()) } catch { return [] }
  if (!Number.isInteger(pid) || pid <= 0) return []
  try { process.kill(pid, 0); return [pid] } catch { return [] }
}

/** Read a process's image name and command line on Windows, or undefined when it cannot be read. */
function processInfo(pid) {
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue; if ($p) { $p.ProcessId; $p.Name; $p.CommandLine }`
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  if (result.status !== 0) return undefined
  const [id, name, ...command] = String(result.stdout ?? '').split(/\r?\n/).filter(line => line.trim())
  if (!id || Number(id.trim()) !== pid) return undefined
  return { name: String(name ?? '').trim(), command: command.join(' ') }
}

/**
 * Whether the recorded PID still is this profile's dsh process. Windows reuses PIDs, so liveness alone is not enough:
 * `taskkill /T /F` on a reused PID would kill an unrelated process tree. The check is fail-closed: when the process
 * cannot be inspected, nothing is killed and the operator is told what to do.
 */
function verifyServicePid(pid, profile) {
  if (process.platform !== 'win32') return { ok: true }
  const info = processInfo(pid)
  if (!info) return { ok: false, reason: `PID ${pid} could not be inspected` }
  const command = info.command || ''
  const namedProfile = new RegExp(`--profile\\s+["']?${profile.replaceAll('-', '\\-')}["']?(?=\\s|$)`).test(command)
  const isDsh = /dsh/i.test(command) || /^(node|dsh)\.exe$/i.test(info.name)
  if (!namedProfile || !isDsh) {
    return { ok: false, reason: `PID ${pid} is ${info.name}, not this profile's dsh (${command.slice(0, 120) || 'no command line'})` }
  }
  return { ok: true, info }
}

async function status(args) {
  const pids = runningPids(args.profile)
  const current = pids.length ? await state(args.url) : null
  console.log(JSON.stringify({
    pids, cwd: ROOT, url: args.url, manually_stopped: stopped(args.profile),
    health: current?.health, errors: current?.errors, setup: current?.setup, feishu: current?.feishu,
  }, null, 2))
  return outcome(pids, current)
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

function pruneLogs(profile) {
  const prefix = `dsh-superagent-${profile}-`
  const logs = readdirSync(ARTIFACTS)
    .filter(name => name.startsWith(prefix) && name.endsWith('.log'))
    .map(name => join(ARTIFACTS, name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  for (const path of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) { try { unlinkSync(path) } catch { /* Raced with another prune. */ } }
}

/**
 * Git for Windows ships `sh.exe` and `env.exe` under `usr\bin`, which the Git installer does not add to PATH.
 * The plugin's setup probe runs those programs, so a service started from a process without those directories
 * (for example the DSH desktop app) fails with `spawn ... ENOENT`.
 */
function ensureGitBashPath(baseEnv) {
  if (process.platform !== 'win32') return baseEnv
  const key = Object.keys(baseEnv).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = String(baseEnv[key] ?? '').split(';').filter(Boolean)
  const lower = new Set(current.map(entry => entry.toLowerCase()))
  const extras = []
  for (const root of ['C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git']) {
    if (!existsSync(root)) continue
    for (const sub of ['cmd', 'usr\\bin', 'mingw64\\bin', 'bin']) {
      const dir = join(root, sub)
      if (existsSync(dir) && !lower.has(dir.toLowerCase()) && !extras.some(entry => entry.toLowerCase() === dir.toLowerCase())) extras.push(dir)
    }
  }
  return extras.length ? { ...baseEnv, [key]: [...extras, ...current].join(';') } : baseEnv
}

async function start(args) {
  let pids = runningPids(args.profile)
  if (pids.length > 1) throw new Error('Multiple dsh-superagent processes found; refusing to start another.')
  const dir = control(args.profile)
  if (pids.length === 0) {
    if (await state(args.url) !== null) throw new Error('An existing orchestrator answers at this URL; refusing duplicate startup.')
    // Nothing answers at the URL and no service pid is alive, so any lock directory left over cannot belong to a
    // running service: clearing it disregards the 30 s staleness window that makes an immediate restart fail.
    if (clearLock(args.profile, { force: true })) console.log('Removed a stale state lock left by a killed process.')
    const dsh = dshCommand(args)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const log = join(ARTIFACTS, `dsh-superagent-${args.profile}-${stamp}-${process.pid}.log`)
    writeFileSync(log, '')
    pruneLogs(args.profile)
    const env = ensureGitBashPath({ ...process.env, ...serviceEnv() })
    const argv = ['--profile', args.profile, '--no-open']
    const file = openSync(log, 'a')
    let child
    if (/\.(cmd|bat)$/i.test(dsh)) child = spawn(dsh, argv, { cwd: ROOT, env, detached: true, windowsHide: true, stdio: ['ignore', file, file], shell: true })
    else if (/\.(c|m)?js$/i.test(dsh)) child = spawn(process.execPath, [dsh, ...argv], { cwd: ROOT, env, detached: true, windowsHide: true, stdio: ['ignore', file, file] })
    else child = spawn(dsh, argv, { cwd: ROOT, env, detached: true, windowsHide: true, stdio: ['ignore', file, file] })
    child.unref()
    closeSync(file)
    writeFileSync(join(dir, 'service.pid'), `${child.pid}\n`)
    console.log('Log: ' + log)
  } else {
    writeFileSync(join(dir, 'service.pid'), `${pids[0]}\n`)
    console.log(`dsh-superagent already running (PID ${pids[0]}); no duplicate started.`)
  }
  try { unlinkSync(join(dir, 'manually-stopped')) } catch { /* No intentional stop. */ }
  const deadline = Date.now() + args.timeout * 1000
  while (Date.now() < deadline) {
    const current = await state(args.url)
    if (runningPids(args.profile).length && runtimeUp(current)) {
      const code = await status(args)
      if (current.setup) {
        console.log('dsh-superagent is waiting for setup: ' + String(current.setup.detail ?? ''))
        console.log('Open ' + args.url + ' , then the dsh-superagent overview.')
      }
      if (current.feishu) {
        console.log('dsh-superagent runs without Feishu: ' + String(current.feishu.detail ?? ''))
        console.log('Fix it on the Feishu card of the Source settings.')
      }
      for (const [name, detail] of Object.entries(partErrors(current))) console.log(`${name} reports an error, which a restart does not fix: ${detail}`)
      return code
    }
    await sleep(1000)
  }
  await status(args)
  throw new Error('Startup health check timed out; inspect the log. Any running process was left intact. '
    + 'If the log reports "Lock file is already being held", run stop then start.')
}

async function stop(args, intentional = true) {
  const pids = runningPids(args.profile)
  if (pids.length > 1) throw new Error('Multiple dsh-superagent processes found; refusing to choose one.')
  const dir = control(args.profile)
  // Write the stop marker before waiting so monitors respect the intentional stop even if graceful shutdown times out.
  if (intentional) writeFileSync(join(dir, 'manually-stopped'), new Date().toISOString() + '\n')
  if (pids.length) {
    // Refuse before touching anything: a stale pid file must not let a force-kill reach another process tree.
    const verified = verifyServicePid(pids[0], args.profile)
    if (!verified.ok) {
      throw new Error(`${verified.reason}. Nothing was killed. Run "status" outside a restart; if no dsh-superagent runs, delete ${join(dir, 'service.pid')}.`)
    }
    // Pause processing and let running Executors finish their step; Windows cannot deliver SIGINT.
    await call(args.url, 'POST', 'executor/pause', { paused: true })
    const deadline = Date.now() + args.stopTimeout * 1000
    for (;;) {
      const current = await state(args.url)
      if (!current || (current.load?.running ?? 0) === 0) break
      if (Date.now() >= deadline) throw new Error('Graceful stop timed out; no forced kill was sent. Check status.')
      await sleep(500)
    }
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pids[0]), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else process.kill(pids[0], 'SIGINT')
    for (;;) {
      if (runningPids(args.profile).length === 0) break
      if (Date.now() >= deadline) throw new Error('Graceful stop timed out; the process is still running. Check status.')
      await sleep(500)
    }
  }
  // A force-killed process keeps proper-lockfile's directory (30 s staleness) although its owner is gone.
  // Clear it even when no live pid was found: an earlier failed start can leave the pid file gone while the
  // lock directory is still fresh, and a start within 30 s would then fail with "Lock file is already being held".
  clearLock(args.profile, { force: true })
  try { unlinkSync(join(dir, 'service.pid')) } catch { /* Already gone. */ }
  console.log(intentional ? 'dsh-superagent stopped. Automatic recovery is paused until start/restart.' : 'dsh-superagent stopped.')
}

/** Take an exclusive operation lock; a lock whose process is gone is replaced. */
function lock(profile) {
  const file = join(control(profile), 'operation.lock')
  const acquire = () => {
    try { writeFileSync(file, `${process.pid}\n`, { flag: 'wx' }); return }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let owner = 0
      try { owner = Number(readFileSync(file, 'utf8').trim()) } catch { /* Treat as stale. */ }
      let alive = false
      try { if (owner) { process.kill(owner, 0); alive = true } } catch { /* Stale. */ }
      if (alive) throw new Error('Another dsh-superagent control operation is in progress.')
      try { unlinkSync(file) } catch { /* Raced. */ }
      try { writeFileSync(file, `${process.pid}\n`, { flag: 'wx' }) } catch { throw new Error('Another dsh-superagent control operation is in progress.') }
    }
  }
  acquire()
  return () => { try { unlinkSync(file) } catch { /* Already gone. */ } }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: 'string', default: process.env.DSH_SUPERAGENT_PROFILE || 'superagent' },
      url: { type: 'string', default: process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082' },
      timeout: { type: 'string', default: '60' },
      'stop-timeout': { type: 'string', default: '300' },
      'respect-stop': { type: 'boolean', default: false },
      dsh: { type: 'string' },
    },
  })
  const args = {
    action: positionals[0],
    profile: values.profile,
    url: values.url,
    timeout: Number(values.timeout),
    stopTimeout: Number(values['stop-timeout']),
    respectStop: values['respect-stop'],
    dsh: values.dsh,
  }
  if (!['start', 'stop', 'restart', 'status'].includes(args.action)) throw new Error('action must be start, stop, restart or status')
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(args.profile)) throw new Error('--profile must be a DSH profile name')
  if (!(args.timeout > 0) || !(args.stopTimeout > 0)) throw new Error('--timeout and --stop-timeout must be positive')
  mkdirSync(ARTIFACTS, { recursive: true })
  const unlock = lock(args.profile)
  try {
    if (args.respectStop && ['start', 'restart'].includes(args.action) && stopped(args.profile)) {
      console.log('Intentional stop is active; automatic recovery skipped.')
      return 0
    }
    if (args.action === 'status') return await status(args)
    if (['stop', 'restart'].includes(args.action)) await stop(args, args.action === 'stop')
    if (['start', 'restart'].includes(args.action)) return await start(args)
    return 0
  } finally { unlock() }
}

main().then(code => process.exit(code)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
