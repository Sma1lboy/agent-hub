import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { HubSettings } from '../types'
import { DEFAULT_SETTINGS, ago, feedRows, openTasks, pausedCards, t } from './hub'
import type { CopyKey, FeedRow, OpenTask } from './hub'

const snapAtom = atom({ plugin: 'agent-hub', key: 'snap' } as const, null)
const settingsAtom = atom({ plugin: 'agent-hub', key: 'settings' } as const, DEFAULT_SETTINGS)
const errorsAtom = atom({ plugin: 'agent-hub', key: 'errors' } as const, {})
const showAllAtom = atom({ plugin: 'agent-hub', key: 'showAllTasks' } as const, false)

// Tasks shown before "+N more", so the summary below stays in view.
const TASKS_SHOWN = 3

// The panel: tasks on top, the feed below. One tree for every surface;
// Claude Code's theme keys only, with claude orange as the one accent.

export type Actions = {
  complete: (task: OpenTask) => Promise<void>
  answer: (task: OpenTask, text: string) => Promise<void>
  choose: (task: OpenTask, option: string) => Promise<void>
  ack: (row: FeedRow) => Promise<void>
  mute: (row: FeedRow) => Promise<void>
  jump: (hostId: string) => Promise<void>
  setSettings: (patch: Partial<HubSettings>) => Promise<void>
}

type PaneInput = RenderInput<'Pane'>

const LANGS = [
  ['en', 'English'],
  ['zh', '中文'],
] as const

const KIND_KEY: Record<OpenTask['kind'], CopyKey> = { do: 'kindDo', answer: 'kindAnswer', choose: 'kindChoose' }

