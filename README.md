# Agent Hub

A Claude Code mod that puts every session on your machine into one panel. The top half lists what each agent is waiting on you for. The bottom half is a feed of what each agent finished.

```
Needs you · 2
╭───────────────────────────────────────────────────╮
│ do  Add STRIPE_SECRET_KEY to .env.local    Jump ↗ │
│ payments · 3m ago                                 │
│ [ Done ]                                          │
╰───────────────────────────────────────────────────╯
╭───────────────────────────────────────────────────╮
│ choose  Which database for notes-app?      Jump ↗ │
│ notes-app · just now                              │
│ [ Postgres ]  [ SQLite ]                          │
╰───────────────────────────────────────────────────╯

Updates · 2
╭───────────────────────────────────────────────────╮
│ ✓ /health endpoint returns the git sha; tests pass│
│ api · 12m ago   OK   No more like this   Jump ↗   │
╰───────────────────────────────────────────────────╯
╭───────────────────────────────────────────────────╮
│ ↳ Merged MR !42 (memory: may merge docs MRs)      │
│ docs · 40m ago   OK   No more like this           │
╰───────────────────────────────────────────────────╯
```

## Install

Needs Claude Code 2.1.299 or newer.

From a local clone (edits are picked up by `/reload-plugins`, no reinstall):

```bash
claude plugin marketplace add ~/.claude/mods/agent-hub
```

```bash
claude plugin install agent-hub@agent-hub
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace, then Add plugin.

## Use

- `/hub` opens the panel.
- `/hub-settings` opens the settings: language (English or 中文, default English), open the panel when a task arrives (default on), draggable divider between the two halves (default off). Settings apply to every session on the machine.
- The status line shows `☐ N tasks need you · /hub`, counted across all sessions.

### Tasks

When Claude needs something only you can do (put a key in place, act on your machine or accounts, make a call that is yours, review or approve), it calls `assign_task`. A task is one of:

- **do**: you go do it, then press Done.
- **answer**: you type a few words.
- **choose**: you pick one of 2 to 4 options.

You can answer from the panel in any session. The answer goes back to the session that asked: if that Claude is idle it gets the answer as a new message at once; if it is busy, after its current turn.

Guards:

- An answer that looks like a key or token (`sk-…`, `ghp_…`, `AKIA…`, a private key block, a JWT, `password=…`, a long mixed-case token) is refused, so it never lands in a transcript.
- At most 5 open tasks per session.
- The same ask is not assigned twice while it is open.
- Claude can take a task back with `withdraw_task`, and list its open ones with `list_tasks`.
- After a compact, Claude is told again which of its tasks are still open.

### Updates

After each turn that used tools, Agent Hub asks Haiku to summarize that session's transcript, at most once every 5 minutes per session. If Haiku is unavailable it uses the session's own model. The new summary is compared with the previous one, and each new line becomes a message:

- **✓ milestone**: something done and working. Reading code, answering a question, a plan or a half-finished step does not count.
- **↳ done under a standing permission**: something Claude did without asking because your memory, CLAUDE.md, settings or an earlier general yes covered it, with the permission named.

Messages stay after their session closes. **OK** hides a message in every session. **No more like this** also saves it as a mute: later summaries in every session skip things of that kind (the model judges what is similar). If summarizing fails, the panel says `Updates paused: <reason>`.

**Jump ↗** on a task or message switches the desktop app to that session (`open claude://claude.ai/epitaxy/<id>`). Sessions running in a plain terminal have no such id, so they show no Jump.

### How Claude is told to use it

The mod adds a section to the end of the system prompt: things only you can do go through `assign_task`, even if Claude also asked in its reply, and a missing secret is always a task. If you already gave a standing permission for that kind of action, Claude does it without asking and ends its reply with one line saying what it did and under which permission, which is what the ↳ messages pick up. The three tool descriptions carry the same rule and are loaded up front, so the model sees them every turn.

Where an organization manages Claude Code, `prompt.compose` and `session.compact` hooks run only for plugins listed in managed settings. There the system-prompt section and the after-compact reminder are skipped, and the tool descriptions alone carry the rule.

## How it works

All data lives in the mod's `$.store`, one JSON file under `~/.claude/plugins/store/`. Each session writes only its own keys, so sessions never overwrite each other:

| Key | Holds | Written by |
| --- | --- | --- |
| `card:<session>` | that session's tasks, feed, last summary, heartbeat | that session |
| `reply:<session>:<task>` | an answer to one task | whichever session answered |
| `ack:<message>` | OK on a message | any session |
| `mute:<message>` | a "No more like this" | any session |
| `settings` | the three settings | any session |

Every session reads the store every 3 seconds and writes a heartbeat every 60. A session with no heartbeat for 3 minutes is treated as gone and its tasks leave the panel. Cards, replies and OKs older than 7 days are deleted; mutes are kept.

`/reload-plugins` does not fire `session.start`, so joining the store and registering the commands and tools happens on whichever hook runs first.

The panel is one TSX tree for the terminal and the desktop app, using Claude Code's theme colors only (`claude` orange as the accent; `warning`, `success`, `error`, `subtle` for meaning). Cards have round borders that turn orange on hover. The divider, when on, is a `Client` module that takes the drag and posts the new task-area height.

## Develop

The `claude` on your PATH must be 2.1.299 or newer, or `validate` rejects the hooks it does not know yet. The desktop app's own binary is at `$CLAUDE_CODE_EXECPATH`.

```bash
claude plugin validate .claude-plugin/plugin.json
```

```bash
claude plugin test .
```

20 unit tests cover assigning, cross-session answers, secret refusal, reply delivery, stale sessions, the feed and its 5-minute gap, model fallback, paused updates, OK and mutes, settings sync, auto-open, registration after a reload, the system-prompt section, the after-compact reminder, Jump, the divider, and pruning, on both the terminal and desktop surfaces.

```bash
bun evals/run.ts all
```

Runs real models and appends to `evals/results.jsonl`, marking each case `fixed` or `REGRESSED` against its last run:

- **summary**: 8 cases on Haiku (coarse milestones only, authorized work caught, approved-just-now is not authorized, old lines kept verbatim, mutes respected, Chinese sessions get Chinese lines). About $0.01 a run.
- **assign**: 5 cases on Opus, each in a fresh git sandbox (missing secret → do-task, plain edit → nothing, your decision → choose-task, standing permission → no task and the reply names it, sign-off → task). About $1.6 a run.

Evals load the mod with `--plugin-dir`, which gets its own store, so test tasks never show up in your real panel.

## License

MIT
