import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, FeedItem, Reply, HubSettings, Snapshot, Summary, Task, TaskKind } from '../types'
import {
  DEFAULT_SETTINGS,
  HEARTBEAT_MS,
  HUB_PANE,
  MAX_FEED,
  MAX_OPEN_TASKS,
  POLL_MS,
  SETTINGS_KEY,
  SETTINGS_PANE,
  SUMMARY_GAP_MS,
  ackKey,
  cardKey,
  duplicateOf,
  looksLikeSecret,
  muteKey,
  newItems,
  openTasks,
  parseSummary,
  readSettings,
  readSummary,
  replyKey,
  shortHash,
  snapshotOf,
  staleKeys,
  statusText,
  summaryPrompt,
  t,
  transcriptText,
} from './hub'
import type { FeedRow, OpenTask } from './hub'
import { renderHub, renderSettings } from './panel'
import type { Actions } from './panel'
import {
  ASSIGN_DESCRIPTION,
  ASSIGN_SCHEMA,
  LIST_DESCRIPTION,
  STEERING,
  WITHDRAW_DESCRIPTION,
  WITHDRAW_SCHEMA,
} from './steering'

const snapAtom = atom({ plugin: 'agent-hub', key: 'snap' } as const, null)
const settingsAtom = atom({ plugin: 'agent-hub', key: 'settings' } as const, DEFAULT_SETTINGS)
const errorsAtom = atom({ plugin: 'agent-hub', key: 'errors' } as const, {})
const bandAtom = atom({ plugin: 'agent-hub', key: 'bandOpen' } as const, false)

const TOOL = {
  assign: 'mcp__agent-hub__assign_task',
  withdraw: 'mcp__agent-hub__withdraw_task',
  list: 'mcp__agent-hub__list_tasks',
} as const

const PRUNE_EVERY_MS = 10 * 60_000

// Module state: a reload starts it over, and the lazy join below rebuilds it.
const rt = {
  joining: undefined as Promise<void> | undefined,
  sid: '',
  startHandled: false,
  hostId: undefined as string | undefined,
  seenTasks: undefined as Set<string> | undefined,
  toolsThisTurn: 0,
  summaryDue: false,
  summarizing: false,
  lastPrune: 0,
  seenSessions: '',
  writes: Promise.resolve() as Promise<unknown>,
}

/** Every hook calls this: /reload-plugins fires no session.start, so the first hook to run joins. */
export function join($: EngineInterface) {
  rt.joining ??= doJoin($).catch(err => {
    rt.joining = undefined
    throw err
  })
  return rt.joining
}

async function doJoin($: EngineInterface) {
  rt.sid = await $.session.id()
  rt.hostId = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) || undefined
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  const old = (await $.store.get(cardKey(rt.sid))) as Card | undefined
  const card: Card = {
    sid: rt.sid,
    hostId: rt.hostId,
    cwd,
    name: cwd.split('/').filter(Boolean).at(-1) ?? cwd,
    heartbeat: now,
    tasks: old?.tasks ?? [],
    feed: old?.feed ?? [],
    summary: readSummary(old?.summary),
    summaryAt: old?.summaryAt,
  }
  await $.store.set(cardKey(rt.sid), card)

  await Promise.all([
    $.command.register({ name: 'hub', description: 'Open Agent Hub: what every session needs from you, and what each finished', immediate: true }),
    $.command.register({ name: 'hub-settings', description: 'Agent Hub settings: language, auto-open, divider', immediate: true }),
    $.tool.register({ name: 'assign_task', description: ASSIGN_DESCRIPTION, inputSchema: ASSIGN_SCHEMA, isDeferred: false }),
    $.tool.register({ name: 'withdraw_task', description: WITHDRAW_DESCRIPTION, inputSchema: WITHDRAW_SCHEMA, isDeferred: false }),
    $.tool.register({ name: 'list_tasks', description: LIST_DESCRIPTION, inputSchema: { type: 'object', properties: {} }, isDeferred: false }),
  ])

  $.clock.every(POLL_MS, () => void poll($).catch(err => $.ui.log(`agent-hub: poll failed: ${String(err)}`, { to: 'debug' })))
  $.clock.every(HEARTBEAT_MS, () => void heartbeat($).catch(() => undefined))
  await poll($)
  if (!rt.startHandled) {
    // Decide once at join, including the lazy join after /reload-plugins.
    // Polls and turns must not undo a user's close or a disabled startup setting.
    const settings = await read($, settingsAtom)
    rt.startHandled = true
    if (settings.openOnStart) await showHub($, settings.lang, false)
  }
}

