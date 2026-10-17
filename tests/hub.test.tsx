import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MountTarget } from 'claude-code/testing'

import type { Card, Task } from '../types'
import { STALE_MS, cardKey, looksLikeSecret, newItems, replyKey, staleKeys } from '../hooks/hub'

// Agent Hub end to end against the engine's own test host: one session ("self")
// plus other sessions seeded straight into the shared store.

const NOW = 10_000_000
const SURFACES = ['terminal', 'desktop'] as const

type Calls = {
  submitted: string[]
  opened: string[]
  status: (string | undefined)[]
  run: string[][]
  models: string[]
  prompts: string[]
  tools: string[]
  commands: string[]
}

type Opts = {
  entries?: Record<string, unknown>
  host?: string
  model?: (model: string, prompt: string) => { isAnswered: true; text: string } | { isAnswered: false; reason: 'api-error'; status: number; error: string }
}

function stub(on: On, opts: Opts = {}) {
  const calls: Calls = { submitted: [], opened: [], status: [], run: [], models: [], prompts: [], tools: [], commands: [] }
  const clock = mock.clock(on, { now: NOW })
  // The shared store, as a map the test can read and other "sessions" can write.
  const store = new Map<string, unknown>(Object.entries(opts.entries ?? {}))
  on('store.get', ($, e) => ({ value: structuredClone(store.get(e.key)) }))
  on('store.set', ($, e) => {
    store.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, opts.host ? { CLAUDE_CODE_HOST_SESSION_ID: opts.host } : {})
  const session = mock.session(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.id', () => ({ value: 'self' }))
  on('session.cwd', () => ({ value: '/work/alpha' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'ship the login page', toolUses: [] }] }))
  on('command.register', ($, e) => {
    calls.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    calls.tools.push(e.name)
    return { value: { tool: e.name } }
  })
  on('ui.status', ($, e) => {
    calls.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    calls.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    calls.submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', ($, e) => {
    calls.run.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    calls.models.push(e.model)
    calls.prompts.push(e.prompt)
    const reply = opts.model?.(e.model, e.prompt) ?? { isAnswered: true as const, text: '{"milestones":[],"authorized":[]}' }
    return { value: { ...reply, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as never }
  })
  return { calls, clock, session, store }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })

const assign = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__agent-hub__assign_task', tool_use_id: `tu-${Math.random()}`, ...input } as never)

const pane = <S extends (typeof SURFACES)[number]>(surface: S, requestId = 'agent-hub'): MountTarget<S, 'Pane'> =>
  ({
    plugin: 'agent-hub',
    surface,
    component: 'Pane',
    requestId,
    viewport: { columns: 90, rows: 40 },
    props: { title: 'Agent Hub', isFocused: true, bodyColumns: 88, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } },
  }) as MountTarget<S, 'Pane'>

const otherCard = (over: Partial<Card> = {}): Card => ({
  sid: 'other',
  hostId: 'local_other',
  name: 'beta',
  cwd: '/work/beta',
  heartbeat: NOW,
  tasks: [{ id: 't1', kind: 'answer', title: 'Which region should prod use?', createdAt: NOW - 1000 }],
  feed: [],
  ...over,
})

const textOf = (found: unknown) => (found as { text?: string } | undefined)?.text


test('assign_task puts a task on the panel, on every surface', async ($, on) => {
  const { calls, store } = stub(on)
  await start($)
  expect(calls.tools).toEqual(['assign_task', 'withdraw_task', 'list_tasks'])
  expect(calls.commands).toEqual(['hub', 'hub-settings'])

  const res = await assign($, { kind: 'do', title: 'Add STRIPE_KEY to .env.local', detail: 'The test key from the Stripe dashboard.' })
  expect(String(res.result)).toContain('Assigned task')
  const card = (store.get(cardKey('self'))) as Card
  expect(card.tasks.map(t => t.title)).toEqual(['Add STRIPE_KEY to .env.local'])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: 'Add STRIPE_KEY to .env.local' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /To do 1/ })).toBeDefined()
    await ui.unmount()
  }
  expect(calls.status.at(-1)).toBe('1 task needs you · /hub')
})

test('assign_task refuses bad input, duplicates and a sixth open task', async ($, on) => {
  const { store } = stub(on)
  await start($)
  expect((await assign($, { kind: 'pick', title: 'x' })).deny).toContain('kind')
  expect((await assign($, { kind: 'choose', title: 'DB?', options: ['pg'] })).deny).toContain('2 to 4')

  await assign($, { kind: 'do', title: 'Rotate the deploy key' })
  const again = await assign($, { kind: 'do', title: 'rotate the  deploy key!' })
  expect(String(again.result)).toContain('Already assigned')

  for (let i = 0; i < 4; i++) await assign($, { kind: 'do', title: `Task number ${i}` })
  const sixth = await assign($, { kind: 'do', title: 'One too many' })
  expect(sixth.deny).toContain('5 open tasks')
})

