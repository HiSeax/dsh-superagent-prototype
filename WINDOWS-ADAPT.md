# Windows adaptation (this branch)

This branch carries **only** the Windows adaptation of dsh-superagent. It is carved out of
[`vHao11/dsh-superagent@windows-adapt`](https://github.com/vHao11/dsh-superagent/tree/windows-adapt)
(2026-11-05, commit `b0ca277`), which mixes the adaptation with unrelated features. Nothing from
that branch's feature work is included here.

## Why a separate branch

The upstream prototype is Unix-only in practice:

- `scripts/dsh-superagent` is Python using `fcntl` and `tmux`;
- `src/infra/environment.ts` writes `#!/bin/sh` worker shims with mode `0755`;
- `src/app/sessions.ts` names the `bash` tool, which Windows DSH does not register
  (`tools.restrict` then refuses to mount the plugin);
- `src/deployment.ts` accepts only `/…` absolute paths and resolves command names without `PATHEXT`.

`package.json` declares no `os` field, so it installs on Windows and then fails at runtime.

## What this branch changes

| File | Change |
|---|---|
| `src/deployment.ts` | Absolute-path pattern accepts drive and UNC paths; `executable()` appends `PATHEXT` and accepts backslashes; setup probes pass the child environment instead of the `env` program (absent outside Git's `usr\bin`) |
| `src/app/sessions.ts` | `SHELL_TOOL` — `pwsh` on Windows, `bash` elsewhere — for the no-wait guard and the main Session's tool allowlist |
| `src/infra/commands.ts` | `windowsHide: true`, so `gh` polling does not flash console windows |
| `src/infra/environment.ts` | Credential helper path uses forward slashes; directory comparison ignores case; git's `--show-origin` output is normalized before comparison |
| `src/app/runtime.ts` | `waitForStateLock()` waits out proper-lockfile's 30 s staleness window after a force-killed host |
| `src/index.ts` | Calls `waitForStateLock()` before constructing `Runtime` |
| `scripts/dsh-superagent.mjs`, `.cmd` | Service manager without tmux/fcntl, keeping the upstream exit codes (0/1/2/3) and `--respect-stop` semantics |
| `scripts/install-windows.ps1` | Links explicitly named profiles through `dsh plugin add`; refuses a DSH older than 0.2 |

### Hardening added on top of the source branch

- **PID identity check before `taskkill /T /F`.** The source branch records the service PID and only
  checks that it is alive. Windows reuses PIDs, so a stale `service.pid` could make a force-kill hit
  an unrelated process tree. This branch inspects the image name and command line first and is
  fail-closed: if the recorded PID is not this profile's dsh, nothing is killed and the operator is
  told what to do.
- **DSH version gate.** The service manager skips any `dsh` older than 0.2 instead of starting it;
  0.1.x has no `--profile`.
- **Explicit profiles only.** The installer touches the profiles passed in `-Profile`; the source
  branch rewrites every profile that happens to depend on `dsh-superagent`.

## What this branch deliberately does not carry

| Excluded | Why |
|---|---|
| `src/executor/claude-code.ts` (1080 lines) | Native Claude Code executor: replaces the worker's `ReactLoopAgent.step()` and bypasses DSH's tool guards. Unrelated to Windows. |
| `src/sources/schedule.ts` | Interval-trigger Source, enabled by default in the bundle patch. Unrelated. |
| Task types (`taskTypes`, `defaultTaskType` removal) | Feature; and the reason the source branch migrates the database. |
| `src/core/operator.ts` | New internal Source. Unrelated. |
| Panel/standalone client changes | UI feature work, including a React-bundled page for DSH NEXT. Unrelated. |
| Schema 11 → 12 migration | Only needed for task types. Keeping schema 11 means a database stays readable by upstream builds. |

## Known limitations

- `blockedCommands` has no effect on Windows: the worker shim that blocks a command is a `#!/bin/sh`
  script. Commands the operator blocks are therefore **not blocked** for workers; use the agent's
  own GitHub account and a dedicated OS account if that isolation matters.
- The service manager has **no automated tests**. The existing `tests/service-script.spec.ts` covers
  the Python script and needs `sleep`/`tmux`; it fails on Windows by construction.
- Tests that create symlinks or compare `chmod` modes fail on a standard Windows account (symlinks
  need Developer Mode or elevation). They are environment failures, not code failures.
- Stopping is `pause` + `taskkill`, which does not wait for Session cleanup callbacks. SQLite is
  crash-safe, so this is acceptable.

## Usage

Create the profile first (from a DSH 0.2+ CLI), then link this checkout:

```powershell
$dsh = "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh superagent --from-default-profile web
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Profile superagent -Dsh $dsh -DryRun
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Profile superagent -Dsh $dsh
```

Configure `stateDir` (an absolute Windows path) in `<DSH_HOME>\profiles\superagent\cordis.patch.yml`,
then:

```powershell
node scripts\dsh-superagent.mjs status  --profile superagent   # 0 healthy / 1 down or broken / 2 a part failed / 3 waiting for setup
node scripts\dsh-superagent.mjs start   --profile superagent
```

The panel URL with its one-time token is printed in `.artifacts\dsh-superagent-superagent-*.log`.
