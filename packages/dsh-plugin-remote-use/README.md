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
| `remote_selfcheck` | The node's readiness report. **Call it before delegating** — a node that is not ready is refused by the dispatch gate |
| `remote_agents` | Task progress |
| `remote_screenshot` | Capture the node's screen to the master, then look at it with `read_image` |
| `remote_interrupt` | Stop a task (cooperative) |

The settings page (**Settings → Remote work nodes**) manages nodes, handles **escalation approvals**,
shows the **audit trail**, edits the delegation policy, and can **arm this machine as a worker**
(symmetric pairing).

## Security model (the essentials)

- **Off by default** — a new session injects no policy and cannot see the remote tools at all
- **The sandbox must actually hold** — if confinement cannot be *proved*, worker mode is **refused**,
  not warned about
- **Escalation is never auto-approved** — `needsHuman` / `danger-full-access` go to a human queue, and
  a timeout counts as a refusal
- **Credentials never reach the browser** — the page only ever gets a mask
- The node must be **genuinely logged in to a desktop**: input injection does not work on a locked screen

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