test('withdraw_task and list_tasks', async ($, on) => {
  const { store } = stub(on)
  await start($)
  await assign($, { kind: 'choose', title: 'Which database?', options: ['Postgres', 'SQLite'] })
  const card = (store.get(cardKey('self'))) as Card
  const id = card.tasks[0]!.id

  const listed = await $.tool.call({ tool: 'mcp__agent-hub__list_tasks', tool_use_id: 'l1' } as never)
  expect(String(listed.result)).toContain('Postgres / SQLite')

  expect((await $.tool.call({ tool: 'mcp__agent-hub__withdraw_task', tool_use_id: 'w0', id: 'nope' } as never)).deny).toContain('No open task')
  const res = await $.tool.call({ tool: 'mcp__agent-hub__withdraw_task', tool_use_id: 'w1', id } as never)
  expect(String(res.result)).toContain(`Withdrew task ${id}`)
  expect(((store.get(cardKey('self'))) as Card).tasks).toEqual([])
})

test("answering another session's task writes its reply key and hides the task", async ($, on) => {
  const { store } = stub(on, { entries: { [cardKey('other')]: otherCard() } })
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: 'Which region should prod use?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /beta/ })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount(pane('terminal'))
  await ui.input({ key: 'ans-other:t1', text: 'us-east-1' })
  expect(store.get(replyKey('other', 't1'))).toEqual({ answer: 'us-east-1', at: NOW, by: 'self' })
  expect(await ui.find({ type: 'Text', text: 'Which region should prod use?' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nothing is waiting/ })).toBeDefined()
})

test('past three tasks the rest fold into "+N more", so the summary stays in view', async ($, on) => {
  const tasks = [1, 2, 3, 4, 5].map(i => ({ id: `t${i}`, kind: 'do' as const, title: `Task number ${i}`, createdAt: NOW - 1000 + i }))
  stub(on, { entries: { [cardKey('other')]: otherCard({ tasks }) } })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ type: 'Text', text: 'Task number 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Task number 4' })).toBeUndefined()
  await ui.press({ key: 'more-tasks' })
  expect(await ui.find({ type: 'Text', text: 'Task number 5' })).toBeDefined()
})

test('an answer that looks like a secret is refused', async ($, on) => {
  const { store } = stub(on, { entries: { [cardKey('other')]: otherCard() } })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.input({ key: 'ans-other:t1', text: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv' })
  expect(store.get(replyKey('other', 't1'))).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /looks like a secret/ })).toBeDefined()

  expect(looksLikeSecret('ghp_0123456789abcdefghijABCDEFGHIJ')).toBe(true)
  expect(looksLikeSecret('AKIAABCDEFGHIJKLMNOP')).toBe(true)
  expect(looksLikeSecret('password: hunter22')).toBe(true)
  expect(looksLikeSecret('Use us-east-1, and keep the staging DB as it is.')).toBe(false)
})

test('a reply for this session reaches the model as a prompt, once', async ($, on) => {
  const task: Task = { id: 'tq', kind: 'choose', title: 'Which database?', options: ['Postgres', 'SQLite'], createdAt: NOW }
  const mine: Card = { ...otherCard({ sid: 'self', name: 'alpha', hostId: undefined }), tasks: [task] }
  const { calls, clock, store } = stub(on, { entries: { [cardKey('self')]: mine, [replyKey('self', 'tq')]: { answer: 'SQLite', at: NOW, by: 'other' } } })
  await start($)
  expect(calls.submitted).toEqual(['[Agent Hub] The user chose "SQLite" for your task tq: "Which database?".'])
  expect(store.get(replyKey('self', 'tq'))).toBeUndefined()
  expect(((store.get(cardKey('self'))) as Card).tasks).toEqual([])
  await clock.advance(10_000)
  expect(calls.submitted.length).toBe(1)
})

test('Done on a do-task sends a done message', async ($, on) => {
  const { calls, clock, store } = stub(on)
  await start($)
  await assign($, { kind: 'do', title: 'Approve the App Store build' })
  const id = ((store.get(cardKey('self'))) as Card).tasks[0]!.id
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: `done-self:${id}` })
  await clock.advance(3_000)
  expect(calls.submitted).toEqual([`[Agent Hub] The user marked your task ${id} as done: "Approve the App Store build".`])
})

