import type { EngineInterface, SessionMessage } from 'claude-code'
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
    return result.exitCode === 0 ? meaningfulBranch(result.stdout.trim(), cwd) : undefined
  } catch {
    return undefined
  }
}

export async function firstPromptTitle($: EngineInterface): Promise<string | undefined> {
  const rows = await $.session.messages().catch(() => [])
  return promptTitle(rows.find(isPrompt)?.text ?? '')
}

/** Host-injected user rows must never become a session title or turn boundary. */
export function promptTitle(text: string): string | undefined {
  const value = text.trim()
  if (/^<(?:system-reminder|command-[\w-]+|local-command-[\w-]+|tool_result)(?:[\s>])/i.test(value)
    || /^This session is being continued from a previous conversation/i.test(value)
    || /^\[Standup\]/.test(value)) return undefined
  return shortTitle(value) || undefined
}

const isPrompt = (row: SessionMessage) => row.role === 'user' && !row.toolResults?.length && !!promptTitle(row.text)

function meaningfulBranch(branch: string | undefined, cwd?: string): string | undefined {
  if (!branch || branch.startsWith('claude/') || (cwd?.includes('/.claude/worktrees/') && branch === basename(cwd))) return undefined
  return branch.length > 36 ? '…' + branch.slice(-35) : branch
}

/** Resolve edited files in the latest turn, including symlinks, through Git itself. */
export async function turnRepo($: EngineInterface, cwd: string, rows: readonly SessionMessage[]): Promise<string | undefined> {
  const start = rows.findLastIndex(isPrompt)
  const paths = new Map<string, number>()
  for (const row of rows.slice(Math.max(0, start))) {
    for (const use of row.toolUses) {
      if (use.isError || !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(use.tool)) continue
      const input = use.input as Record<string, unknown>
      const path = input?.file_path ?? input?.notebook_path
      if (typeof path === 'string' && path.trim()) paths.set(path, (paths.get(path) ?? 0) + 1)
    }
  }
  const roots = new Map<string, number>()
  for (const [path, count] of paths) {
    const absolute = path.startsWith('/') ? path : `${cwd}/${path}`
    let dir = absolute.slice(0, absolute.lastIndexOf('/')) || '/'
    // A new file can have a not-yet-created parent; try its nearest existing ancestor.
    while (dir) {
      try {
        const result = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 2000 })
        if (result.exitCode === 0 && result.stdout.trim()) {
          const root = result.stdout.trim()
          roots.set(root, (roots.get(root) ?? 0) + count)
          break
        }
      } catch { /* Missing directory or Git: fall back to an ancestor, then the card. */ }
      if (dir === cwd || dir === '/') break
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
    }
  }
  const root = [...roots].sort((a, b) => b[1] - a[1])[0]?.[0]
  return root ? basename(root.split('/.claude/worktrees/')[0]!) : undefined
}

/** Optional metadata keeps cards written by older sessions readable. */
export function sourceLabel(card: Pick<Card, 'name' | 'repo' | 'branch' | 'title'> & { cwd?: string }): string {
  return [card.repo || card.name, meaningfulBranch(card.branch, card.cwd), promptTitle(card.title ?? '') || (card.repo ? card.name : undefined)].filter(Boolean).join(' · ')
}