/** Cuts text to about `lines` lines of `columns`, so one long detail cannot stretch a card. */
const clip = (text: string, columns: number, lines: number) => {
  // Wrapped lines lose a few cells at their ends, so leave some slack; cut at a word where there is one.
  const room = Math.max(24, columns * lines - lines * 4)
  if (text.length <= room) return text
  const cut = text.slice(0, room - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > room * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export async function renderHub($: EngineInterface, e: PaneInput, act: Actions): Promise<RenderElement> {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  // Mobile has no text field: answers are typed on another surface there.
  const Input = 'Input' in els ? els.Input : undefined
  const snap = await read($, snapAtom)
  const settings = (await read($, settingsAtom)) ?? DEFAULT_SETTINGS
  const errors = (await read($, errorsAtom)) ?? {}
  const showAll = (await read($, showAllAtom)) ?? false
  const now = await $.clock.now()
  const { lang } = settings
  const tx = (key: CopyKey, vars?: Record<string, string | number>) => t(lang, key, vars)

  // The desktop draws its own controls and borders: leave their colours to it. The terminal
  // gets the theme's subtle grey so cards do not shout.
  const native = e.surface !== 'terminal'
  const cardBorder = native ? {} : { borderColor: 'subtle' as const }

  // Inside a card: the pane's width less the border and padding.
  const inner = Math.max(20, (e.props.bodyColumns || e.viewport?.columns || 60) - 4)
  const wide = inner >= 56

  const tasks = snap ? openTasks(snap, now) : []
  const feed = snap ? feedRows(snap) : []
  const paused = snap ? pausedCards(snap, now) : []
  const selfHost = snap?.cards.find(c => c.sid === snap.self)?.hostId
  const canJump = (hostId?: string): hostId is string => !!hostId && hostId !== selfHost

  const openButton = (key: string, hostId?: string) =>
    canJump(hostId) ? <Button key={key} plain dimColor hover={{ color: 'claude', dimColor: false }} label={tx('jump')} onPress={() => act.jump(hostId)} /> : null

  const header = (label: string, count: number, accent: boolean) => (
    <Text>
      <Text weight="bold" size="heading">{label}</Text> <Text color={accent && count > 0 ? 'claude' : 'subtle'}>{count}</Text>
    </Text>
  )

  const taskCard = (task: OpenTask) => {
    const key = `${task.sid}:${task.id}`
    const options = task.options ?? []
    // The desktop wraps a row of its own buttons; the terminal stacks them when they do not fit.
    const optionsInRow = native || (wide && options.join('    ').length + 8 < inner)
    return (
      <Box key={`task-${key}`} flexDirection="column" borderStyle="round" {...cardBorder} hover={{ borderColor: 'claude' }} paddingX="sm" paddingY="sm" rowGap="xs">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text>
            <Text weight="bold">{task.name}</Text>
            <Text dimColor>
              {' '}
              · {tx(KIND_KEY[task.kind])} · {ago(lang, task.createdAt, now, true)}
            </Text>
          </Text>
          {openButton(`jump-${key}`, task.hostId)}
        </Box>
        <Text weight="semibold">{task.title}</Text>
        {task.detail ? <Text dimColor>{clip(task.detail, inner, 2)}</Text> : null}
        {task.kind === 'do' ? (
          <Box flexDirection="row" marginTop="xs">
            <Button key={`done-${key}`} variant="secondary" label={tx('done')} onPress={() => act.complete(task)} />
          </Box>
        ) : task.kind === 'choose' ? (
          <Box flexDirection={optionsInRow ? 'row' : 'column'} flexWrap="wrap" gap="sm" marginTop="xs">
            {options.map((option, i) => (
              <Button key={`opt-${key}-${i}`} variant="secondary" label={option} onPress={() => act.choose(task, option)} />
            ))}
          </Box>
        ) : Input ? (
          <Box marginTop="xs" flexDirection="row" flexGrow={1}>
            <Input key={`ans-${key}`} placeholder={tx('answerPlaceholder')} submitLabel={tx('send')} onSubmit={(value: string) => (value.trim() ? act.answer(task, value) : undefined)} />
          </Box>
        ) : null}
        {errors[key] ? <Text color="error">{errors[key]}</Text> : null}
      </Box>
    )
  }

  // One card per message, newest first, each naming the project it came from.
  const feedCard = (row: FeedRow) => (
    <Box key={`feed-${row.id}`} flexDirection="row" alignItems="flex-start" borderStyle="round" {...cardBorder} hover={{ borderColor: 'claude' }} paddingX="sm" paddingY="sm">
      {row.kind === 'milestone' ? <Text color="success">✓ </Text> : <Text color="claude">↳ </Text>}
      <Box flexDirection="column" flexShrink={1} flexGrow={1} rowGap="xs">
        <Text>{row.text}</Text>
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap="md">
          <Text>
            <Text weight="semibold">{row.name}</Text>
            <Text dimColor> · {ago(lang, row.at, now, true)}</Text>
          </Text>
          <Box flexDirection="row" gap="md" {...(native ? { display: 'none' as const, hover: { display: 'flex' as const } } : {})}>
            <Button key={`ok-${row.id}`} plain dimColor hover={{ dimColor: false }} label={tx('ok')} onPress={() => act.ack(row)} />
            <Button key={`mute-${row.id}`} plain dimColor hover={{ dimColor: false }} label={tx('noMore')} onPress={() => act.mute(row)} />
            {openButton(`fjump-${row.id}`, row.hostId)}
          </Box>
        </Box>
      </Box>
    </Box>
  )

  const taskList = (
    <Box flexDirection="column" rowGap="sm">
      {tasks.length === 0 ? <Text dimColor>{tx('nothingWaiting')}</Text> : (showAll ? tasks : tasks.slice(0, TASKS_SHOWN)).map(taskCard)}
      {tasks.length > TASKS_SHOWN ? (
        <Box key="more-tasks-row" flexDirection="row">
          <Button
            key="more-tasks"
            plain
            dimColor
            hover={{ dimColor: false }}
            label={showAll ? tx('fewerTasks') : tx('moreTasks', { n: tasks.length - TASKS_SHOWN })}
            onPress={() => update($, showAllAtom, v => !v)}
          />
        </Box>
      ) : null}
    </Box>
  )

  return (
    <Box flexDirection="column" gap="md">
      <Box flexDirection="column" rowGap="sm">
        {header(tx('needsYou'), tasks.length, true)}
        {settings.divider ? (
          <Box flexDirection="column" height={settings.taskRows} overflow="hidden">
            {taskList}
          </Box>
        ) : (
          taskList
        )}
      </Box>
      {settings.divider ? divider($, e, settings.taskRows) : null}
      <Box flexDirection="column" rowGap="sm">
        {header(tx('updates'), feed.length, false)}
        {paused.map(card => (
          <Text key={`paused-${card.sid}`} color="warning">
            {card.name}: {tx('paused', { reason: card.paused ?? '' })}
          </Text>
        ))}
        <Box flexDirection="column" rowGap="sm">
          {feed.length === 0 ? <Text dimColor>{tx('noUpdates')}</Text> : feed.map(feedCard)}
        </Box>
      </Box>
    </Box>
  )
}

/** The drag handle: a Client on the surfaces that have one, nothing elsewhere. */
function divider($: EngineInterface, e: PaneInput, rows: number) {
  if (e.surface !== 'terminal' && e.surface !== 'desktop') return null
  const { Client } = $.ui.resolve({ ...e, surface: e.surface })
  return <Client key="divider" module="./divider.tsx" props={{ rows }} height={1} />
}

export async function renderSettings($: EngineInterface, e: PaneInput, act: Actions): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const settings = (await read($, settingsAtom)) ?? DEFAULT_SETTINGS
  const tx = (key: CopyKey) => t(settings.lang, key)
  const toggle = (key: 'autoOpen' | 'divider') => (
    <Box flexDirection="row" gap="sm">
      {([true, false] as const).map(on => (
        <Button key={`toggle-${key}-${on ? 'on' : 'off'}`} variant={settings[key] === on ? 'primary' : 'secondary'} label={on ? tx('on') : tx('off')} onPress={() => act.setSettings({ [key]: on })} />
      ))}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('language')}</Text>
        <Box flexDirection="row" gap="sm">
          {LANGS.map(([value, label]) => (
            <Button key={`lang-${value}`} variant={settings.lang === value ? 'primary' : 'secondary'} label={label} onPress={() => act.setSettings({ lang: value })} />
          ))}
        </Box>
      </Box>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('autoOpen')}</Text>
        {toggle('autoOpen')}
      </Box>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('divider')}</Text>
        {toggle('divider')}
      </Box>
      <Text dimColor>{tx('settingsNote')}</Text>
    </Box>
  )
}
