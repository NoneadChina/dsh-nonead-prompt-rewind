/**
 * Every write path the plugin owns must leave a log the harness can reopen.
 *
 * The host's stored-log validator lives in the gateway bundle, not in
 * `@deepseek-ai/dsh-session`, so this suite mirrors its load-time rules:
 * contiguous seqs and turn/step numbers, `assistant/message` (and tool events)
 * inside an open step, surface `replace` ranges that sit on the surface with a
 * flat `sourceEventSeqs` covering every shadowed node, and no turn crossing an
 * open compaction. These are exactly the rules the two field-corrupted
 * sessions tripped (`turn/start does not open the expected turn`,
 * `replacement sourceEventSeqs omit a shadowed surface node`).
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { collectDialog, replayDialog } from '../src/index.ts'
import { flattenShadowedSeqs } from '../src/archive.ts'
import { planRewind, REWIND_MARKER_SOURCE } from '../src/rewind.ts'
import { appendTurn } from './helpers.ts'

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
const STEP_REQUIRED = new Set(['assistant/message', 'tool/call', 'tool/result'])

/** Mirror of the host's load validator (the subset this plugin can violate). */
function validateLog(events: readonly SessionEvent[]): void {
  let turn: number | null = null
  let step: number | null = null
  let nextTurn = 1
  let nextStep = 1
  const surface: number[] = []
  let openCompaction: number | undefined
  const stale = new Set<number>()
  const requireStep = (event: SessionEvent): void => {
    const data = event.data as { turn?: number; step?: number }
    if (turn === null || step === null || data.turn !== turn || data.step !== step) {
      throw new Error(`${event.type} does not match an open turn and step`)
    }
  }
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) throw new Error(`session event seq ${event.seq} is not contiguous; expected ${index}`)
    if (SURFACE_TYPES.has(event.type)) {
      if (STEP_REQUIRED.has(event.type)) requireStep(event)
      const op = event.surfaceOp
      if (op === undefined || op === 'append') {
        if (op === undefined) throw new Error(`${event.type} requires a surfaceOp marker`)
        surface.push(event.seq)
      } else {
        const start = surface.indexOf(op.startSeq as number)
        const end = surface.indexOf(op.endSeq as number)
        if (start < 0 || end < start) throw new Error(`${event.type} replacement range is not on the current surface`)
        const shadowed = surface.slice(start, end + 1)
        const sources = new Set<number>(Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs as number[] : [])
        if (shadowed.some(seq => !sources.has(seq))) {
          throw new Error(`${event.type} replacement sourceEventSeqs omit a shadowed surface node`)
        }
        surface.splice(start, end - start + 1, event.seq)
      }
    }
    if ((event.type === 'turn/start' || event.type === 'turn/end') && openCompaction !== undefined && !stale.has(openCompaction)) {
      throw new Error(`${event.type} crosses an open compaction`)
    }
    switch (event.type) {
      case 'turn/start': {
        const data = event.data as { turn: number }
        if (turn !== null || data.turn !== nextTurn) throw new Error('turn/start does not open the expected turn')
        turn = nextTurn
        step = null
        nextStep = 1
        break
      }
      case 'turn/end': {
        const data = event.data as { turn: number }
        if (data.turn !== turn || step !== null) throw new Error('turn/end does not match the open turn with no open step')
        turn = null
        nextTurn += 1
        break
      }
      case 'step/start': {
        const data = event.data as { turn: number; step: number }
        if (turn === null || data.turn !== turn || step !== null || data.step !== nextStep) {
          throw new Error('step/start does not open the expected step')
        }
        step = nextStep
        break
      }
      case 'step/end': {
        const data = event.data as { turn: number; step: number }
        if (data.turn !== turn || data.step !== step) throw new Error('step/end does not close the open step')
        step = null
        nextStep += 1
        break
      }
      case 'compaction/start':
        openCompaction = event.seq
        break
      case 'compaction/end':
        openCompaction = undefined
        break
      case 'session/end-seed':
        if (openCompaction !== undefined) stale.add(openCompaction)
        openCompaction = undefined
        break
      default:
        break
    }
  }
  if (turn !== null || step !== null) throw new Error('log ends with an open turn or step')
}

/** Rewind to `seq` exactly as `executeRewind` does, returning the withdrawn dialogue. */
function cut(session: Session, seq: number): ReturnType<typeof collectDialog> {
  const plan = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'seq', seq })
  const sources = flattenShadowedSeqs(plan.shadowedSeqs)
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: '(empty message)' }], source: REWIND_MARKER_SOURCE }),
    {
      surfaceOp: { op: 'replace', startSeq: plan.surfaceStart as SessionSeq, endSeq: plan.surfaceEnd as SessionSeq },
      sourceEventSeqs: sources as SessionSeq[],
    },
  )
  return collectDialog(session, sources)
}

/** The first human prompt currently on the surface (skips rewind markers). */
function firstUserOnSurface(session: Session): number {
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const source = (event.data as { source?: { kind?: string } }).source
    if (source?.kind === 'user') return seq
  }
  throw new Error('no human user message on the surface')
}

function idleAgent(lastTurn: number): { phase: { kind: 'idle'; lastTurn: number }; setPhase(next: { kind: 'idle'; lastTurn: number }): void } {
  return {
    phase: { kind: 'idle' as const, lastTurn },
    setPhase(next: { kind: 'idle'; lastTurn: number }) {
      this.phase = next
    },
  }
}

describe('log integrity across rewind and undo', () => {
  it('reloads after a cut, a replay and a second cut', () => {
    const session = Session.create(SessionId('integrity-one'))
    appendTurn(session, 1)
    appendTurn(session, 2)
    const agent = idleAgent(2)

    const dialog = cut(session, firstUserOnSurface(session))
    expect(() => validateLog(session.snapshotEvents())).not.toThrow()
    expect(replayDialog(session, dialog, agent)).toBe(4)
    expect(() => validateLog(session.snapshotEvents())).not.toThrow()

    // Rewinding the replayed turn must leave the same shape a genuine turn
    // does — the replay's turn is not special.
    cut(session, firstUserOnSurface(session))
    expect(() => validateLog(session.snapshotEvents())).not.toThrow()
  })

  it('reloads after three rewind/undo cycles', () => {
    const session = Session.create(SessionId('integrity-three'))
    appendTurn(session, 1)
    const agent = idleAgent(1)
    for (let round = 0; round < 3; round += 1) {
      const dialog = cut(session, firstUserOnSurface(session))
      expect(() => validateLog(session.snapshotEvents())).not.toThrow()
      replayDialog(session, dialog, agent)
      expect(() => validateLog(session.snapshotEvents())).not.toThrow()
    }
    // Turn numbers stay gap-free: the real turn plus one replay per round.
    const turns = session
      .snapshotEvents()
      .filter(event => event.type === 'turn/start')
      .map(event => (event.data as { turn: number }).turn)
    expect(turns).toEqual([1, 2, 3, 4])
  })

  it('the mirror rejects a turn gap (control)', () => {
    // Proves the check is real: a jump in turn numbers is rejected exactly the
    // way the field failure reported it.
    const session = Session.create(SessionId('integrity-control'))
    appendTurn(session, 1)
    session.append('turn/start', { turn: 3 })
    expect(() => validateLog(session.snapshotEvents())).toThrow('turn/start does not open the expected turn')
  })
})
