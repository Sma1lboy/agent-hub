import type { Card, FeedItem, Lang, Mute, Reply, HubSettings, Snapshot, Summary, Task } from '../types'

// The pure half of Agent Hub: store keys, the view model, the guards and the copy.

export const HUB_PANE = 'agent-hub'
export const SETTINGS_PANE = 'agent-hub-settings'

export const POLL_MS = 3_000
export const HEARTBEAT_MS = 60_000
export const STALE_MS = 3 * 60_000
export const PRUNE_MS = 7 * 24 * 60 * 60_000
export const SUMMARY_GAP_MS = 5 * 60_000
export const MAX_OPEN_TASKS = 5
export const MAX_FEED = 60

export const cardKey = (sid: string) => `card:${sid}`
export const replyKey = (sid: string, id: string) => `reply:${sid}:${id}`
export const ackKey = (id: string) => `ack:${id}`
export const muteKey = (id: string) => `mute:${id}`
export const SETTINGS_KEY = 'settings'

export const DEFAULT_SETTINGS: HubSettings = { lang: 'zh', autoOpen: true, divider: false, muteButton: false, taskRows: 12 }

export function readSettings(value: unknown): HubSettings {
  const v = (value ?? {}) as Partial<HubSettings>
  return {
    lang: v.lang === 'en' ? 'en' : 'zh',
    autoOpen: v.autoOpen !== false,
    divider: v.divider === true,
    muteButton: v.muteButton === true,
    taskRows: typeof v.taskRows === 'number' && v.taskRows >= 3 ? Math.round(v.taskRows) : DEFAULT_SETTINGS.taskRows,
  }
}

/** Builds the snapshot from every store entry. */
export function snapshotOf(entries: Record<string, unknown>, self: string): Snapshot {
  const cards: Card[] = []
  const replied: string[] = []
  const acked: string[] = []
  const mutes: Mute[] = []
  for (const [key, value] of Object.entries(entries)) {
    if (key.startsWith('card:') && isCard(value)) cards.push(value)
    else if (key.startsWith('reply:')) replied.push(key.slice('reply:'.length))
    else if (key.startsWith('ack:')) acked.push(key.slice('ack:'.length))
    else if (key.startsWith('mute:') && value && typeof value === 'object') mutes.push(value as Mute)
  }
  return { self, cards, replied, acked, mutes }
}

function isCard(v: unknown): v is Card {
  const c = v as Card
  return !!c && typeof c.sid === 'string' && Array.isArray(c.tasks) && Array.isArray(c.feed)
}

export const isLive = (card: Card, now: number) => now - card.heartbeat <= STALE_MS

export type OpenTask = Task & { sid: string; name: string; hostId?: string }

/** Tasks waiting on the person: live sessions only, answered ones dropped at once. */
export function openTasks(snap: Snapshot, now: number): OpenTask[] {
  const replied = new Set(snap.replied)
  return snap.cards
    .filter(card => isLive(card, now))
    .flatMap(card =>
      card.tasks
        .filter(task => !replied.has(`${card.sid}:${task.id}`))
        .map(task => ({ ...task, sid: card.sid, name: card.name, hostId: card.hostId })),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

export type FeedRow = FeedItem & { sid: string; name: string }

/** The progress feed, newest first; kept after its session leaves. */
export function feedRows(snap: Snapshot): FeedRow[] {
  const acked = new Set(snap.acked)
  return snap.cards
    .flatMap(card => card.feed.map(item => ({ ...item, sid: card.sid, name: card.name })))
    .filter(item => !acked.has(item.id))
    .sort((a, b) => b.at - a.at)
}

export const pausedCards = (snap: Snapshot, now: number) => snap.cards.filter(card => card.paused && isLive(card, now))

/** Store keys old enough to drop. Mutes stay: they are the person's preferences. */
export function staleKeys(entries: Record<string, unknown>, now: number): string[] {
  return Object.entries(entries)
    .filter(([key, value]) => {
      if (key.startsWith('card:')) return isCard(value) && now - value.heartbeat > PRUNE_MS
      if (key.startsWith('reply:')) return now - ((value as Reply)?.at ?? 0) > PRUNE_MS
      if (key.startsWith('ack:')) return now - Number(value ?? 0) > PRUNE_MS
      return false
    })
    .map(([key]) => key)
}

// ---- guards ----

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
]

/** An answer that looks like a credential is refused: it would land in a transcript. */
export function looksLikeSecret(text: string): boolean {
  if (SECRET_PATTERNS.some(re => re.test(text))) return true
  // A long unbroken run of mixed letters and digits reads as a token, not prose.
  return text.split(/\s+/).some(word => word.length >= 32 && /[a-z]/.test(word) && /[A-Z]/.test(word) && /\d/.test(word))
}

export const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Finds an open task that is the same ask, so one thing is never assigned twice. */
export const duplicateOf = (tasks: readonly Task[], title: string) => tasks.find(task => normalize(task.title) === normalize(title))

// ---- summaries ----

export function parseSummary(text: string): Summary | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const v = JSON.parse(match[0]) as Partial<Summary>
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim()) : [])
    return { milestones: list(v.milestones), authorized: list(v.authorized) }
  } catch {
    return null
  }
}

