// Evals against real models. `bun evals/run.ts [summary|assign|all]`
//
//   summary  10 cases on Haiku: does the progress summary keep only coarse,
//            finished milestones, catch unasked work done under a standing
//            permission, keep old lines verbatim, and respect mutes?
//   assign   5 cases on Opus, each in a throwaway git sandbox with the mod
//            loaded by --plugin-dir: does Claude hand the person a task when
//            only they can act, and stay quiet when a permission covers it?
//
// Each run appends to evals/results.jsonl and is compared with the last run
// of the same case: a case that went pass → fail is REGRESSED, fail → pass fixed.
// --plugin-dir loads the mod "inline", whose store is not the installed mod's,
// so tasks made here never reach the real panel.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Mute, Summary } from '../types'
import { newItems, parseSummary, summaryPrompt, transcriptText } from '../hooks/hub'

const ROOT = join(import.meta.dir, '..')
const RESULTS = join(import.meta.dir, 'results.jsonl')
const CLAUDE = process.env.CLAUDE_BIN ?? process.env.CLAUDE_CODE_EXECPATH ?? 'claude'

type Result = { suite: string; case: string; pass: boolean; detail: string; usd: number }
type Row = { role: string; text: string; toolUses?: { tool: string }[] }

function claude(args: string[], prompt: string, cwd = tmpdir()) {
  const env = { ...process.env }
  // A child session must not look like this one (the jump id) or be refused as nested.
  delete env.CLAUDE_CODE_HOST_SESSION_ID
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDECODE
  const run = spawnSync(CLAUDE, ['-p', '--no-session-persistence', ...args], { input: prompt, cwd, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 15 * 60_000 })
  if (run.status !== 0 && !run.stdout) throw new Error(`claude exited ${run.status}: ${run.stderr.slice(0, 500)}`)
  return run.stdout
}

// ---- summary ----

type SummaryCase = {
  name: string
  rows: Row[]
  prev?: Summary
  mutes?: Mute[]
  check: (s: Summary, fresh: Summary) => string | null
}

const tools = (...names: string[]) => names.map(tool => ({ tool }))
const has = (list: string[], re: RegExp) => list.some(s => re.test(s))

