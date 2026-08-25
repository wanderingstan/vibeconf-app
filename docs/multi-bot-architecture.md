# One app, several bots — how deep is the hole?

Asked on 2026-08-24: *"I'm not sure how much of a hole we have dug by going so
far with our multi-app architecture, which began as a compromise months ago."*
The imagined end state was **a main window listing the bots, with individual bot
windows opening as you open them** — the same windows we have today.

Short answer: **the hole is real but you are not in it, and the UX you described
does not require climbing out.** The measurements are below, along with the one
thing that changed since the decision was last written down.

## The decision already exists

vibeconferencing#371, *"Design: multi-profile end-state — one visible app, N
worker processes (process-per-bot stays)"*, argues that process-per-bot is the
intended architecture rather than debt, and defines an end state that is
**almost exactly the UX described above**:

> 1. **Hidden worker instances** — only the active instance shows a Dock icon;
>    other profiles launch with no Dock icon and no windows until summoned.
> 2. **Panel as control room** — list ALL profiles with status and
>    start/stop/focus actions.
> 3. **Supervisor role for the default instance** — owns spawn/stop/health.

So the target is not in dispute. What is worth re-testing is whether the
reasoning still holds, because the code has moved.

## What the code says now

| | #371's figure | today |
| --- | --- | --- |
| `main.js` | "~5,000 lines of module-level singletons" | **13,100 lines** |
| top-level `let` in `main.js` | — | **101** |
| `localServer.` references | — | **182** |
| `meetView` references | — | **198** |
| `ipcMain` handlers | — | **142** |
| `store.get/set/delete` sites | — | **106** |

`local-server.js` is another 5,771 lines. Every one of those 142 IPC handlers
means "the bot in this process" implicitly, because there has only ever been one.

**The spine roughly doubled since that decision was written.** That does not
weaken #371 — it strengthens it. A single-process rewrite got more expensive,
not less.

## Three things that are easier than they look

Worth stating, because they are the parts people assume are blockers.

**1. Chromium isolation is not the problem.** The app already runs several
sessions in one process — `session.fromPartition` is used for the recording
windows. One Google identity per bot needs per-bot partition strings
(`persist:bot-<name>`) instead of today's single `SESSION_PARTITION =
'persist:session'` constant. That is a rename, not a rearchitecture.

**2. The 142 IPC handlers would not need 142 signature changes.** Each bot's
windows are its own `webContents`, so the bot resolves from `event.sender`. One
`botFor(event.sender)` helper replaces "the implicit one bot" everywhere.

**3. The port contract can stay exactly as it is.** #371 worried that hosting N
bots in one process forces `/bot/:profile` routing, which "breaks every MCP
config that assumes a bare port". It does not have to: one process can listen on
N ports, one per bot. MCP, the join-call skill, `vibeconf-attach`, and the test
fleet all keep working unchanged, because from outside nothing moved. This is
the part of the original framing that the *"probably still listens on several
ports"* instinct improves on.

## Two things that are genuinely hard

**1. `app.setPath('userData')` is process-global.** It is called once
(`main.js:5529`) and everything per-bot hangs off it: `electron-store`, the agent
dir, `mcp-config.json`, the profile's `config.json`. In one process there is no
second value to set, so `store` stops being a module singleton and becomes
per-bot — 106 call sites, each needing to know *whose* store it wants.

**2. The 101 module-level `let`s are per-bot state held as globals.** They are
isolated today by accident of process. Making them fields of a `Bot` object is
mechanical, but some are genuinely app-global (update checks, the menu) and each
one needs a judgement call. This is the multi-week part, and it is a rewrite of
the app's spine while the app is in daily use.

## The cost nobody has priced: crash isolation

#371's strongest argument, and it still stands. Today a bot that wedges mid-call
does not take the others down. After a merge into one process, a main-process
crash ends every call at once. For a TA bot in front of a class alongside a
personal bot on a call, that is a real regression, not a theoretical one.

Related and concrete: the post-call ffmpeg merge already pins a core for
~2.3× realtime. Three of those in one event loop contend in a way three
processes do not.

## But the bill has been arriving

This is the part that is new since #371, and the reason the question is being
asked again. A steady class of bugs traces directly to *nothing owning the
fleet*:

| issue | symptom | root |
| --- | --- | --- |
| #511 | a windowless instance keeps its port and cannot be quit | no owner reaps it |
| #517 | a second bot's tools drove the first bot's app | two processes cannot compare notes |
| #518 | the guard evicted a stranger silently | same |
| #201 | ports are per-user, but machine-wide | no allocator |
| #218 | MCP servers outlive the app, 3.5 days old | no owner reaps them |
| #233 | zombie/stale instance detection | no owner |
| #301 | nothing watches the calendar when all windows are closed | **no process is alive** |
| #515 | a sessions list, call any session into a meeting | needs a place to live |

Every one of these is a *coordination* failure, not an isolation failure.
Process-per-bot bought isolation and never paid for coordination.

## Recommendation: build the supervisor, don't merge the processes

#371 item 3 — the supervisor — is the missing half of the original design, and it
is what the whole table above is asking for. It also happens to be exactly the
window described in the question: a main app window listing the bots, with bot
windows opening as you open them.

```
        TODAY                              PROPOSED
  ┌──────────┐ ┌──────────┐         ┌─────────────────────┐
  │ app :7865│ │ app :7870│         │  Supervisor  (:7865)│  ← the window you
  │  Pepper  │ │  Buddy   │         │  ┌───────────────┐  │    described: the
  │  ─────── │ │  ─────── │         │  │ Pepper  in-call│ │    bot list, and
  │  window  │ │  window  │         │  │ Buddy   idle   │ │    the only Dock
  └──────────┘ └──────────┘         │  │ Coltrane  —    │ │    icon
   no Dock owner, no                │  └───────────────┘  │
   coordination, three               └──────┬──────┬───────┘
   Dock icons                        spawn/reap│  │focus
                                      ┌────────▼┐ ┌▼────────┐
                                      │worker   │ │worker   │
                                      │Pepper   │ │Buddy    │
                                      │ :7870   │ │ :7871   │
                                      └─────────┘ └─────────┘
                                       crash-isolated, Dock-hidden
                                       until summoned
