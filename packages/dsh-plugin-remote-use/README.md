# @hope_phenom/dsh-plugin-remote-use

[中文说明 / Chinese: `README.zh.md`](README.zh.md)

Delegate [DSH](https://www.deepseek.com/) tasks to a paired **worker** on your LAN and drive it like a subagent.

**What it solves.** GUI automation and any verification that only a screen can answer has to run on a
machine that can really move a mouse and a keyboard. Doing that locally means **fighting the operator
for their own computer** — stealing focus, the cursor, the clipboard. This plugin pushes that part of
the work onto a dedicated node and keeps the reasoning on the master.

```text
master DSH ── ACP over WebSocket ──▶ worker relay ──▶ worker DSH (runs the task, screenshots, sees the GUI)
    │                                    ▲
    └── approvals / audit / per-session switch ──┘
```

## Install

**Install it through DSH's plugin manager** — it does all three things at once: fetches the package,
registers it in the profile's `bundles`, and enables it.

```
Plugin manager → Install → @hope_phenom/dsh-plugin-remote-use
```

Then **restart DSH**. That is the whole install: it is the same path any plugin takes.

<details>
<summary>Manual install (the fallback if the plugin manager will not cooperate)</summary>

```powershell
# Install into a profile -- this only puts the files there.
npm install --prefix "$env:USERPROFILE\.dsh\profiles\<profile>" @hope_phenom/dsh-plugin-remote-use
```

**Installing is not enough — the package name must also be added to that profile's
`dsh.profile.bundles`,** or it will not be loaded. The profile's `package.json` looks like this:

```json
"dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@hope_phenom/dsh-plugin-remote-use" ] } }
```

Then add **one kind** of entry to that profile's patch layer: the plugin's own config — the worker
list (url / token / cwd).

**No per-worker tool row is needed** (0.2.0 and later). Earlier versions asked for a
`dsh-tool-subagent` row per worker with `provider: remote-<worker id>`; that route does not work
even when written correctly, because a Web session's model-facing tool catalog is enumerated by the
**agent preset**, not by the loader tree. The plugin now registers its own delegation tool,
`remote_subagent`, by the same route its four `remote_*` tools already use. If you wrote a
`tool-subagent-remote-*` block from the old instructions, you can delete it.

</details>

> **Full instructions — copy-pasteable YAML, worker-side deployment, the security model and
> troubleshooting — are in the
> [repository README](https://github.com/Hope-Phenom/dsh-plugin-remote-use#readme).**
> This file covers only what an npm page has to make clear.

## Use (the short version)

1. **It is off by default.** In the session that should be able to reach a worker, type:

   ```text
   /remote-use on
   ```

   The switch is **per session and does not persist** — a restart puts it back to off, and in a new
   session the remote tools are not visible.

2. Let the model do the work that needs a GUI. It will call `remote_selfcheck` first to confirm the
   node is ready, and only then delegate.

| Tool the model sees | What it is for |
|---|---|
| `remote_subagent` | **Delegate a task to a paired worker**, and drive it like a subagent. `run_in_background: true` keeps the current conversation free |
| `remote_selfcheck` | The node's readiness report. **Call it before delegating** — a node that is not ready is refused by the dispatch gate |
| `remote_agents` | Task progress; `action: status` / `wait` for one task, and **it returns that task's answer text once the task has settled** |
| `remote_screenshot` | Capture the node's screen to the master, then look at it with `read_image` |
| `remote_file` | **Move files to and from a node** — `action: send` / `fetch` / `list` / `stat`. No SSH, no `scp`, no setup on the node, and it does **not** occupy the node's single GUI task slot, so a copy can run while a visual task is in flight |
| `remote_interrupt` | Stop a task (cooperative) |

Collecting a background delegation's answer — the only route back:

```text
remote_subagent { prompt: "…", run_in_background: true }   ->  taskId: rtask_xxx
remote_agents   { action: "status", taskId: "rtask_xxx" }  ->  state + the full answer
```

⚠️ `run_in_background: true` is **not "return immediately"**: a node runs one task at a time (the GUI is
an exclusive resource), so when the node is busy the call **first waits for its turn** (measured: 32
seconds on a busy worker).

The settings page (**Settings → Remote work nodes**) manages nodes, handles **escalation approvals**,
shows the **audit trail**, edits the delegation policy, and can **arm this machine as a worker**
(symmetric pairing).

> **The task directory (`cwd`) is an absolute path on the worker**: that is where the task runs and
> **the scope its sandbox may write to**. Fill it in once on the worker's arming panel and it goes
> **into the pairing string** (**0.2.1 and later**), so the master picks it up from the paste.
> The master **refuses to save** a worker without a usable task directory — such a worker can never
> accept a task.

## Security model (the essentials)

- **Off by default** — a new session injects no policy and cannot see the remote tools at all
- **The sandbox must actually hold** — if confinement cannot be *proved*, worker mode is **refused**,
  not warned about. What the worker needs (a materialized mediator, plus a `sandbox` row naming it) is
  **hand-deployed and can disappear**; the arming panel therefore reports it on **page load** and hands
  back a ready-to-run command (`lib/tools/prepare-sandbox-mediator.mjs`) instead of leaving the operator
  to reverse-engineer a three-layer error.
- **Escalation is never auto-approved** — `needsHuman` / `danger-full-access` go to a human queue, and
  a timeout counts as a refusal
- **The session's own sandbox level is a deployment setting, and it defaults to `danger-full-access`** —
  set it on the machine acting as the worker (**Settings → Remote work nodes → the sandbox level for this
  machine's remote sessions**), and it is written into the launch spec when the worker role is armed. It is
  a deployment value, not a per-task negotiation, for a measured reason: a GUI process that cannot start
  under a restricted token fails **silently** (the command returns success; only a desktop dialog is left),
  so that failure can never reach the approval queue. Set `workspace-write` for a worker that only runs
  confined work. The master sees the level the node actually reports.
- **Credentials never reach the browser** — the page only ever gets a mask
- The node must be **genuinely logged in to a desktop**: input injection does not work on a locked screen

## Keeping the launch spec in sync

`workerSessionMode` is a **deployment value**: it is written into the ACP launch spec when the worker
role is armed, not applied to a session already running.

### The model used when arming (`workerModel`)

**Settings → Remote workers → Model for this machine's remote sessions**, filled in as
`provider/model` (for example `deepseek-official/deepseek-flash`). It is a deployment value of the
same kind as the mode, but it decides which model the worker's agent runs:

- it is applied by a plugin-owned **`--patch` overlay** at launch, so it does **not** edit your
  `cordis.patch.yml`;
- empty means "use whatever the worker profile configures" (the previous behaviour);
- it decides `initialize`'s `promptCapabilities.image`: a model that does not declare image input
  makes the master **unable to send pictures** and breaks `read_image` on the worker, and that is
  **silent**. Arming therefore resolves the id against this machine's catalogue first: an unknown
  id **refuses to arm**, and a model without image support produces a warning (a text-only worker
  is a legitimate choice);
- changing it needs **re-arming**: the overlay is part of the launch spec, and a running relay does
  not replace it.

> Why not per task: `dsh-acp` fixes the image capability at `initialize` from the configured
> provider/model, and it is fixed for that connection. `session/set_config_option` changes the
> route but does not re-advertise the capability, so this can only be a deployment value.

- **Supervised worker** (the plugin owns the relay): saving a new mode while a listener is running
  does **not** rewrite that listener's spec. The settings page now shows **both** the saved value and
  the mode the running relay was started with, and says **re-arm required** when they differ. Stop
  and arm again to apply it; the pairing token survives, so no re-pairing is needed.
- **Hand-managed relay** (a scheduled task running `relay.mjs --cmd-file agent-spec.json`):
  `node slave/make-launch-spec.mjs --out agent-spec.json` **without** `--permission-mode` now reads
  `workerSessionMode` from the plugin's settings file, so the manual path follows the page. An
  explicit `--permission-mode` still wins. The relay reads the same settings file and reports
  `sessionModeMismatch` plus a warning check (`S19`) when its spec disagrees with the setting —
  including a loud line at startup. Regenerate the spec and restart the relay.

> **If you do not want to redeploy `slave/` for every plugin upgrade**, stop the scheduled task and
> arm this machine as a worker from **Settings → Remote workers → This machine's role**. The relay
> then runs from the installed package, so a plugin upgrade plus a DSH restart is enough; the launch
> spec is a temp file regenerated on each arming. The trade-off is that the relay runs only while
> DSH does — keep the scheduled task if you need a listener before login.

## GUI apps in a workspace: the Low-integrity trap

A worker that has ever run `workspace-write` carries an **inheritable Low mandatory label** on its
workspace. Files copied into that tree inherit the label, and Windows launches a Low-labelled image
at **Low integrity even when the parent token is High**. The symptom is a GUI app that cannot write
`%LOCALAPPDATA%` (`UnauthorizedAccessException`) while the agent shell writes the same path fine — it
looks like an ACL or application bug, not a sandbox leftover.

- Under `danger-full-access`, the relay **repairs an explicitly armed task directory** on start
  (`icacls ... /setintegritylevel (OI)(CI)Medium /T`). This is the correct counterpart to removing
  the sandbox: the label is no longer protecting anything. Pass `--no-integrity-repair` to keep it,
  or `--repair-integrity` to allow the relay's inherited cwd (still never a system directory).
- A hand-managed relay should pass `--task-dir <workspace>` so both the repair and the S20 probe
  have a directory to work on. To repair by hand:
  `powershell -File slave/repair-workspace-integrity.ps1 -Path <workspace>`.
- To keep GUI payloads out of the workspace entirely:
  `powershell -File slave/stage-app.ps1 -Source <app-dir> [-Launch]`. It copies to
  `%LOCALAPPDATA%\dsh-remote-use\staging\...` and sets the staged tree to Medium.
- `remote_selfcheck` reports the workspace and `%TEMP%` readings as `integrity` and as check `S20`.
  A degraded reading is a **warning**, because the machine is still reachable — but GUI work will
  fail until the label is fixed.

## Requirements

- Node ≥ 20
- DSH installed on the master and on the worker
- The worker needs an **unlocked interactive desktop session**
- The worker runs `slave/relay.mjs` (shipped in this package, together with the `ws` dependency it needs)

## Documentation

| | |
|---|---|
| [Repository README](https://github.com/Hope-Phenom/dsh-plugin-remote-use#readme) | Full install, use and operations |
| [Design notes](https://github.com/Hope-Phenom/dsh-plugin-remote-use/blob/master/docs/DESIGN.md) | Trade-offs and the decision record |
| [Pitfalls](https://github.com/Hope-Phenom/dsh-plugin-remote-use/blob/master/docs/PITFALLS.md) | Problems actually hit during development, and **how each one was found** |
| [Interface contract](https://github.com/Hope-Phenom/dsh-plugin-remote-use/blob/master/docs/INTERFACES.md) | Upstream APIs and integration facts |

## Licence

MIT