test("a session gone quiet loses its tasks from the panel but keeps its updates", async ($, on) => {
  const feed = [{ id: 'other:f1', kind: 'milestone' as const, text: 'Login page shipped', at: NOW - STALE_MS * 2 }]
  const { store } = stub(on, { entries: { [cardKey('other')]: otherCard({ heartbeat: NOW - STALE_MS - 1, feed }) } })
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: 'Which region should prod use?' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Login page shipped/ })).toBeDefined()
})

test('a turn with tools brings a summary; only new milestones become messages', async ($, on) => {
  let round = 0
  const { calls, clock, store } = stub(on, {
    model: () => {
      round += 1
      return round === 1
        ? { isAnswered: true, text: '{"milestones":["Login page works end to end"],"authorized":["Merged MR !42 (memory: may merge)"]}' }
        : { isAnswered: true, text: '{"milestones":["Login page works end to end","Tests green on CI"],"authorized":["Merged MR !42 (memory: may merge)"]}' }
    },
  })
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/alpha/a.ts' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(3_000)
  await clock.settle()
  expect(calls.models).toEqual(['haiku'])

  const ui = await $.ui.mount(pane('terminal'))
  // One message per card, newest first, each naming its project.
  expect(await ui.find({ type: 'Text', text: 'Login page works end to end' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Merged MR !42/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Summary 2/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /^alpha$/ })).toHaveLength(2)

  // Another turn within five minutes waits; after that, only the new line is added.
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/work/alpha/b.ts' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(3_000)
  expect(calls.models.length).toBe(1)
  await clock.advance(5 * 60_000)
  expect(calls.models.length).toBe(2)
  const card = (store.get(cardKey('self'))) as Card
  expect(card.feed.map(f => f.text)).toEqual(['Login page works end to end', 'Merged MR !42 (memory: may merge)', 'Tests green on CI'])
})

test('a turn without tools brings no summary', async ($, on) => {
  const { calls, clock, store } = stub(on)
  await start($)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(6 * 60_000)
  expect(calls.models).toEqual([])
})

test("when Haiku is unavailable the session's own model writes the summary; when both fail the panel says so", async ($, on) => {
  let fail = 'haiku'
  const { calls, clock, store } = stub(on, {
    model: model =>
      fail === 'all' || model === fail
        ? { isAnswered: false, reason: 'api-error', status: 404, error: 'not_found_error' }
        : { isAnswered: true, text: '{"milestones":["Ported the CLI"],"authorized":[]}' },
  })
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/x' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(3_000)
  expect(calls.models).toEqual(['haiku', 'claude-opus-5-5'])
  expect(((store.get(cardKey('self'))) as Card).feed.map(f => f.text)).toEqual(['Ported the CLI'])

  fail = 'all'
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/x' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(5 * 60_000 + 3_000)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /Updates paused: API error 404 not_found_error/ })).toBeDefined()
})

test('OK hides a message everywhere; No more like this, once turned on in settings, also mutes its kind in later summaries', async ($, on) => {
  const feed = [
    { id: 'other:f1', kind: 'milestone' as const, text: 'Bumped lodash', at: NOW - 2000 },
    { id: 'other:f2', kind: 'milestone' as const, text: 'Release 2.0 is out', at: NOW - 1000 },
  ]
  const { calls, clock, store } = stub(on, { entries: { [cardKey('other')]: otherCard({ feed, tasks: [] }) } })
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'ok-other:f2' })
  expect(store.get('ack:other:f2')).toBe(NOW)
  expect(await ui.find({ type: 'Text', text: /Release 2.0/ })).toBeUndefined()

  // Off by default: the button appears only after the setting is turned on.
  expect(await ui.find({ key: 'mute-other:f1' })).toBeUndefined()
  const settings = await $.ui.mount(pane('terminal', 'agent-hub-settings'))
  await settings.press({ key: 'toggle-muteButton-on' })
  await ui.press({ key: 'mute-other:f1' })
  expect(store.get('mute:other:f1')).toEqual({ text: 'Bumped lodash', at: NOW })
  expect(await ui.find({ type: 'Text', text: /Bumped lodash/ })).toBeUndefined()

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/x' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(3_000)
  expect(calls.prompts[0]).toContain('- Bumped lodash')
})

