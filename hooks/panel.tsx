import { atom, read } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { HubSettings } from '../types'
import { DEFAULT_SETTINGS, ago, feedRows, openTasks, pausedCards, t } from './hub'
import type { CopyKey, FeedRow, OpenTask } from './hub'

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

  const tasks = snap ? openTasks(snap, now) : []
  const feed = snap ? feedRows(snap) : []
  const paused = snap ? pausedCards(snap, now) : []
  const canJump = (hostId?: string): hostId is string => !!hostId && hostId !== snap?.cards.find(c => c.sid === snap.self)?.hostId

  const jumpButton = (key: string, hostId?: string) =>
    canJump(hostId) ? (
      <Button key={key} plain dimColor hover={{ color: 'claude', dimColor: false }} label={tx('jump')} onPress={() => act.jump(hostId)} />
    ) : null

  const taskCard = (task: OpenTask) => {
    const key = `${task.sid}:${task.id}`
    return (
      <Box key={`task-${key}`} flexDirection="column" borderStyle="round" borderColor="subtle" hover={{ borderColor: 'claude' }} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text>
            <Text color="warning">{tx(KIND_KEY[task.kind])}</Text> <Text weight="semibold">{task.title}</Text>
          </Text>
          {jumpButton(`jump-${key}`, task.hostId)}
        </Box>
        <Text dimColor>
          {task.name} · {ago(lang, task.createdAt, now)}
        </Text>
        {task.detail ? <Text>{task.detail}</Text> : null}
        {task.kind === 'do' ? (
          <Box flexDirection="row">
            <Button key={`done-${key}`} variant="secondary" label={tx('done')} onPress={() => act.complete(task)} />
          </Box>
        ) : task.kind === 'choose' ? (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {(task.options ?? []).map((option, i) => (
              <Button key={`opt-${key}-${i}`} variant="secondary" label={option} onPress={() => act.choose(task, option)} />
            ))}
          </Box>
        ) : Input ? (
          <Input key={`ans-${key}`} placeholder={tx('answerPlaceholder')} submitLabel={tx('send')} onSubmit={(value: string) => (value.trim() ? act.answer(task, value) : undefined)} />
        ) : null}
        {errors[key] ? <Text color="error">{errors[key]}</Text> : null}
      </Box>
    )
  }

  const feedRow = (row: FeedRow) => (
    <Box key={`feed-${row.id}`} flexDirection="column" borderStyle="round" borderColor="subtle" hover={{ borderColor: 'claude' }} paddingX={1}>
      <Text>
        {row.kind === 'milestone' ? <Text color="success">✓ </Text> : <Text color="claude">↳ </Text>}
        {row.text}
      </Text>
      <Box flexDirection="row" gap={2}>
        <Text dimColor>
          {row.name} · {ago(lang, row.at, now)}
        </Text>
        <Button key={`ok-${row.id}`} plain dimColor hover={{ dimColor: false }} label={tx('ok')} onPress={() => act.ack(row)} />
        <Button key={`mute-${row.id}`} plain dimColor hover={{ dimColor: false }} label={tx('noMore')} onPress={() => act.mute(row)} />
        {jumpButton(`fjump-${row.id}`, row.hostId)}
      </Box>
    </Box>
  )

  const taskList = (
    <Box flexDirection="column" gap={0}>
      {tasks.length === 0 ? <Text dimColor>{tx('nothingWaiting')}</Text> : tasks.map(taskCard)}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text weight="bold" color={tasks.length ? 'claude' : undefined}>
          {tx('needsYou')} · {tasks.length}
        </Text>
        {settings.divider ? (
          <Box flexDirection="column" height={settings.taskRows} overflow="hidden">
            {taskList}
          </Box>
        ) : (
          taskList
        )}
      </Box>
      {settings.divider ? divider($, e, settings.taskRows) : null}
      <Box flexDirection="column">
        <Text weight="bold">
          {tx('updates')} · {feed.length}
        </Text>
        {paused.map(card => (
          <Text key={`paused-${card.sid}`} color="warning">
            {card.name}: {tx('paused', { reason: card.paused ?? '' })}
          </Text>
        ))}
        {feed.length === 0 ? <Text dimColor>{tx('noUpdates')}</Text> : feed.map(feedRow)}
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