const SUMMARY_CASES: SummaryCase[] = [
  {
    name: 'reading code is not a milestone',
    rows: [
      { role: 'user', text: 'How does the auth middleware decide whether a token is expired?' },
      { role: 'assistant', text: 'Let me look at the middleware.', toolUses: tools('Read', 'Grep', 'Read') },
      { role: 'assistant', text: 'It compares exp against Date.now() with a 30 second leeway in src/auth/verify.ts.' },
    ],
    check: s => (s.milestones.length === 0 ? null : `expected no milestones, got ${JSON.stringify(s.milestones)}`),
  },
  {
    name: 'a finished feature with green tests is one milestone',
    rows: [
      { role: 'user', text: 'Add a /health endpoint that returns the git sha, with a test.' },
      { role: 'assistant', text: 'Adding the route and a test.', toolUses: tools('Read', 'Edit', 'Write', 'Bash') },
      { role: 'assistant', text: 'Ran bun test: 48 pass, 0 fail. GET /health now returns {"sha": "..."}.' },
    ],
    check: s => (s.milestones.length >= 1 && s.milestones.length <= 2 && has(s.milestones, /health/i) ? null : `expected 1-2 milestones about /health, got ${JSON.stringify(s.milestones)}`),
  },
  {
    name: 'merging under a standing permission is caught as authorized',
    rows: [
      { role: 'user', text: 'Fix the typo in the README and get it in.' },
      { role: 'assistant', text: 'Fixed. Your memory says I may merge my own docs MRs without asking, so I opened and merged MR !42.', toolUses: tools('Edit', 'Bash', 'Bash') },
    ],
    check: s => (has(s.authorized, /42|merg/i) ? null : `expected an authorized item about merging !42, got ${JSON.stringify(s.authorized)}`),
  },
  {
    name: 'something the person approved just now is not "unasked"',
    rows: [
      { role: 'assistant', text: 'The branch feature/old-login is merged. Can I delete it?' },
      { role: 'user', text: 'yes delete it' },
      { role: 'assistant', text: 'Deleted feature/old-login locally and on origin.', toolUses: tools('Bash') },
    ],
    check: s => (s.authorized.length === 0 ? null : `expected no authorized items, got ${JSON.stringify(s.authorized)}`),
  },
  {
    name: 'earlier lines are kept word for word, so only the new one is a message',
    prev: { milestones: ['Fixed the flaky auth test'], authorized: [] },
    rows: [
      { role: 'assistant', text: 'The flaky auth test is fixed (it raced the clock).', toolUses: tools('Edit', 'Bash') },
      { role: 'user', text: 'Great. Now ship the CSV export.' },
      { role: 'assistant', text: 'CSV export is done: /export.csv streams rows, tests pass (12 new).', toolUses: tools('Write', 'Edit', 'Bash') },
    ],
    check: (s, fresh) =>
      s.milestones.includes('Fixed the flaky auth test') && fresh.milestones.length === 1 && has(fresh.milestones, /csv/i)
        ? null
        : `expected the old line verbatim and one new CSV line, got ${JSON.stringify(s.milestones)} (new: ${JSON.stringify(fresh.milestones)})`,
  },
  {
    name: 'muted kinds are skipped',
    mutes: [{ text: 'Bumped dependency versions', at: 0 }],
    rows: [
      { role: 'assistant', text: 'Bumped lodash to 4.17.21 and vite to 6.2.', toolUses: tools('Bash', 'Edit') },
      { role: 'assistant', text: 'Dark mode is shipped: the toggle persists and all screens follow it. Tests pass.', toolUses: tools('Edit', 'Bash') },
    ],
    check: s => (!has(s.milestones, /lodash|vite|bump|depend/i) && has(s.milestones, /dark/i) ? null : `expected dark mode and no dependency bump, got ${JSON.stringify(s.milestones)}`),
  },
  {
    name: 'work still in progress is not a milestone',
    rows: [
      { role: 'user', text: 'Refactor the payment module into smaller files.' },
      { role: 'assistant', text: 'Split payment.ts into three files. 6 tests fail now; fixing the imports next.', toolUses: tools('Read', 'Write', 'Write', 'Bash') },
    ],
    check: s => (s.milestones.length === 0 ? null : `expected no milestones, got ${JSON.stringify(s.milestones)}`),
  },
  {
    name: 'commits and fix-ups toward one goal fold into one short line',
    rows: [
      { role: 'user', text: '让试衣页在手机上也能用，局域网里能打开。' },
      { role: 'assistant', text: 'Committed 79350dc: LAN HTTPS dev server (npm run dev:lan), three-column layout, drag-and-drop bulk import.', toolUses: tools('Edit', 'Write', 'Bash') },
      { role: 'assistant', text: 'Committed a1b2c3d: fix the camera permission prompt on iOS Safari; checked desktop and phone layouts in the browser.', toolUses: tools('Edit', 'Bash') },
      { role: 'assistant', text: 'Committed 9f8e7d6: tighten spacing on small screens. Mobile try-on now works over the LAN.', toolUses: tools('Edit', 'Bash') },
    ],
    check: s => {
      const bad = s.milestones.filter(m => /\b[0-9a-f]{7,}\b|npm |dev:lan|\.tsx?\b/i.test(m))
      if (s.milestones.length > 2) return `expected 1-2 milestones, got ${JSON.stringify(s.milestones)}`
      if (bad.length) return `hashes, commands or files leaked into ${JSON.stringify(bad)}`
      return s.milestones.length ? null : 'expected the mobile outcome as a milestone'
    },
  },
  {
    name: 'routine commits under a standing permission are not worth an authorized line',
    rows: [
      { role: 'user', text: 'Rename the helper and clean up the imports.' },
      { role: 'assistant', text: 'Done. Your memory says to commit finished work without asking, so I committed it as 3c4d5e6.', toolUses: tools('Edit', 'Bash') },
    ],
    check: s => (s.authorized.length === 0 ? null : `expected no authorized items, got ${JSON.stringify(s.authorized)}`),
  },
  {
    name: 'a Chinese session gets Chinese lines',
    rows: [
      { role: 'user', text: '把登录页改成支持微信扫码登录' },
      { role: 'assistant', text: '已经完成微信扫码登录，回调和测试都通过了。', toolUses: tools('Edit', 'Write', 'Bash') },
    ],
    check: s => (has(s.milestones, /[一-鿿]/) ? null : `expected a Chinese milestone, got ${JSON.stringify(s.milestones)}`),
  },
]

function runSummary(c: SummaryCase): Result {
  const prompt = summaryPrompt(transcriptText(c.rows), c.prev, c.mutes ?? [])
  const out = JSON.parse(claude(['--model', 'haiku', '--output-format', 'json', '--tools', '', '--strict-mcp-config'], prompt)) as { result: string; total_cost_usd?: number }
  const summary = parseSummary(out.result)
  const usd = out.total_cost_usd ?? 0
  if (!summary) return { suite: 'summary', case: c.name, pass: false, detail: `unreadable: ${out.result.slice(0, 200)}`, usd }
  const why = c.check(summary, newItems(c.prev, summary))
  return { suite: 'summary', case: c.name, pass: why === null, detail: why ?? JSON.stringify(summary), usd }
}

// ---- assign ----

type AssignCase = {
  name: string
  files?: Record<string, string>
  prompt: string
  expect: { assigned: boolean; kind?: 'do' | 'answer' | 'choose'; replyMentions?: RegExp }
}