/** Items in `next` that `prev` did not have, compared loosely. */
export function newItems(prev: Summary | undefined, next: Summary): Summary {
  const seen = (list: readonly string[] | undefined) => new Set((list ?? []).map(normalize))
  const ms = seen(prev?.milestones)
  const au = seen(prev?.authorized)
  return {
    milestones: next.milestones.filter(s => !ms.has(normalize(s))),
    authorized: next.authorized.filter(s => !au.has(normalize(s))),
  }
}

export function summaryPrompt(transcript: string, prev: Summary | undefined, mutes: readonly Mute[]): string {
  const muted = mutes.length ? mutes.map(m => `- ${m.text}`).join('\n') : '(none)'
  return [
    'You maintain a running progress summary of one Claude Code session for its owner, who watches many sessions at once.',
    'Return ONLY a JSON object: {"milestones": string[], "authorized": string[]}.',
    '',
    'The owner skims this across many sessions, so think in OUTCOMES, at the level they would tell a teammate in one breath: "login works", "the CSV export shipped", "the flaky test is fixed". Not the steps that got there.',
    '',
    'milestones: things that are DONE and WORKING, one per user-visible outcome. Fold every step, commit, fix-up and test run that served the same goal into that one line; a long session usually has one or two, rarely more.',
    'Never mention commits, pushes, branches or hashes anywhere: the owner does not care how work was saved, only what now works.',
    'Never a milestone: a single tool call; a commit or push; reading, exploring or explaining code; answering a question; a plan; a step of an unfinished task (tests failing, "next I will...", half-done refactors). When unsure, leave it out: an empty list is the usual answer.',
    'Write each line short (about 12 words, or 25 Chinese characters) and plain: no commit hashes, file paths, command names, flags, test counts or tool names, unless the number IS the outcome (a release version, a PR or MR number).',
    'authorized: consequential actions the agent took WITHOUT asking because a standing permission covered them (memory, CLAUDE.md, settings, or a general yes given earlier for that kind of action): merging, releasing or tagging, deploying, publishing, deleting, sending something outside, spending money. Routine local work (editing, committing, running tests) is never worth listing here. Name the permission briefly, e.g. "merged MR !42 (memory: may merge)".',
    'If the agent asked about that specific action and the owner said yes, it was asked: it is not authorized, list it as a milestone only if it is one.',
    '',
    'Keep every item from the previous summary that is still true, copied WORD FOR WORD, then add new ones; if a new outcome is a later stage of an old line, add the new line rather than rewording the old one. In the language the session is in. At most 8 per list.',
    'Skip anything similar in kind to these muted items:',
    muted,
    '',
    'Previous summary:',
    JSON.stringify(prev ?? { milestones: [], authorized: [] }),
    '',
    'Transcript (oldest first, trimmed):',
    transcript,
  ].join('\n')
}

