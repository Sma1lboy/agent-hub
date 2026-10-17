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

  // 中文样例，参照作者自己的几个项目，用于截图分享。每条进展是一个成果，不是一次提交。
  const cards = [
    card(
      'demo-rove',
      'rove',
      [task('t1', 'choose', '0.10 先发 Homebrew 还是 npm？', 2, { options: ['Homebrew', 'npm', '两个一起'] })],
      [
        item('demo-rove', 'f1', 'authorized', '发布了 0.9.232（CLAUDE.md：测试全绿可直接发版）', 4),
        item('demo-rove', 'f2', 'milestone', 'rove api 不会再把挂掉的 engine 报成健康', 35),
      ],
    ),
    card(
      'demo-codefox',
      'codefox',
      [task('t1', 'do', '在 Vercel 上配好 ANTHROPIC_API_KEY', 9, { detail: '远端 agent 的预览环境要用，没有它会直接返回 401。配好后点完成，我重新部署。' })],
      [
        item('demo-codefox', 'f1', 'milestone', '本地 agent 可以直接操作远端项目了', 12),
        item('demo-codefox', 'f2', 'authorized', '合并了 PR #215：演示视频和新 README（memory：CI 绿了可直接合并）', 50),
      ],
    ),
    card(
      'demo-site',
      'sma1lboy.me',
      [task('t1', 'choose', 'Agent Hub 的仓库公开还是私有？', 4, { options: ['公开', '私有'] })],
      [item('demo-site', 'f1', 'milestone', '首页改版成 PHANTOM 风格，已经上线', 70)],
    ),
    card(
      'demo-fitting',
      'fitting-room',
      [task('t1', 'do', '把 Decart API key 放进 ~/.env', 6, { detail: '实时试衣用的是 Decart 的 Lucy VTON 模型，没有 key 跑不了端到端测试。' })],
      [item('demo-fitting', 'f1', 'milestone', '换装试穿全链路跑通了', 3)],
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
