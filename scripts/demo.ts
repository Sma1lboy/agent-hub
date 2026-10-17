// Fills the installed Agent Hub's store with five made-up sessions, after the author's own projects, for screenshots and demos.
//   bun scripts/demo.ts          seed (tasks stay visible for 2 hours)
//   bun scripts/demo.ts --clear  remove everything the demo wrote
// Every key it writes belongs to a session id starting with "demo-".

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Card, FeedItem, Task } from '../types'

const DIR = join(homedir(), '.claude/plugins/store')
const files = readdirSync(DIR).filter(f => f.startsWith('agent-hub_') && !f.includes('inline'))
if (files.length !== 1) {
  console.error(`expected one installed agent-hub store in ${DIR}, found: ${files.join(', ') || 'none'}`)
  process.exit(1)
}
const path = join(DIR, files[0]!)
const store = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const isDemo = (key: string) => /^(card|reply|ack|mute):demo-/.test(key)
for (const key of Object.keys(store)) if (isDemo(key)) delete store[key]

if (!process.argv.includes('--clear')) {
  const now = Date.now()
  const min = 60_000
  const task = (id: string, kind: Task['kind'], title: string, ago: number, more: Partial<Task> = {}): Task => ({ id, kind, title, createdAt: now - ago * min, ...more })
  const item = (sid: string, id: string, kind: FeedItem['kind'], text: string, ago: number): FeedItem => ({ id: `${sid}:${id}`, kind, text, at: now - ago * min })
  const card = (sid: string, name: string, tasks: Task[], feed: FeedItem[]): Card => ({
    sid,
    hostId: `local_${sid}`,
    name,
    cwd: `/Users/demo/code/${name}`,
    // In the future, so the demo's tasks stay on the panel for two hours.
    heartbeat: now + 2 * 60 * min,
    tasks,
    feed,
  })

  // After the author's own projects, for screenshots; each session writes in its own language. Each update is an outcome, never a commit.
  const cards = [
    card(
      'demo-rove',
      'rove',
      [task('t1', 'choose', 'Ship 0.10 to Homebrew or npm first?', 2, { options: ['Homebrew', 'npm', 'Both'] })],
      [
        item('demo-rove', 'f1', 'authorized', 'Released 0.9.232 (CLAUDE.md: may release when tests are green)', 4),
        item('demo-rove', 'f2', 'milestone', 'rove api no longer reports a dead engine as healthy', 35),
      ],
    ),
    card(
      'demo-codefox',
      'codefox',
      [task('t1', 'do', 'Set ANTHROPIC_API_KEY on Vercel', 9, { detail: 'The remote-agent preview needs it and returns 401 without it. Press Done and I will redeploy.' })],
      [
        item('demo-codefox', 'f1', 'milestone', 'Local agents can now drive remote projects', 12),
        item('demo-codefox', 'f2', 'authorized', 'Merged PR #215, the demo video and new README (memory: may merge once CI is green)', 50),
      ],
    ),
    card(
      'demo-wisp',
      'wisp',
      [task('t1', 'answer', '微信群每天最多推几张卡片？', 15, { detail: '现在没有上限，昨天一个群收了 23 张。给我一个数字就行。' })],
      [
        item('demo-wisp', 'f1', 'milestone', '记忆和仓库冲突时，一律以仓库为准', 20),
        item('demo-wisp', 'f2', 'milestone', '微信 agent 拆成了独立仓库', 75),
      ],
    ),
    card(
      'demo-fitting',
      'fitting-room',
      [task('t1', 'do', 'Put the Decart API key in ~/.env', 6, { detail: 'Live try-on runs on Decart Lucy VTON; the end-to-end test cannot run without it.' })],
      [item('demo-fitting', 'f1', 'milestone', 'Outfit try-on works end to end', 3)],
    ),
    card(
      'demo-mcrpg',
      'mc-rpg',
      [task('t1', 'choose', '幽井 NPC 的对话用哪种方式触发？', 1, { options: ['右键交互', '靠近自动触发', '两种都要'] })],
      [item('demo-mcrpg', 'f1', 'milestone', 'NPC 能沿着村庄街道寻路了', 28)],
    ),
  ]
  for (const c of cards) store[`card:${c.sid}`] = c
}

writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`)
console.log(process.argv.includes('--clear') ? `Removed the demo from ${path}` : `Seeded 5 demo sessions into ${path}. Open /hub; they show within 3 seconds.`)