/** The transcript as text, newest kept when it is too long. */
export function transcriptText(rows: readonly { role: string; text: string; toolUses?: readonly { tool: string }[] }[], limit = 24_000): string {
  const lines = rows.map(row => {
    const tools = row.toolUses?.length ? ` [tools: ${row.toolUses.map(t => t.tool).join(', ')}]` : ''
    return `${row.role}: ${row.text.slice(0, 2_000)}${tools}`
  })
  let out = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = `${lines[i]}\n${out}`
    if (next.length > limit) break
    out = next
  }
  return out.trim()
}

export const shortHash = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// ---- copy ----

const EN = {
  title: 'Agent Hub',
  settingsTitle: 'Agent Hub settings',
  needsYou: 'To do',
  updates: 'Summary',
  nothingWaiting: 'Nothing is waiting on you.',
  noUpdates: 'No summaries yet. Each session shows up here after a turn that used tools.',
  done: 'Done',
  send: 'Send',
  answerPlaceholder: 'Your answer',
  moreTasks: '+{n} more',
  fewerTasks: 'Show less',
  jump: 'Open ↗',
  ok: 'OK',
  okAll: 'Mark all read',
  noMore: 'No more like this',
  paused: 'Updates paused: {reason}',
  secretRefused: 'That looks like a secret. Put it where the task says (a file or env var), then tell the agent where.',
  kindDo: 'do',
  kindAnswer: 'answer',
  kindChoose: 'choose',
  status: '{n} tasks need you · /hub',
  status1: '1 task needs you · /hub',
  opened: 'Agent Hub opened.',
  settingsOpened: 'Agent Hub settings opened.',
  language: 'Language',
  autoOpen: 'Open when a task arrives',
  divider: 'Draggable divider',
  muteButton: 'Show "No more like this" on messages',
  on: 'On',
  off: 'Off',
  settingsNote: 'Applies to every session on this machine.',
  ago: '{t} ago',
  now: 'just now',
}

type Copy = typeof EN

const ZH: Copy = {
  title: 'Agent Hub',
  settingsTitle: 'Agent Hub 设置',
  needsYou: '待办',
  updates: '进展',
  nothingWaiting: '没有等你处理的事。',
  noUpdates: '还没有总结。session 跑完一轮用过工具的对话后会出现在这里。',
  done: '完成',
  send: '发送',
  answerPlaceholder: '你的回答',
  moreTasks: '还有 {n} 个',
  fewerTasks: '收起',
  jump: '跳转 ↗',
  ok: 'OK',
  okAll: '全部已读',
  noMore: '不再显示这类',
  paused: '进展已暂停：{reason}',
  secretRefused: '这看起来像密钥。请按任务说的放到文件或环境变量里，再告诉 agent 放在哪。',
  kindDo: '去做',
  kindAnswer: '回答',
  kindChoose: '选择',
  status: '{n} 个任务等你 · /hub',
  status1: '1 个任务等你 · /hub',
  opened: '已打开 Agent Hub。',
  settingsOpened: '已打开 Agent Hub 设置。',
  language: '语言',
  autoOpen: '来任务时自动打开',
  divider: '可拖动分隔线',
  muteButton: '消息上显示「不再显示这类」',
  on: '开',
  off: '关',
  settingsNote: '对本机所有 session 生效。',
  ago: '{t}前',
  now: '刚刚',
}

const TABLES: Record<Lang, Copy> = { en: EN, zh: ZH }
export type CopyKey = keyof Copy

export function t(lang: Lang, key: CopyKey, vars: Record<string, string | number> = {}): string {
  return TABLES[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''))
}

export function ago(lang: Lang, then: number, now: number, short = false): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 45) return t(lang, 'now')
  const m = Math.round(s / 60)
  const span = m < 60 ? `${m}${lang === 'zh' ? ' 分钟' : 'm'}` : m < 60 * 48 ? `${Math.round(m / 60)}${lang === 'zh' ? ' 小时' : 'h'}` : `${Math.round(m / 1440)}${lang === 'zh' ? ' 天' : 'd'}`
  return short ? span : t(lang, 'ago', { t: span })
}

export const statusText = (lang: Lang, n: number) => (n === 0 ? undefined : n === 1 ? t(lang, 'status1') : t(lang, 'status', { n }))