test('settings: language, auto-open and divider sync through the store', async ($, on) => {
  const { calls, clock, store } = stub(on, { entries: { [cardKey('other')]: otherCard({ tasks: [] }) } })
  await start($)
  await $.command.run({ command: 'hub-settings', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as never)
  expect(calls.opened).toContain('agent-hub-settings')

  const settings = await $.ui.mount(pane('terminal', 'agent-hub-settings'))
  await settings.press({ key: 'lang-zh' })
  expect(store.get('settings')).toEqual({ lang: 'zh', autoOpen: true, divider: false, muteButton: false, taskRows: 12 })
  expect(await settings.find({ type: 'Text', text: '语言' })).toBeDefined()
  await settings.press({ key: 'toggle-autoOpen-off' })
  expect(((store.get('settings')) as { autoOpen: boolean }).autoOpen).toBe(false)

  // A task arriving from another session does not open the panel now.
  store.set(cardKey('other'), otherCard())
  await clock.advance(3_000)
  expect(calls.opened.filter(id => id === 'agent-hub')).toEqual([])
  const hub = await $.ui.mount(pane('desktop'))
  expect(await hub.find({ type: 'Text', text: /待办 1/ })).toBeDefined()
  expect(calls.status.at(-1)).toBe('1 个任务等你 · /hub')
})

test('a task from another session opens the panel when auto-open is on', async ($, on) => {
  const { calls, clock, store } = stub(on)
  await start($)
  expect(calls.opened).toEqual([])
  store.set(cardKey('other'), otherCard())
  await clock.advance(3_000)
  expect(calls.opened).toEqual(['agent-hub'])
})

test('after /reload-plugins the first hook joins and registers everything', async ($, on) => {
  const { calls, store } = stub(on)
  // No session.start: a reload does not fire it.
  const ui = await $.ui.mount(pane('terminal'))
  await ui.redraw()
  expect(calls.tools).toEqual(['assign_task', 'withdraw_task', 'list_tasks'])
  expect(calls.commands).toEqual(['hub', 'hub-settings'])
  expect((store.get(cardKey('self'))) as Card).toBeDefined()
})

test('the system prompt gains the steering section, last', async ($, on) => {
  const { store } = stub(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  const out = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(out.sections.map(s => s.id)).toEqual(['intro', 'agent-hub:steering'])
  expect(out.sections.at(-1)!.text).toContain('assign_task')
})

test('after a compact the model is told which tasks are still open', async ($, on) => {
  const { session, store } = stub(on)
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }))
  await start($)
  await assign($, { kind: 'answer', title: 'What should the bucket be called?' })
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
  const rows = session.appended().map(r => JSON.stringify(r.message.content))
  expect(rows.some(r => r.includes('What should the bucket be called?'))).toBe(true)
})

test('Jump opens the desktop session; terminal sessions and this session show no jump', async ($, on) => {
  const { calls, store } = stub(on, {
    host: 'local_self',
    entries: { [cardKey('other')]: otherCard(), [cardKey('term')]: otherCard({ sid: 'term', hostId: undefined, tasks: [{ id: 't9', kind: 'do', title: 'Plug in the YubiKey', createdAt: NOW }] }) },
  })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'jump-other:t1' })
  expect(calls.run).toEqual([['open', 'claude://claude.ai/epitaxy/local_other']])
  expect(await ui.find({ key: 'jump-term:t9' })).toBeUndefined()

  // A task this session handed out is already here: nothing to jump to.
  await assign($, { kind: 'do', title: 'Rotate the deploy key' })
  const id = ((store.get(cardKey('self'))) as Card).tasks[0]!.id
  const mine = await $.ui.mount(pane('desktop'))
  expect(await mine.find({ type: 'Text', text: 'Rotate the deploy key' })).toBeDefined()
  expect(await mine.find({ key: `jump-self:${id}` })).toBeUndefined()
})

test('the divider, when on, drags the task area taller', async ($, on) => {
  const { store } = stub(on, { entries: { settings: { lang: 'en', autoOpen: true, divider: true, taskRows: 10 } } })
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(textOf(await ui.find({ type: 'Text', text: /────/, in: 'divider' }))).toContain('────')
    await ui.unmount()
  }
  const ui = await $.ui.mount(pane('terminal'))
  await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 5, y: 4, button: 'left' })
  expect(((store.get('settings')) as { taskRows: number }).taskRows).toBe(14)
})

test('old data is pruned after seven days; mutes stay', () => {
  const week = 7 * 24 * 60 * 60_000
  const entries = {
    'card:old': otherCard({ sid: 'old', heartbeat: NOW - week - 1 }),
    'card:new': otherCard({ sid: 'new' }),
    'reply:old:t1': { answer: 'x', at: NOW - week - 1, by: 'a' },
    'ack:x': NOW - week - 1,
    'mute:x': { text: 'x', at: NOW - week - 1 },
  }
  expect(staleKeys(entries, NOW)).toEqual(['card:old', 'reply:old:t1', 'ack:x'])
  expect(newItems({ milestones: ['A done'], authorized: [] }, { milestones: ['a done.', 'B done'], authorized: ['C'] })).toEqual({ milestones: ['B done'], authorized: ['C'] })
})
