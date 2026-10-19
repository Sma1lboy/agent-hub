# AGENTS.md

Agent Hub is a Claude Code mod. Users install it straight from `main`, so whatever merges reaches every user on their next update.

## Checks

- Tests: `claude plugin test .` runs `tests/*.test.tsx` on the engine's test host. It needs Claude Code 2.1.299 or newer and no login. CI runs it on every PR and on every push to `main`.
- Typecheck: `npx -p typescript@5 tsc -p .`. It needs `.claude-plugin/types/claude-code/index.d.ts`, which is gitignored. Claude Code writes that file when a logged-in session loads the mod from this folder (`claude --plugin-dir .`). CI can't create it without credentials, so run the typecheck locally before you push.
- Never run `evals/` in CI or as a routine check: it calls real models and costs money.
- A change in behavior comes with a new or updated test in `tests/hub.test.tsx` that pins the new behavior.

## Commits and docs

- Commit messages are in English and carry no AI attribution (no `Co-Authored-By`, no "Generated with").
- `README.md` and `README.zh-CN.md` change together.

## Changes reserved for the owner

A verifier that sees any of these in a diff answers `VERDICT: owner` and does not approve it, even when the tests pass:

- Steering copy: `hooks/steering.ts`, including the `assign_task`, `withdraw_task` and `list_tasks` descriptions. This copy decides when the model interrupts the user.
- `$.store` keys and data shapes: `card:`, `reply:`, `ack:`, `mute:`, `settings` (`hooks/hub.ts`, `types/index.d.ts`). Changing them breaks the data every existing session reads.
- The guards: refusing answers that look like secrets (`looksLikeSecret`), the cap of 5 open tasks per session (`MAX_OPEN_TASKS`), and duplicate detection (`duplicateOf`).
- New hooks or wider permissions in `hooks/hooks.json`, and any change to the manifests in `.claude-plugin/`.

Anything else (bug fixes, UI, small copy edits outside steering) can merge once the tests pass.
