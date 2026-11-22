/**
 * A rewind withdraws a span of dialogue with a surface `replace`, which has no
 * inverse: the log stays append-only and the shadowed events stay shadowed.
 * These tests pin what an undo does about that:
 *
 *   - `collectDialog` keeps the withdrawn text (human prompts + assistant text,
 *     no tool traffic) so the journal can audit it;
 *   - the cut really removes both sides from the surface;
 *   - `replayDialog` republishes them as ONE new turn at the end of the log —
 *     a real `turn/start`/`step/start`/`turn/end` skeleton, because a bare
 *     `assistant/message` without a live step is never materialized and a
 *     `user/message` outside any turn lands in the session location, which is
 *     what used to scatter later answers;
 *   - the replayed turn sits far past every logged turn, so the agent's own
 *     in-memory counter (`lastTurn + 1`) can never reuse it;
 *   - a conversation-only restore still writes a journal, so the one undo can
 *     roll it back.
 */
import { describe, expect, it } from 'vitest'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '../src/snapshot.ts'
import { collectDialog, replayDialog } from '../src/index.ts'
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

/** Concatenated text of everything currently on the surface. */
function surfaceDump(session: Session): string {
  return session.surface.nodes.map(seq => surfaceText(session, seq)).join('\n')
}

describe('dialog capture and replay', () => {
  it('collects the withdrawn text and cuts both sides from the surface', () => {
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
    const after = surfaceDump(session)
    expect(after).not.toContain('question 1')
    expect(after).not.toContain('answer 1')
    expect(after).not.toContain('question 2')
    expect(after).not.toContain('answer 2')

    // The marker's seq is what the history entry stores as `markerSeq`.
    expect(typeof marker.seq).toBe('number')
    expect(marker.seq).toBeGreaterThan(plan.targetSeq)
  })

  it('replays under the log\'s next turn number so the log still validates', () => {
    const session = Session.create(SessionId('dialog-replay'))
    appendTurn(session, 1)
    appendTurn(session, 2)

    const target = session.snapshotEvents().find(event => event.type === 'user/message')!.seq
    const plan = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'seq', seq: target })
    const dialog = collectDialog(session, plan.shadowedSeqs)
    session.append('user/message', rewindMarker(), {
      surfaceOp: { op: 'replace', startSeq: plan.surfaceStart as SessionSeq, endSeq: plan.surfaceEnd as SessionSeq },
      sourceEventSeqs: [...plan.shadowedSeqs] as SessionSeq[],
    })

    const replayed = replayDialog(session, dialog)
    expect(replayed).toBe(4)

    const dump = surfaceDump(session)
    expect(dump).toContain('question 1')
    expect(dump).toContain('answer 1')
    expect(dump).toContain('question 2')
    expect(dump).toContain('answer 2')

    // The validator accepts only a gap-free 1, 2, 3, … sequence of turns, and it
    // runs on LOAD — a gap only surfaces when the session is reopened. So the
    // replay must continue the numbering, never jump past it.
    const turns = session
      .snapshotEvents()
      .filter(event => event.type === 'turn/start')
      .map(event => (event.data as { turn: number }).turn)
    expect(turns).toEqual([1, 2, 3])
    const replayTurn = turns[turns.length - 1]!

    // Every replayed message must be inside a step that was actually started,
    // or the Chat view never materializes the answer.
    const events = session.snapshotEvents()
    const steps = new Set(
      events
        .filter(event => event.type === 'step/start')
        .map(event => `${(event.data as { turn: number }).turn}:${(event.data as { step: number }).step}`),
    )
    const replayedAnswers = events.filter(
      event => event.type === 'assistant/message' && (event.data as { turn: number }).turn === replayTurn,
    )
    expect(replayedAnswers).toHaveLength(2)
    for (const answer of replayedAnswers) {
      const data = answer.data as { turn: number; step: number }
      expect(steps.has(`${data.turn}:${data.step}`)).toBe(true)
    }
  })

  it('moves the live agent\'s turn counter past the replayed turn', () => {
    const session = Session.create(SessionId('dialog-agent'))
    appendTurn(session, 1)
    appendTurn(session, 2)
    const dialog = [{ role: 'user' as const, content: [{ type: 'text', text: 'q' }] }]
    // The agent allocates `lastTurn + 1` from memory, so after the replay lands
    // on turn 3 the agent must hand out 4 — otherwise its next real turn reuses
    // the replayed number and the log no longer loads.
    const agent = {
      phase: { kind: 'idle' as const, lastTurn: 2 },
      setPhase(next: { kind: 'idle'; lastTurn: number }) {
        this.phase = next
      },
    }
    replayDialog(session, dialog, agent)
    expect(agent.phase.lastTurn).toBe(3)
  })

  it('refuses before appending when the live agent\'s counter is unreadable', () => {
    const session = Session.create(SessionId('dialog-agent-blind'))
    appendTurn(session, 1)
    appendTurn(session, 2)
    const before = session.snapshotEvents().length
    const dialog = [{ role: 'user' as const, content: [{ type: 'text', text: 'q' }] }]
    // Fail closed: a replay whose turn the agent cannot be moved past must not
    // reach the log at all, or the file half would be committed under a
    // dialogue that no longer reloads.
    expect(() => replayDialog(session, dialog, {})).toThrow()
    expect(session.snapshotEvents().length).toBe(before)
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

  it('refuses to replay inside an open compaction transaction', () => {
    const session = Session.create(SessionId('dialog-compaction'))
    appendTurn(session, 1)
    appendTurn(session, 2)
    // `/compact` opens the transaction before it writes its summary. The load
    // validator rejects a `turn/start` that crosses it, but runtime `append`
    // does not check that relation — so replaying here would commit an event
    // that only fails on the next reload. Fail before the first append.
    session.append('compaction/start', { compactionId: CompactionId('comp-open'), turn: null })
    const before = session.snapshotEvents().length
    const dialog = [{ role: 'user' as const, content: [{ type: 'text', text: 'q' }] }]
    expect(() => replayDialog(session, dialog)).toThrow()
    expect(session.snapshotEvents().length).toBe(before)
  })

  it('closes the replayed step before turn/end when a message append throws', () => {
    const session = Session.create(SessionId('dialog-throw'))
    appendTurn(session, 1)
    const dialog = [
      { role: 'user' as const, content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'a' }] },
    ]
    // Make the answer append fail mid-step. Before the fix the `finally` wrote
    // `turn/end` while the step was still open, and no reload accepts that
    // pairing ("turn/end does not match the open turn with no open step").
    const patchable = session as unknown as { append: (...args: unknown[]) => unknown }
    const original = patchable.append.bind(session)
    let injected = false
    patchable.append = (type: unknown, data: unknown, ...opts: unknown[]) => {
      if (type === 'assistant/message' && !injected) {
        injected = true
        throw new Error('injected append failure')
      }
      return original(type, data, ...opts)
    }

    expect(() => replayDialog(session, dialog)).toThrow('injected append failure')

    const events = session.snapshotEvents()
    const open: string[] = []
    for (const event of events) {
      if (event.type === 'turn/start' || event.type === 'step/start') open.push(event.type)
      if (event.type === 'step/end') expect(open.pop()).toBe('step/start')
      if (event.type === 'turn/end') expect(open.pop()).toBe('turn/start')
    }
    expect(open).toEqual([])
  })
})
