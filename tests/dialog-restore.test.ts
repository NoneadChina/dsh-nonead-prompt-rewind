/**
 * Undo restores the dialogue, not only the files. The session log is
 * append-only and a rewind shadows nodes with a replace op that has no
 * inverse, so an undo republishes the preserved messages as NEW events.
 * These tests pin both halves:
 *
 *   - `collectDialog` keeps only human user messages and assistant text (no
 *     tool traffic), and `replayDialog` puts the prompts back on the surface
 *     after a real replace cut (the answers stay journal-only, because a
 *     fabricated turn would collide with the agent's next real turn);
 *   - a conversation-only restore still writes a journal (so it can be
 *     undone) and `readRestoreJournal` hands the dialog back to the caller.
 */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '../src/snapshot.ts'
import { collectDialog, replayDialog } from '../src/index.ts'
import { appendTurn, applyRewind, rewindMarker } from './helpers.ts'
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

describe('dialog replay', () => {
  it('collects text messages and republishes them after a real rewind cut', () => {
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

    session.append('user/message', rewindMarker(), {
      surfaceOp: { op: 'replace', startSeq: plan.surfaceStart as SessionSeq, endSeq: plan.surfaceEnd as SessionSeq },
      sourceEventSeqs: [...plan.shadowedSeqs] as SessionSeq[],
    })
    const before = session.surface.nodes.map(seq => surfaceText(session, seq)).join('\n')
    expect(before).not.toContain('question 1')
    expect(before).not.toContain('answer 1')
    expect(before).not.toContain('question 2')

    expect(replayDialog(session, dialog)).toBe(2)
    const after = session.surface.nodes.map(seq => surfaceText(session, seq)).join('\n')
    expect(after).toContain('question 1')
    expect(after).toContain('question 2')
    // The answer text stays in the journal for the history UI, but it is never
    // injected into the live transcript: a fabricated turn collides with the
    // next real turn (the agent owns that counter) and garbles the view.
    expect(after).not.toContain('answer 1')
    expect(after).not.toContain('answer 2')
    const injectedAssistant = session.snapshotEvents().filter(
      event =>
        event.type === 'assistant/message' &&
        (event.data as { message?: { source?: { provider?: unknown } } }).message?.source?.provider === 'dsh-rewind',
    )
    expect(injectedAssistant).toHaveLength(0)
    const turns = session.snapshotEvents().filter(event => event.type === 'turn/start')
    expect(turns).toHaveLength(2)
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