/** Read-modify-write of this session's own card, one at a time. */
function mutateCard($: EngineInterface, fn: (card: Card) => Card) {
  const run = rt.writes.then(async () => {
    const card = (await $.store.get(cardKey(rt.sid))) as Card | undefined
    if (!card) return
    await $.store.set(cardKey(rt.sid), fn(card))
  })
  rt.writes = run.catch(() => undefined)
  return run
}

async function heartbeat($: EngineInterface) {
  const now = await $.clock.now()
  await mutateCard($, card => ({ ...card, heartbeat: now }))
}

async function readAll($: EngineInterface) {
  const entries: Record<string, unknown> = {}
  for (const key of await $.store.keys()) entries[key] = await $.store.get(key)
  return entries
}

async function poll($: EngineInterface) {
  const now = await $.clock.now()
  let entries = await readAll($)

  if (now - rt.lastPrune > PRUNE_EVERY_MS) {
    rt.lastPrune = now
    const stale = staleKeys(entries, now)
    for (const key of stale) await $.store.delete(key)
    if (stale.length) entries = await readAll($)
  }

  // Answers other sessions wrote for this one.
  const mine = Object.keys(entries).filter(key => key.startsWith(`reply:${rt.sid}:`))
  if (mine.length) {
    await deliver($, mine.map(key => [key.slice(`reply:${rt.sid}:`.length), entries[key] as Reply] as const))
    entries = await readAll($)
  }

  const settings = readSettings(entries[SETTINGS_KEY])
  const snap = snapshotOf(entries, rt.sid)
  const seen = snap.cards.map(c => c.sid).sort().join(',')
  if (seen !== rt.seenSessions) {
    rt.seenSessions = seen
    $.ui.log(`agent-hub: sessions in the store: ${seen}`, { to: 'debug' })
  }
  if (JSON.stringify(await read($, settingsAtom)) !== JSON.stringify(settings)) await update($, settingsAtom, () => settings)
  if (JSON.stringify(await read($, snapAtom)) !== JSON.stringify(snap)) await update($, snapAtom, () => snap)

  const open = openTasks(snap, now)
  $.ui.status(statusText(settings.lang, open.length))

  const ids = open.map(task => `${task.sid}:${task.id}`)
  const arrived = rt.seenTasks !== undefined && ids.some(id => !rt.seenTasks!.has(id))
  rt.seenTasks = new Set(ids)
  if (arrived && settings.autoOpen) void showHub($, settings.lang, false).catch(() => undefined)

  const card = snap.cards.find(c => c.sid === rt.sid)
  if (rt.summaryDue && !rt.summarizing && card && now - (card.summaryAt ?? 0) >= SUMMARY_GAP_MS) {
    rt.summaryDue = false
    rt.summarizing = true
    void summarize($, card, snap)
      .catch(err => mutateCard($, c => ({ ...c, paused: String(err) })))
      .finally(() => (rt.summarizing = false))
  }
}

/** Hands each answer to the model as a prompt: at once when idle, after the turn when busy. */
async function deliver($: EngineInterface, replies: readonly (readonly [string, Reply])[]) {
  const card = (await $.store.get(cardKey(rt.sid))) as Card | undefined
  for (const [id, reply] of replies) {
    const task = card?.tasks.find(x => x.id === id)
    // Submit first: if it fails, the reply key stays and the next poll tries again.
    if (task) await $.prompt.submit({ text: replyMessage(task, reply) })
    await $.store.delete(replyKey(rt.sid, id))
  }
  const answered = new Set(replies.map(([id]) => id))
  await mutateCard($, c => ({ ...c, tasks: c.tasks.filter(task => !answered.has(task.id)) }))
}

// ---- the feed ----

