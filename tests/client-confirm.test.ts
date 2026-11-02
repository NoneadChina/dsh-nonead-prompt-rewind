/**
 * @vitest-environment jsdom
 *
 * Single-stage confirmation probes for `openConfirm` (V2, SiriLee/dsh-rewind#26
 * lineage). One dialog, one confirm: the impact list fills in behind a single
 * concrete action, and the two failure modes the old two-step flow could hide
 * are both covered here — a failed RPC probe must surface its reason and still
 * leave the confirm usable (the conversation half can always rewind), and a
 * snapshots-off host must say so inline.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX), excluded from `tsconfig.json` (host, no JSX) — see the neighbouring
 * `client-dom.test.ts` comment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PreviewOutcome } from '../src/client/host-rpc.ts'
import { closeConfirm, openConfirm, registerComposerFocuser, registerPreviewCall, type ConfirmOptions } from '../src/client/confirm.ts'
import { CLASS } from '../src/client/styles.ts'

/** A session face with the two reads `openConfirm` needs at this level. */
function fakeSession(): SessionFace {
  return {
    sessionId: 's1',
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({ subagent: null })),
  } as unknown as SessionFace
}

/** Translator stub: embeds params so the host-supplied reason stays readable. */
const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined
    ? key
    : `${key}:${String(params['path'] ?? params['message'] ?? params['count'] ?? params['extra'])}`) as unknown as ConfirmOptions['t']

/** Open the dialog with `preview` as its host RPC answer. */
function open(
  preview: () => Promise<PreviewOutcome> = async () => ({ kind: 'success', files: [], backupOff: false }),
): { readonly onConfirm: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn()
  registerPreviewCall(() => preview())
  openConfirm({
    session: fakeSession(),
    seq: 5,
    time: 0,
    preview: 'hello',
    anchor: document.body,
    t,
    onConfirm,
  })
  return { onConfirm }
}

/** Flush the microtask chain of the background impact probe. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** Let the dialog's deferred (0ms) capture-phase listener attachment run. */
const nextTick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** The rendered impact block text. */
function impactText(): string {
  return document.querySelector(`.${CLASS.popoverImpact}`)?.textContent ?? ''
}

/** The dialog's action buttons, in DOM order (cancel first, confirm second). */
function actionButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`.${CLASS.popoverActions} button`)]
}

afterEach(() => {
  closeConfirm()
  registerPreviewCall(null)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('openConfirm (single stage)', () => {
  it('renders exactly one confirm and one cancel, with the irreversible note', async () => {
    open()
    await settle()
    const buttons = actionButtons()
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.textContent).toBe('popover.cancel')
    expect(buttons[1]?.textContent).toBe('popover.confirm')
    // The fixed sentence every dialog carries must be present verbatim.
    expect(document.body.textContent).toContain('confirm.irreversible')
  })

  it('starts focus on cancel so Enter cannot confirm by accident', async () => {
    open()
    await settle()
    expect(document.activeElement).toBe(actionButtons()[0])
  })

  it('has no mode entries at all', async () => {
    open()
    await settle()
    expect(document.querySelector(`.${CLASS.popoverOptionHint}`)).toBeNull()
  })
})

describe('openConfirm (impact list)', () => {
  it('lists restore and delete paths', async () => {
    open(async () => ({
      kind: 'success',
      files: [{ path: '/a', action: 'restore' }, { path: '/b', action: 'delete' }],
      backupOff: false,
    }))
    await settle()
    expect(impactText()).toContain('popover.impact.restore:/a')
    expect(impactText()).toContain('popover.impact.delete:/b')
  })

  it('truncates at eight paths per group and reports the remainder', async () => {
    const files = Array.from({ length: 10 }, (_, index) => ({ path: `/f${index}`, action: 'restore' as const }))
    open(async () => ({ kind: 'success', files, backupOff: false }))
    await settle()
    expect(impactText()).toContain('/f7')
    expect(impactText()).not.toContain('/f8')
    expect(impactText()).toContain('+2')
    expect(document.body.textContent).toContain('confirm.truncated:2')
  })

  it('reports the empty case', async () => {
    open(async () => ({ kind: 'success', files: [], backupOff: false }))
    await settle()
    expect(impactText()).toBe('popover.impact.none')
  })

  it('appends the note when the host reports backupOff', async () => {
    open(async () => ({ kind: 'success', files: [{ path: '/a', action: 'restore' }], backupOff: true }))
    await settle()
    expect(document.body.textContent).toContain('popover.backupDisabled')
  })
})

describe('openConfirm (failures)', () => {
  it('shows the host reason and keeps the confirm usable', async () => {
    const { onConfirm } = open(async () => ({ kind: 'error', text: 'owned by subagent routing' }))
    await settle()
    expect(impactText()).toContain('owned by subagent routing')
    // The conversation half can still rewind: the confirm must not be disabled.
    expect(actionButtons()[1]?.disabled).toBe(false)
    actionButtons()[1]?.click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('settles a timed-out probe instead of staying on the loading line', async () => {
    open(() => new Promise(() => {}))
    await settle()
    expect(impactText()).toBe('popover.impact.loading')
    // Simulated timeout: the RPC helper resolves `null` on timeout.
    registerPreviewCall(() => Promise.resolve(null))
    closeConfirm()
    open(() => Promise.resolve(null))
    await settle()
    expect(impactText()).toContain('popover.impact.failed')
  })
})

describe('openConfirm (keyboard)', () => {
  it('closes on Escape', async () => {
    open()
    await nextTick()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(document.querySelector(`.${CLASS.popover}`)).toBeNull()
    expect(event.defaultPrevented).toBe(true)
  })

  it('confirms on Cmd/Ctrl+Enter', async () => {
    const { onConfirm } = open()
    await nextTick()
    const event = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(document.querySelector(`.${CLASS.popover}`)).toBeNull()
  })

  it('does not steal plain arrow keys from the composer', async () => {
    open()
    await nextTick()
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('closeConfirm (teardown)', () => {
  it('removes the DOM and stops intercepting keys', async () => {
    open()
    await settle()
    await nextTick()
    expect(document.querySelector(`.${CLASS.popover}`)).not.toBeNull()

    closeConfirm()
    expect(document.querySelector(`.${CLASS.popover}`)).toBeNull()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('marks the trigger expanded while open and clears it on close', () => {
    open()
    expect(document.body.getAttribute('aria-expanded')).toBe('true')
    closeConfirm()
    expect(document.body.getAttribute('aria-expanded')).toBe('false')
  })

  it('hands the keyboard back to the composer it took it from', async () => {
    const focus = vi.fn()
    registerComposerFocuser(focus)
    open()
    await settle()
    await nextTick()
    expect(focus).not.toHaveBeenCalled()
    closeConfirm()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledWith('s1')
  })

  it('is safe with nothing open and on a repeat call', () => {
    closeConfirm()
    closeConfirm()
    expect(document.querySelector(`.${CLASS.popover}`)).toBeNull()
  })
})
