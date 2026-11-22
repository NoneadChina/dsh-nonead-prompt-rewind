/**
 * A rewind withdraws a span of dialogue with a surface `replace`, which has no
 * inverse: the log stays append-only and the shadowed events stay shadowed.
 * These tests pin what an undo may and may not do about that:
 *
 *   - `collectDialog` keeps the withdrawn text (human prompts + assistant text,
 *     no tool traffic) so the journal can audit it;
 *   - the cut really removes both sides from the surface, and an undo does NOT
 *     republish them — replaying would append NEW events with no Turn location
 *     and would push later output out of order. Releasing the cut in the Chat
 *     view is the undo path (covered by visibility tests);
 *   - a conversation-only restore still writes a journal, so the one undo can
 *     roll it back.
 */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '../src/snapshot.ts'
import { collectDialog } from '../src/index.ts'
import { appendTurn, rewindMarker } from './helpers.ts'
import { planRewind } from '../src/rewind.ts'

/** Visible text of one surface node (user or assistant). */
function surfaceText(session: Session, seq: number): string {
  const event = session.eventAt(seq as SessionSeq) as SessionEvent | undefined
  if (event === undefined) return ''
  if (event.type === 'user/message') {
    return (event.data as unknown as { content: readonly { type: string; text?: string }[] }).content
      .map(block => block.text ?? '')
      .join('')
  }
  if (event.type === 'assistant/message') {
    return (event.data as unknown as { message: { content: readonly { type: string; text?: string }[] } }).message.content
      .map(block => block.text ?? '')
      .join('')
  }
  return ''
}

describe('dialog capture', () => {
  it('keeps the withdrawn text in the journal and leaves the cut alone', () => {
    const session = Session.create(SessionId('dialog-session'))
    appendTurn(session, 1)
    appendTurn(session, 2)

    // Rewind to turn 1's user message: turn 1's answer and all of turn 2 are
    // the discarded future.
    const target = session.snapshotEvents().find(event => event.type === 'user/message')!.seq
    const plan = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'seq', seq: target })
    const dialog = collectDialog(session, plan.shadowedSeqs)

    expect(dialog.map(item => item.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(JSON.stringify(dialog[0]!.content)).toContain('question 1')
    expect(JSON.stringify(dialog[1]!.content)).toContain('answer 1')
    expect(JSON.stringify(dialog[2]!.content)).toContain('question 2')
    expect(JSON.stringify(dialog[3]!.content)).toContain('answer 2')

    const marker = session.append('user/message', rewindMarker(), {
      surfaceOp: { op: 'replace', startSeq: plan.surfaceStart as SessionSeq, endSeq: plan.surfaceEnd as SessionSeq },
      sourceEventSeqs: [...plan.shadowedSeqs] as SessionSeq[],
    })
    const after = session.surface.nodes.map(seq => surfaceText(session, seq)).join('\n')
    expect(after).not.toContain('question 1')
    expect(after).not.toContain('answer 1')
    expect(after).not.toContain('question 2')
    expect(after).not.toContain('answer 2')

    // The marker's seq is what the history entry stores as `markerSeq`; with the
    // target seq it identifies the cut the client releases on undo.
    expect(typeof marker.seq).toBe('number')
    expect(marker.seq).toBeGreaterThan(plan.targetSeq)
  })

  it('keeps a journal for a conversation-only restore and undoes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dialog-'))
    try {
      const store = new SnapshotStore(root)
      const dialog = [
        { role: 'user' as const, content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant' as const, content: [{ type: 'text', text: 'a' }] },
      ]
      const outcome = await store.restoreAfter(
        'session-a',
        1,
        async () => undefined,
        undefined,
        { opId: 'op-dialog', dialog },
      )
      expect(outcome.failed).toEqual([])
      expect(outcome.restored).toEqual([])

      const journal = await store.readRestoreJournal('session-a', 'op-dialog')
      expect(journal?.state).toBe('completed')
      expect(journal?.dialog).toHaveLength(2)

      await store.undoRestore('session-a', 'op-dialog', async () => undefined)
      const undone = await store.readRestoreJournal('session-a', 'op-dialog')
      expect(undone?.state).toBe('rolled-back')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
