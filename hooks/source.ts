import type { EngineInterface } from 'claude-code'
import type { Card } from '../types'

export const basename = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? path

export function shortTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? line.slice(0, 79) + '…' : line
}

/** session.repo resolves linked worktrees to their main repository root. */
export async function projectName($: EngineInterface, cwd: string): Promise<string> {
  const repo = await $.session.repo().catch(() => null)
  const remote = repo?.remote?.replace(/\/+$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '')
  return remote || basename(repo?.root || cwd.split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0] || cwd)
}

export async function currentBranch($: EngineInterface, cwd: string): Promise<string | undefined> {
  try {
    const result = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 2000 })
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

export async function firstPromptTitle($: EngineInterface): Promise<string | undefined> {
  const rows = await $.session.messages().catch(() => [])
  return shortTitle(rows.find(row => row.role === 'user' && row.text.trim())?.text ?? '') || undefined
}

/** Optional metadata keeps cards written by older sessions readable. */
export function sourceLabel(card: Pick<Card, 'name' | 'repo' | 'branch' | 'title'>): string {
  return [card.repo || card.name, card.branch, card.title || (card.repo ? card.name : undefined)].filter(Boolean).join(' · ')
}