async function summarize($: EngineInterface, card: Card, snap: Snapshot) {
  const rows = await $.session.messages()
  const prev = readSummary(card.summary)
  const prompt = summaryPrompt(transcriptText(rows), prev, snap.mutes)
  const ask = (model: string) => $.model.complete({ model, prompt, maxTokens: 1500, effort: 'low', timeoutMs: 90_000 })
  let reply = await ask('haiku')
  if (!reply.isAnswered && reply.reason === 'api-error') reply = await ask(await $.session.model())

  const now = await $.clock.now()
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `API error ${reply.status ?? ''} ${reply.error ?? ''}`.trim() : reply.reason
    await mutateCard($, c => ({ ...c, paused: why, summaryAt: now }))
    return
  }
  const summary = parseSummary(reply.text)
  if (!summary) {
    await mutateCard($, c => ({ ...c, paused: 'the summary came back unreadable', summaryAt: now }))
    return
  }
  const fresh = newItems(prev, summary)
  const item = (kind: FeedItem['kind'], text: string): FeedItem => ({ id: `${rt.sid}:${shortHash(kind + text + now)}`, kind, text, at: now })
  const added = [...fresh.milestones.map(s => item('milestone', s)), ...fresh.authorized.map(s => item('authorized', s))]
  await mutateCard($, c => ({ ...c, summary, summaryAt: now, paused: undefined, feed: [...c.feed, ...added].slice(-MAX_FEED) }))
  await poll($)
}

// ---- actions the panel calls ----

export function actions($: EngineInterface): Actions {
  return {
    complete: task => sendReply($, task, ''),
    answer: async (task, text) => {
      const key = `${task.sid}:${task.id}`
      if (looksLikeSecret(text)) {
        const { lang } = await read($, settingsAtom)
        await update($, errorsAtom, errs => ({ ...errs, [key]: t(lang, 'secretRefused') }))
        return
      }
      await update($, errorsAtom, ({ [key]: _, ...rest }) => rest)
      await sendReply($, task, text.trim())
    },
    choose: (task, option) => sendReply($, task, option),
    ack: async row => {
      await $.store.set(ackKey(row.id), await $.clock.now())
      await poll($)
    },
    ackAll: async rows => {
      const now = await $.clock.now()
      for (const row of rows) await $.store.set(ackKey(row.id), now)
      await poll($)
    },
    mute: async row => {
      const now = await $.clock.now()
      await $.store.set(ackKey(row.id), now)
      await $.store.set(muteKey(row.id), { text: row.text, at: now })
      await poll($)
    },
    jump: async target => {
      await $.process.run(['open', `claude://claude.ai/epitaxy/${target}`])
    },
    setSettings: async patch => {
      const next: HubSettings = { ...(await read($, settingsAtom)), ...patch }
      await $.store.set(SETTINGS_KEY, next)
      await update($, settingsAtom, () => next)
    },
  }
}

async function sendReply($: EngineInterface, task: OpenTask, answer: string) {
  const value: Reply = { answer, at: await $.clock.now(), by: rt.sid }
  await $.store.set(replyKey(task.sid, task.id), value)
  await poll($)
}

/**
 * In a plain terminal the hub is a band above the prompt: it draws on the terminal's own
 * background, where a docked pane gets the engine's grey. Elsewhere it is a pane.
 * `toggle` (the /hub command) closes an open band; an arriving task only opens it.
 * Returns whether the hub is showing afterwards.
 */