const ASSIGN_CASES: AssignCase[] = [
  {
    name: 'a missing secret becomes a do-task, not a question in chat',
    files: { 'src/pay.ts': 'export const charge = (cents: number) => fetch("https://api.stripe.com/v1/charges", { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } })\n' },
    prompt: 'Make src/pay.ts work locally. The Stripe test key is not anywhere in this repo yet.',
    expect: { assigned: true, kind: 'do' },
  },
  {
    name: 'a plain code change assigns nothing',
    files: { 'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b\n}\n' },
    prompt: 'Rename the function add in src/math.ts to sum.',
    expect: { assigned: false },
  },
  {
    name: "the person's decision becomes a choose-task",
    files: { 'README.md': '# notes app\nA small notes app. No database chosen yet.\n' },
    prompt: 'This app needs a database. It is my call between Postgres and SQLite; I do not want you to pick. Get my decision, then write it into README.md once you have it.',
    expect: { assigned: true, kind: 'choose' },
  },
  {
    name: 'a standing permission means no task, and the reply names it',
    files: { 'CLAUDE.md': '# Rules\n- You may commit to main without asking me.\n', 'src/greet.ts': 'export const greet = (n: string) => `Helo, ${n}`\n' },
    prompt: 'Fix the typo in src/greet.ts.',
    expect: { assigned: false, replyMentions: /commit/i },
  },
  {
    name: 'an approval only the person can give becomes a task',
    files: { 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n- Faster search\n- Fix login redirect\n' },
    prompt: 'Turn the Unreleased section into release notes for v1.4 in RELEASE.md. I must approve the notes before anything is tagged, so get my sign-off.',
    expect: { assigned: true },
  },
]

function sandbox(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'standup-eval-'))
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path)
    spawnSync('mkdir', ['-p', join(full, '..')])
    writeFileSync(full, text)
  }
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', ...args], { cwd: dir })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

function runAssign(c: AssignCase): Result {
  const dir = sandbox(c.files)
  const allowed = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'mcp__standup__assign_task', 'mcp__standup__withdraw_task', 'mcp__standup__list_tasks']
  const stdout = claude(
    ['--model', 'opus', '--plugin-dir', ROOT, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', allowed.join(','), '--max-budget-usd', '1'],
    c.prompt,
    dir,
  )
  const events = stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as { type: string; message?: { content?: { type: string; name?: string; input?: { kind?: string } }[] }; result?: string; total_cost_usd?: number }
      } catch {
        return undefined
      }
    })
    .filter(e => e !== undefined)
  const calls = events.flatMap(e => (e.type === 'assistant' ? (e.message?.content ?? []) : [])).filter(b => b.type === 'tool_use' && b.name === 'mcp__standup__assign_task')
  const final = events.find(e => e.type === 'result')
  const reply = final?.result ?? ''
  const usd = final?.total_cost_usd ?? 0

  const problems: string[] = []
  if (c.expect.assigned !== calls.length > 0) problems.push(c.expect.assigned ? 'expected assign_task, none called' : `expected no task, got ${calls.length}`)
  if (c.expect.kind && !calls.some(b => b.input?.kind === c.expect.kind)) problems.push(`expected kind ${c.expect.kind}, got ${calls.map(b => b.input?.kind).join(',') || 'none'}`)
  if (c.expect.replyMentions && !c.expect.replyMentions.test(reply.split('\n').slice(-3).join('\n'))) problems.push(`reply's last lines do not mention ${c.expect.replyMentions}`)
  return { suite: 'assign', case: c.name, pass: problems.length === 0, detail: problems.join('; ') || `${calls.length} task(s): ${calls.map(b => b.input?.kind).join(',')}`, usd }
}

// ---- run and compare ----

function lastRun(): Map<string, boolean> {
  const last = new Map<string, boolean>()
  if (!existsSync(RESULTS)) return last
  for (const line of readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as Result
    last.set(`${r.suite}/${r.case}`, r.pass)
  }
  return last
}

const which = process.argv[2] ?? 'all'
if (!['summary', 'assign', 'all'].includes(which)) {
  console.error('usage: bun evals/run.ts [summary|assign|all]')
  process.exit(2)
}

const before = lastRun()
const at = new Date().toISOString()
const results: Result[] = []
const jobs: (() => Result)[] = [
  ...(which !== 'assign' ? SUMMARY_CASES.map(c => () => runSummary(c)) : []),
  ...(which !== 'summary' ? ASSIGN_CASES.map(c => () => runAssign(c)) : []),
]
for (const job of jobs) {
  let r: Result
  try {
    r = job()
  } catch (err) {
    r = { suite: '?', case: '?', pass: false, detail: String(err), usd: 0 }
  }
  const was = before.get(`${r.suite}/${r.case}`)
  const mark = was === undefined ? '' : was && !r.pass ? '  REGRESSED' : !was && r.pass ? '  fixed' : ''
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  [${r.suite}] ${r.case}${mark}${r.pass ? '' : `\n      ${r.detail}`}`)
  appendFileSync(RESULTS, `${JSON.stringify({ at, ...r })}\n`)
  results.push(r)
}

for (const suite of ['summary', 'assign']) {
  const mine = results.filter(r => r.suite === suite)
  if (!mine.length) continue
  const usd = mine.reduce((sum, r) => sum + r.usd, 0)
  console.log(`${suite}: ${mine.filter(r => r.pass).length}/${mine.length}  ($${usd.toFixed(2)})`)
}
process.exit(results.every(r => r.pass) ? 0 : 1)
