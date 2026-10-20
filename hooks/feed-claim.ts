import type { EngineInterface } from 'claude-code'
import { SUMMARY_GAP_MS } from './hub'

const PREFIX = 'feed-claim:'

/**
 * Store has no CAS. Each session writes only its own claim, then checks for
 * competitors. Both contenders may yield; neither can overlook an existing
 * writer. Never use a shared last-writer-wins lock key.
 * A crashed writer reserves at most one cadence interval. A resumed writer
 * must check its deadline immediately before publishing.
 */
export async function withFeedClaim(
  $: { store: EngineInterface['store']; clock: Pick<EngineInterface['clock'], 'now'> },
  sid: string,
  publish: (valid: () => Promise<boolean>) => Promise<boolean>,
): Promise<boolean> {
  const key = PREFIX + sid
  const at = await $.clock.now()
  await $.store.set(key, at)
  const valid = async () => (await $.clock.now()) - at < SUMMARY_GAP_MS
  try {
    for (const other of await $.store.keys()) {
      if (other === key || !other.startsWith(PREFIX)) continue
      const claim = await $.store.get(other)
      if (typeof claim === 'number' && at - claim < SUMMARY_GAP_MS) return false
    }
    if (!await valid()) return false
    return await publish(valid)
  } finally {
    await $.store.delete(key)
  }
}
