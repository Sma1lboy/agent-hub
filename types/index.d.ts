export type TaskKind = 'do' | 'answer' | 'choose'

export type Task = {
  id: string
  kind: TaskKind
  title: string
  detail?: string
  options?: string[]
  createdAt: number
}

export type FeedKind = 'milestone' | 'authorized'

export type FeedItem = {
  id: string
  kind: FeedKind
  text: string
  at: number
}

/** `card:<session>`: written only by that session. */
export type Card = {
  sid: string
  /** The desktop app's session id, for the jump link; absent in a plain terminal. */
  hostId?: string
  name: string
  cwd: string
  heartbeat: number
  tasks: Task[]
  feed: FeedItem[]
  /** The last summary, the baseline the next one is diffed against. */
  summary?: Summary
  summaryAt?: number
  /** Why updates stopped, shown on the panel instead of failing quietly. */
  paused?: string
}

export type Summary = { milestones: string[]; authorized: string[] }

/** `reply:<session>:<task>`: written by whichever session answered. */
export type Reply = { answer: string; at: number; by: string }

/** `mute:<feed id>`: a "no more like this". */
export type Mute = { text: string; at: number }

export type Lang = 'en' | 'zh'

export type HubSettings = { lang: Lang; autoOpen: boolean; divider: boolean; taskRows: number }

/** Everything the panel draws, read from the store every poll. */
export type Snapshot = {
  self: string
  cards: Card[]
  replied: string[]
  acked: string[]
  mutes: Mute[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-hub': {
      snap: Snapshot | null
      settings: HubSettings
      errors: Record<string, string>
    }
  }
}