```

What this buys, for roughly a week rather than a multi-week spine rewrite:

- **Keeps crash isolation**, which is the thing that is actually load-bearing.
- **Keeps the port contract**, so MCP and the tests do not move.
- **Gives the fleet an owner**, which is what the eight issues above are
  missing — reaping windowless instances, allocating ports, noticing zombies.
- **Answers #301 directly.** The supervisor is the always-on parent process.
  Calendar watching with every bot window closed is exactly its job.
- **Gives #515 a home.** The bot list and the Claude-session list are the same
  window.
- **Makes #517/#518 tractable.** One process knows every bot's real port, so
  "you are talking to the wrong app" becomes answerable rather than guessable.

The plumbing #371 named as already existing still exists: `scanRunningInstances`,
the port registry in `profile-manager.js`, `launchOrFocusProfile`, and the
shared app-level store.

## If you do want the single process anyway

The migration is tractable if it is done as a sequence where every step ships on
its own and nothing is a flag day. Roughly:

0. **`Bot` class as a pure container** — one instance, no behaviour change.
1. **Resolve IPC by sender** — `botFor(event.sender)`; still one bot, but the
   plumbing stops assuming.
2. **Per-bot store, explicit** — stop leaning on `app.setPath('userData')`.
3. **Per-bot session partitions** — `persist:bot-<name>`.
4. **Allow N `Bot`s in one process** — `--profile` opens a window in the running
   app instead of spawning; keep one port per bot so nothing outside notices.
5. **Retire the spawn/reap paths** in `scripts/spawn-test-fleet.sh`, `dev.sh`
   and friends.

Steps 0–3 are worth doing **regardless**, because they are what #371's own hedge
asks for — *"prefer passing state via parameters/objects over adding NEW
module-level singletons; keeps a future `BotContext` extraction possible without
committing to it."* They also make the supervisor cleaner. Step 4 is the
irreversible one, and it is the step that spends the crash isolation.

## The honest summary

You did not dig a hole. You made a trade — isolation over coordination — wrote
down why, and it is still the right trade on the merits. What went unbuilt is the
other half of that same design: something that owns the fleet. Eight open issues
are all restatements of its absence, and the window you pictured *is* it.

The thing to decide is not one-app-versus-many. It is whether the supervisor gets
built now, or whether the coordination bugs keep being fixed one at a time.
