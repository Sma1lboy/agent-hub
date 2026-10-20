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

## Areas that need extra proof

The owner has authorized fixes to merge without his sign-off, these areas included. A verifier still answers `VERDICT: pass` for a diff touching them only with this evidence, and `VERDICT: fail` (naming what is missing) otherwise:

- Steering copy: `hooks/steering.ts`, including the `assign_task`, `withdraw_task` and `list_tasks` descriptions. This copy decides when the model interrupts the user: the change must be what the issue asks for, and nothing broader.
- `$.store` keys and data shapes: `card:`, `reply:`, `ack:`, `mute:`, `settings` (`hooks/hub.ts`, `types/index.d.ts`). Every existing session reads this data, so old data must still load: a test feeds the previous shape and passes.
- The guards: refusing answers that look like secrets (`looksLikeSecret`), the cap of 5 open tasks per session (`MAX_OPEN_TASKS`), and duplicate detection (`duplicateOf`). Never loosen one; a test pins the guarded behavior.
- `hooks/hooks.json` and the manifests in `.claude-plugin/`: no new permissions beyond what the issue needs.

Use `VERDICT: owner` only when the right behavior is a product call the issue doesn't settle.
