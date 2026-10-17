// Fills the installed Agent Hub's store with three made-up sessions, for screenshots and demos.
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
  const card = (sid: string, name: string, tasks: Task[], feed: FeedItem[], summary: Card['summary'], extra: Partial<Card> = {}): Card => ({
    sid,
    hostId: `local_${sid}`,
    name,
    cwd: `/Users/demo/code/${name}`,
    // In the future, so the demo's tasks stay on the panel for two hours.
    heartbeat: now + 2 * 60 * min,
    tasks,
    feed,
    summary,
    summaryAt: now - 6 * min,
    ...extra,
  })

  const cards = [
    card(
      'demo-payments',
      'payments-api',
      [
        task('t1', 'do', 'Add STRIPE_SECRET_KEY to .env.local', 4, { detail: 'Use the test-mode secret key from dashboard.stripe.com → Developers → API keys. I will run the checkout tests once it is there.' }),
        task('t2', 'choose', 'Retry failed webhooks how many times?', 1, { options: ['3 times', '5 times', 'Never, alert instead'] }),
      ],
      [
        item('demo-payments', 'f1', 'milestone', 'Checkout flow works end to end against Stripe test mode; 31 tests pass', 18),
        item('demo-payments', 'f2', 'authorized', 'Merged MR !128 "Idempotency keys on charges" (memory: may merge my own MRs once CI is green)', 26),
      ],
      { milestones: [], authorized: [], goal: 'Take payments through Stripe Checkout', now: 'Waiting on the Stripe test key to run the webhook tests', state: 'blocked' },
    ),
    card(
      'demo-notes',
      'notes-app',
      [task('t1', 'answer', 'What should the S3 bucket for attachments be called?', 7, { detail: 'It has to be globally unique. I will create it with Terraform in us-east-1.' })],
      [
        item('demo-notes', 'f1', 'milestone', 'Offline sync ships: edits made without network merge cleanly on reconnect', 42),
        item('demo-notes', 'f2', 'milestone', 'Dark mode follows the system setting on every screen', 95),
      ],
      { milestones: [], authorized: [], goal: 'Ship attachments for notes-app 1.3', now: 'Writing the Terraform for the attachments bucket', state: 'in_progress' },
      { busy: true },
    ),
    card(
      'demo-ios',
      'ios-client',
      [task('t1', 'do', 'Approve build 2.4.0 (311) in App Store Connect', 12, { detail: 'TestFlight review passed. Only the account holder can submit it for release.' })],
      [
        item('demo-ios', 'f1', 'authorized', 'Bumped the build number and pushed tag v2.4.0 (CLAUDE.md: may tag releases)', 15),
        item('demo-ios', 'f2', 'milestone', 'Crash on launch for iOS 17 users fixed; repro test added', 63),
      ],
      { milestones: [], authorized: [], goal: 'Release iOS client 2.4.0', now: 'Build 311 passed TestFlight review; only submission is left', state: 'done' },
    ),
  ]
  for (const c of cards) store[`card:${c.sid}`] = c
}

writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`)
console.log(process.argv.includes('--clear') ? `Removed the demo from ${path}` : `Seeded 3 demo sessions into ${path}. Open /hub; they show within 3 seconds.`)
