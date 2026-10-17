import { atom, read } from 'claude-code'
import type { Color, EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { FeedItem, HubSettings } from '../types'
import { DEFAULT_SETTINGS, ago, openTasks, sessionViews, t } from './hub'
import type { Chip, CopyKey, FeedRow, OpenTask, SessionView } from './hub'

const snapAtom = atom({ plugin: 'agent-hub', key: 'snap' } as const, null)
const settingsAtom = atom({ plugin: 'agent-hub', key: 'settings' } as const, DEFAULT_SETTINGS)
const errorsAtom = atom({ plugin: 'agent-hub', key: 'errors' } as const, {})

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

const KIND_KEY: Record<OpenTask['kind'], CopyKey> = { do: 'kindDo', answer: 'kindAnswer', choose: 'kindChoose' }

const CHIP_KEY: Record<Chip, CopyKey> = { working: 'chipWorking', idle: 'chipIdle', done: 'chipDone', blocked: 'chipBlocked', offline: 'chipOffline' }
const CHIP_COLOR: Record<Chip, Color> = { working: 'claude', idle: 'subtle', done: 'success', blocked: 'warning', offline: 'inactive' }

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
  const now = await $.clock.now()
  const { lang } = settings
  const tx = (key: CopyKey, vars?: Record<string, string | number>) => t(lang, key, vars)

  // Inside a card: the pane's width less the border and padding.
  const inner = Math.max(20, (e.props.bodyColumns || e.viewport?.columns || 60) - 4)
  const wide = inner >= 56
  // Per-message actions show on hover where the surface reports the pointer, inline elsewhere.
  const hovers = e.surface === 'desktop' || e.viewport?.isFullscreen === true

  const tasks = snap ? openTasks(snap, now) : []
  const sessions = snap ? sessionViews(snap, now) : []
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
    const optionsInRow = wide && options.join('    ').length + 8 < inner
    return (
      <Box key={`task-${key}`} flexDirection="column" borderStyle="round" borderColor="subtle" hover={{ borderColor: 'claude' }} paddingX="sm" paddingY="sm" rowGap="xs">
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
          <Box flexDirection={optionsInRow ? 'row' : 'column'} gap={optionsInRow ? 1 : 0} marginTop="xs">
            {options.map((option, i) => (
              <Button key={`opt-${key}-${i}`} variant="secondary" label={option} onPress={() => act.choose(task, option)} />
            ))}
          </Box>
        ) : Input ? (
          <Box marginTop="xs">
            <Input key={`ans-${key}`} placeholder={tx('answerPlaceholder')} submitLabel={tx('send')} onSubmit={(value: string) => (value.trim() ? act.answer(task, value) : undefined)} />
          </Box>
        ) : null}
        {errors[key] ? <Text color="error">{errors[key]}</Text> : null}
      </Box>
    )
  }

  const itemActions = (row: FeedRow) => [
    <Button key={`ok-${row.id}`} plain dimColor hover={{ dimColor: false }} label={tx('ok')} onPress={() => act.ack(row)} />,
    <Button key={`mute-${row.id}`} plain dimColor hover={{ dimColor: false }} label={tx('noMore')} onPress={() => act.mute(row)} />,
  ]

  const itemRow = (view: SessionView, item: FeedItem) => {
    const row: FeedRow = { ...item, sid: view.card.sid, name: view.card.name, hostId: view.card.hostId }
    const mark = item.kind === 'milestone' ? <Text color="success">✓ </Text> : <Text color="claude">↳ </Text>
    return hovers ? (
      <Box key={`item-${item.id}`} flexDirection="row">
        {mark}
        <Box flexShrink={1}>
          <Text>{item.text}</Text>
        </Box>
        <Box display="none" hover={{ display: 'flex' }} position="absolute" right={0} top={0} gap="md" paddingX="sm" backgroundColor="inverseText">
          {itemActions(row)}
        </Box>
      </Box>
    ) : (
      <Box key={`item-${item.id}`} flexDirection="column">
        <Box flexDirection="row">
          {mark}
          <Box flexShrink={1}>
            <Text>{item.text}</Text>
          </Box>
        </Box>
        <Box flexDirection="row" gap={2} marginLeft={2}>
          {itemActions(row)}
        </Box>
      </Box>
    )
  }

  const sessionCard = (view: SessionView) => {
    const { card } = view
    const summary = card.summary
    return (
      <Box key={`sess-${card.sid}`} flexDirection="column" borderStyle="round" borderColor="subtle" hover={{ borderColor: 'claude' }} paddingX="sm" paddingY="sm" rowGap="xs">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text weight="bold">{card.name}</Text>
          <Box flexDirection="row" gap={2}>
            <Text color={CHIP_COLOR[view.chip]}>● {tx(CHIP_KEY[view.chip])}</Text>
            {openButton(`sjump-${card.sid}`, card.hostId)}
          </Box>
        </Box>
        {summary?.goal ? <Text weight="semibold">{clip(summary.goal, inner, 2)}</Text> : null}
        {view.items.length ? (
          <Box flexDirection="column" rowGap="xs" paddingY="xs">
            {view.items.map(item => itemRow(view, item))}
          </Box>
        ) : null}
        {summary?.now ? <Text>{clip(summary.now, inner, 2)}</Text> : null}
        {card.paused ? <Text color="warning">{tx('paused', { reason: card.paused })}</Text> : null}
        {card.summaryAt ? <Text dimColor>{tx('summarized', { t: ago(lang, card.summaryAt, now) })}</Text> : null}
      </Box>
    )
  }

  const taskList = (
    <Box flexDirection="column" rowGap="sm">
      {tasks.length === 0 ? <Text dimColor>{tx('nothingWaiting')}</Text> : tasks.map(taskCard)}
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
        {header(tx('updates'), sessions.length, false)}
        <Box flexDirection="column" rowGap="sm">
          {sessions.length === 0 ? <Text dimColor>{tx('noUpdates')}</Text> : sessions.map(sessionCard)}
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
  const { Box, Text, Button, Select } = $.ui.resolve(e as PaneInput & { surface: 'terminal' })
  const settings = (await read($, settingsAtom)) ?? DEFAULT_SETTINGS
  const tx = (key: CopyKey) => t(settings.lang, key)
  const toggle = (key: 'autoOpen' | 'divider') => (
    <Button key={`toggle-${key}`} variant="secondary" label={settings[key] ? tx('on') : tx('off')} onPress={() => act.setSettings({ [key]: !settings[key] })} />
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('language')}</Text>
        <Select
          key="lang"
          value={settings.lang}
          options={[
            { value: 'en', label: 'English' },
            { value: 'zh', label: '中文' },
          ]}
          onSelect={value => act.setSettings({ lang: value === 'zh' ? 'zh' : 'en' })}
        />
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