async function showHub($: EngineInterface, lang: HubSettings['lang'], toggle: boolean) {
  const surfaces = await $.session.surfaces()
  const terminalOnly = surfaces.length > 0 && surfaces.every(s => s === 'terminal')
  if (!terminalOnly) {
    await $.ui.open({ id: HUB_PANE, title: t(lang, 'title'), focus: toggle ? true : undefined })
    return true
  }
  const open = toggle ? !(await read($, bandAtom)) : true
  await update($, bandAtom, () => open)
  return open
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await join($)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    void join($).catch(() => undefined)
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'agent-hub:steering', text: STEERING, scope: 'session' as const }] }
  })

  on('command.run', { command: 'hub' }, async ($, e) => {
    await join($)
    const { lang } = await read($, settingsAtom)
    const shown = await showHub($, lang, true)
    return { text: t(lang, shown ? 'opened' : 'closed') }
  })

  on('command.run', { command: 'hub-settings' }, async ($, e) => {
    await join($)
    const { lang } = await read($, settingsAtom)
    await $.ui.open({ id: SETTINGS_PANE, title: t(lang, 'settingsTitle'), focus: true, closeOnEscape: true })
    return { text: t(lang, 'settingsOpened') }
  })

  on('tool.call', { tool: TOOL.assign }, async ($, e) => {
    await join($)
    const input = e as unknown as { kind?: string; title?: string; detail?: string; options?: unknown }
    const kind = input.kind as TaskKind
    const title = String(input.title ?? '').trim()
    if (!['do', 'answer', 'choose'].includes(kind)) return { deny: 'kind must be "do", "answer" or "choose".' }
    if (!title) return { deny: 'title is required.' }
    const options = Array.isArray(input.options) ? input.options.map(String).map(s => s.trim()).filter(Boolean) : []
    if (kind === 'choose' && (options.length < 2 || options.length > 4)) return { deny: 'kind "choose" needs 2 to 4 options.' }

    const card = (await $.store.get(cardKey(rt.sid))) as Card
    const same = duplicateOf(card.tasks, title)
    if (same) return { result: `Already assigned as ${same.id} and still open; not assigned again. The answer will arrive as a message.` }
    if (card.tasks.length >= MAX_OPEN_TASKS) {
      return { deny: `This session already has ${MAX_OPEN_TASKS} open tasks (${card.tasks.map(x => x.id).join(', ')}). Withdraw one with withdraw_task or wait for answers.` }
    }
    const now = await $.clock.now()
    const task: Task = {
      id: `t${shortHash(rt.sid + title + now).slice(0, 5)}`,
      kind,
      title,
      ...(input.detail ? { detail: String(input.detail).trim() } : {}),
      ...(kind === 'choose' ? { options } : {}),
      createdAt: now,
    }
    await mutateCard($, c => ({ ...c, tasks: [...c.tasks, task] }))
    await poll($).catch(() => undefined)
    return { result: `Assigned task ${task.id} to the user in Agent Hub. Do not wait or poll: carry on with work that does not need it, or end your turn. Their answer will arrive as a new message.` }
  })

  on('tool.call', { tool: TOOL.withdraw }, async ($, e) => {
    await join($)
    const id = String((e as unknown as { id?: string }).id ?? '')
    const card = (await $.store.get(cardKey(rt.sid))) as Card
    if (!card.tasks.some(task => task.id === id)) return { deny: `No open task ${id}. Open: ${card.tasks.map(x => x.id).join(', ') || 'none'}.` }
    await mutateCard($, c => ({ ...c, tasks: c.tasks.filter(task => task.id !== id) }))
    await poll($).catch(() => undefined)
    return { result: `Withdrew task ${id}.` }
  })

  on('tool.call', { tool: TOOL.list }, async $ => {
    await join($)
    const card = (await $.store.get(cardKey(rt.sid))) as Card
    return { result: card.tasks.length ? card.tasks.map(taskLine).join('\n') : 'No open tasks.' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) rt.toolsThisTurn += 1
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    void join($).catch(() => undefined)
    if (e.agentId === undefined) {
      if (rt.toolsThisTurn > 0) rt.summaryDue = true
      rt.toolsThisTurn = 0
    }
    return next(e)
  })

  // After a compact, the model has lost the tool results that assigned its tasks: tell it again.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if ('skip' in result && result.skip !== undefined) return result
    const card = (await $.store.get(cardKey(rt.sid))) as Card | undefined
    if (card?.tasks.length) {
      const text = `[Agent Hub] Tasks you assigned to the user that are still open (answers arrive as messages):\n${card.tasks.map(taskLine).join('\n')}`
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    void join($).catch(() => undefined)
    if (e.surface !== 'terminal' || e.props.hasSurvey || !(await read($, bandAtom))) return next(e)
    return renderHub($, e, actions($))
  })

  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e) => {
    void join($).catch(() => undefined)
    return renderHub($, e, actions($))
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    void join($).catch(() => undefined)
    return renderSettings($, e, actions($))
  })

  // The divider's Client posts the rows it was dragged to.
  on('ui.message', { requestId: HUB_PANE }, async ($, e) => {
    const rows = Number((e.data as { taskRows?: number })?.taskRows)
    if (Number.isFinite(rows)) await actions($).setSettings({ taskRows: Math.max(3, Math.min(60, Math.round(rows))) })
    return {}
  })
}

function taskLine(task: Task) {
  const options = task.options ? ` [${task.options.join(' / ')}]` : ''
  return `- ${task.id} (${task.kind}): ${task.title}${options}`
}

export function replyMessage(task: Task, reply: Reply) {
  if (task.kind === 'do') return `[Agent Hub] The user marked your task ${task.id} as done: "${task.title}".`
  if (task.kind === 'choose') return `[Agent Hub] The user chose "${reply.answer}" for your task ${task.id}: "${task.title}".`
  return `[Agent Hub] The user answered your task ${task.id} ("${task.title}"):\n${reply.answer}`
}

