/**
 * Undo state shared between the history panel and the chat visibility layer.
 *
 * A rewind hides a span of chat nodes (from the target message up to the marker
 * it appended). Undoing that rewind must bring exactly that span back, so the
 * visibility layer needs to know WHICH cuts are no longer in force. The history
 * entry carries the pair `targetSeq` + `markerSeq`, which is precisely the
 * identity of a cut, so an entry with `undoneAt` set names a cut to release.
 *
 * This module holds that set. It is written when history is loaded / after an
 * undo, and read whenever the visibility layer recomputes its cuts.
 */
import type { RewindCut } from './hidden.ts'
import type { HistoryEntryView } from './host-rpc.ts'

/** The cut identity derived from a history entry (target + marker). */
export function cutKey(target: number, marker: number): string {
  return `${target}:${marker}`
}

/** The cuts a rewind produced, identified the same way `cutKey` does. */
function cutKeyOf(cut: RewindCut): string {
  return cutKey(cut.target, cut.marker)
}

/**
 * Collect the cut keys named by history entries that have been undone.
 *
 * Entries recorded before `markerSeq` existed cannot name their cut; they are
 * skipped, which leaves their span hidden. That is the safe direction: a wrong
 * release would expose a conversation the user did not undo.
 */
export function undoneCutKeysOf(entries: readonly HistoryEntryView[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const entry of entries) {
    if (entry.undoneAt === undefined) continue
    if (entry.markerSeq === undefined) continue
    keys.add(cutKey(entry.targetSeq, entry.markerSeq))
  }
  return keys
}

let undone: ReadonlySet<string> = new Set<string>()

/**
 * Replace the set of released cuts.
 * @returns true when the set changed (callers then refresh visible nodes).
 */
export function setUndoneCutKeys(next: ReadonlySet<string>): boolean {
  const same = next.size === undone.size && [...next].every(key => undone.has(key))
  if (same) return false
  undone = new Set(next)
  return true
}

/** Drop all knowledge of undone cuts (plugin teardown). */
export function resetUndoneCutKeys(): void {
  undone = new Set<string>()
}

/** Whether this cut has been undone and must no longer hide anything. */
export function isCutUndone(cut: RewindCut): boolean {
  return undone.size > 0 && undone.has(cutKeyOf(cut))
}

/** How many cuts are currently released (exposed for diagnostics/tests). */
export function undoneCutCount(): number {
  return undone.size
}
