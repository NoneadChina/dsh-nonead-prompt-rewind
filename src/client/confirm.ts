/**
 * The rewind confirmation dialog (plain DOM, no React).
 *
 * One stage: the target is already fixed (the clicked message, or the picked
 * candidate); the dialog shows what will be withdrawn and which files will be
 * restored/deleted, then a single confirm rewinds **the conversation and the
 * files together**. There is no mode selection — see
 * `docs/DEVELOPMENT-GUIDE.zh.md` §4.1.
 *
 * Keyboard: focus starts on Cancel (a destructive confirm must not be the
 * default Enter target); Enter activates the focused button; Cmd/Ctrl+Enter
 * confirms directly; Esc cancels. The listener runs in the document capture
 * phase so Esc is stolen from the composer while the dialog is open. There is
 * no arrow-key cycle: two buttons are reachable with Tab alone.
 *
 * @module dsh-rewind/client/confirm
 */

import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNodesOf, type ChatOf, type HiddenChat } from './hidden.ts'
import type { PreviewCall, PreviewOutcome, PreviewUncoveredPath } from './host-rpc.ts'
import type { RewindKey } from './locales.ts'
import { CLASS } from './styles.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

export interface ConfirmOptions {
  readonly session: SessionFace
  /** Durable variant: the target message seq. */
  readonly seq?: number
  /** Durable variant: the target message time. */
  readonly time?: number
  /** Pending variant: retract a pre-sent steering message (single-confirm). */
  readonly retract?: { readonly itemId: string; readonly text: string | null }
  /** Pending variant: executed after the retract confirm closes the dialog. */
  readonly onRetract?: () => void
  readonly preview: string
  /** The button that opened the dialog (outside-click ignore target). */
  readonly anchor: HTMLElement
  readonly t: Translate
  /**
   * Execute the rewind — conversation and files together. The dialog closes
   * itself first; the callback owns the command + composer-refill lifecycle
   * (see `runRewindAndFill` in portals.tsx).
   */
  readonly onConfirm?: () => void
}

/** The single live dialog element, or null when closed. */
let dialogEl: HTMLElement | null = null

/** The trigger of the live dialog, so its `aria-expanded` can be cleared. */
let dialogAnchor: HTMLElement | null = null

let disposeOutside: (() => void) | null = null

/** The session whose dialog currently holds the keyboard, or null. */
let liveSessionId: string | null = null

/** The plugin's composer focus channel; the harness's own `focusComposer` shape. */
let composerFocuser: ((sessionId: string) => void) | null = null

/**
 * Register the composer focus channel (called once by the client plugin).
 * @param focus - returns the keyboard to one session's composer, caret included.
 */
export function registerComposerFocuser(focus: (sessionId: string) => void): void {
  composerFocuser = focus
}

/** Announce that `anchor` now owns the dialog. */
function markOpen(anchor: HTMLElement): void {
  dialogAnchor = anchor
  anchor.setAttribute('aria-expanded', 'true')
}

/** Clear the trigger's expanded state; safe when nothing is open. */
function markClosed(): void {
  dialogAnchor?.setAttribute('aria-expanded', 'false')
  dialogAnchor = null
}

/** Close the current dialog, if any, handing the keyboard back to its composer. */
export function closeConfirm(): void {
  if (dialogEl !== null) {
    dialogEl.remove()
    dialogEl = null
  }
  if (disposeOutside !== null) {
    disposeOutside()
    disposeOutside = null
  }
  markClosed()
  const sessionId = liveSessionId
  liveSessionId = null
  if (sessionId !== null) {
    try {
      composerFocuser?.(sessionId)
    } catch {
      // Focus is presentation; the dialog is already gone.
    }
  }
}

/** Find the newest rewind command node matching a predicate. */
function findCommand(chat: HiddenChat | undefined, match: (node: CommandNode) => boolean): CommandNode | undefined {
  if (chat === undefined) return undefined
  let found: CommandNode | undefined
  // `nodes.values()` includes command rows the visibility layer hid, and its
  // order is store insertion order — not anchor order. Compare seq so a hidden
  // command still settles the wait instead of being missed.
  for (const node of chatNodesOf(chat)) {
    if (node.kind !== 'command') continue
    const command = node.data as CommandNode
    if (!match(command)) continue
    if (found === undefined || command.seq >= found.seq) found = command
  }
  return found
}

/**
 * Seqs of the command nodes currently matching `match`. Sample BEFORE issuing
 * a new command of the same shape so the subsequent wait can exclude them: a
 * repeated rewind of the same target must not settle on the previous command's
 * stale outcome.
 */
export function knownCommandSeqs(session: SessionFace, chatOf: ChatOf, match: (node: CommandNode) => boolean): Set<number> {
  const known = new Set<number>()
  const chat = chatOf(session)
  if (chat === undefined) return known
  for (const node of chatNodesOf(chat)) {
    if (node.kind !== 'command') continue
    const command = node.data as CommandNode
    if (match(command)) known.add(command.seq)
  }
  return known
}

/**
 * Resolve the outcome of the newest matching rewind command by watching the
 * session snapshot (command/run + command/done land as one CommandNode).
 * @returns the outcome text-bearing node, or null on timeout.
 */
export function waitForCommand(
  session: SessionFace,
  chatOf: ChatOf,
  match: (node: CommandNode) => boolean,
  timeoutMs = 8000,
  watch: (cb: () => void) => () => void,
): Promise<{ kind: 'success' | 'error'; text?: string } | null> {
  return new Promise(resolve => {
    let settled = false
    // Declared BEFORE `settle` is reachable: a store that pushes the current
    // value on subscribe would otherwise hit the temporal dead zone when
    // `settle` clears the timer / unsubscribes.
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    const settle = (value: { kind: 'success' | 'error'; text?: string } | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe?.()
      resolve(value)
    }
    const check = (): void => {
      const node = findCommand(chatOf(session), match)
      if (node?.outcome !== null && node?.outcome !== undefined) {
        settle({ kind: node.outcome.kind, text: node.outcome.text })
      }
    }
    // The chat-update signal: the session face's `subscribe` does
    // not fire when the chat snapshot changes (the chat moved to the
    // `uiConversation` view), so the waiting caller passes a watch bound to
    // that view.
    try {
      unsubscribe = watch(check)
    } catch {
      // A view that refuses the subscription leaves the timeout in charge.
    }
    timer = setTimeout(() => settle(null), timeoutMs)
    check()
  })
}

/** The registered host call; tests and the client plugin set it once. */
let previewCall: PreviewCall | null = null

/** Register the host RPC preview call (null clears it on unload). */
export function registerPreviewCall(call: PreviewCall | null): void {
  previewCall = call
}

/**
 * Resolve one target's impact through the host RPC channel.
 * @param unavailable - the localized text for "no host RPC", resolved by the
 *   caller because this module has no locale binding of its own.
 */
function previewImpact(sessionId: string, seq: number, unavailable: string): Promise<PreviewOutcome> {
  return previewCall?.(sessionId, seq) ?? Promise.resolve({ kind: 'error', text: unavailable })
}

/** Element factory helper (kept local so no framework is involved). */
function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** One mounted dialog shell: append, position, outside-click close, capture keys. */
interface DialogShell {
  /** Re-run positioning after the content re-renders. */
  readonly position: () => void
  /** Remove the dialog and its listeners (closeConfirm also does this). */
  readonly dispose: () => void
}

/** Mount the shared dialog chrome around `root`. */
function mountShell(root: HTMLElement, anchor: HTMLElement, onKeyDown: (event: KeyboardEvent) => void): DialogShell {
  const margin = 12
  const gap = 4

  /** Which side was chosen on open; later movement must not make it jump across. */
  let flippedAbove: boolean | null = null

  /** Position below the anchor (right-aligned), or above when that side fits. */
  const position = (): void => {
    if (!root.isConnected) return
    if (!anchor.isConnected) {
      if (dialogEl === root) closeConfirm()
      return
    }
    const rect = anchor.getBoundingClientRect()
    const height = root.offsetHeight
    if (flippedAbove === null) {
      flippedAbove = rect.bottom + gap + height > window.innerHeight - margin
    }
    const top = flippedAbove
      ? Math.max(margin, rect.top - gap - height)
      : Math.min(Math.max(margin, rect.bottom + gap), Math.max(margin, window.innerHeight - margin - height))
    root.style.top = `${Math.round(top)}px`
    root.style.left = `${Math.round(Math.max(margin, Math.min(rect.right, window.innerWidth - margin - root.offsetWidth)))}px`
  }

  let frame = 0
  /** Coalesce scroll/resize/observer bursts into one position write per frame. */
  const schedule = (): void => {
    if (typeof requestAnimationFrame !== 'function') {
      position()
      return
    }
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      position()
    })
  }
  /** The impact list scrolls on its own; only page movement moves the anchor. */
  const onScroll = (event: Event): void => {
    if (event.target instanceof Node && root.contains(event.target)) return
    schedule()
  }

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null
    if (root.contains(target) || anchor.contains(target)) return
    closeConfirm()
  }
  // Capture phase on document: fires before the harness's React handlers, so
  // Esc is stolen from the composer while the dialog is open.
  const deferred = setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
  }, 0)

  document.body.append(root)
  position()
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { schedule() })
  observer?.observe(root)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', schedule)

  const dispose = (): void => {
    clearTimeout(deferred)
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', schedule)
    observer?.disconnect()
    if (frame !== 0) cancelAnimationFrame(frame)
  }
  return { position, dispose }
}

/** Build the dialog keyboard handler: Esc cancels, Cmd/Ctrl+Enter confirms. */
function confirmKeyHandler(root: HTMLElement, confirm: HTMLButtonElement, onConfirm: () => void): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeConfirm()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      if (!confirm.disabled) onConfirm()
    }
  }
}

/** The fixed, non-negotiable sentence every dialog carries. */
function irreversibleNote(t: Translate): HTMLElement {
  return el('div', CLASS.popoverNote, t('confirm.irreversible'))
}

/** Paths shown per uncovered line before `+N` takes over. */
const MAX_UNCOVERED_PATHS = 8

/**
 * One line naming recorded paths that a rewind CANNOT restore because their
 * live size is over the backup cap. Without it the dialog would claim there is
 * nothing to restore while silently leaving those files alone.
 */
function uncoveredLine(paths: readonly PreviewUncoveredPath[], t: Translate): string {
  const shown = paths.slice(0, MAX_UNCOVERED_PATHS).map(file => file.path)
  const hidden = paths.length - shown.length
  return t('popover.impact.uncovered', {
    paths: `${shown.join(', ')}${hidden > 0 ? ` +${hidden}` : ''}`,
  })
}

/**
 * The impact block: restore/delete groups (at most 8 paths each, then a `+N`
 * tail), an `uncovered` warning, or the reason the preview failed. The confirm
 * button stays enabled on failure — the conversation half can still rewind.
 */
function renderImpact(impact: HTMLElement, outcome: PreviewOutcome, t: Translate): void {
  const MAX_PATHS = 8
  if (outcome === null) {
    impact.textContent = t('popover.impact.failed', { message: 'preview request timed out' })
    return
  }
  if (outcome.kind === 'error') {
    impact.textContent = t('popover.impact.failed', { message: outcome.text })
    return
  }
  const restores = outcome.files.filter(file => file.action === 'restore').map(file => file.path)
  const deletes = outcome.files.filter(file => file.action === 'delete').map(file => file.path)
  const uncovered = outcome.uncovered ?? []
  if (restores.length === 0 && deletes.length === 0) {
    // No planned action is NOT the same as "nothing to restore": a recorded
    // path over the backup cap has no restorable state at all.
    impact.textContent = uncovered.length === 0
      ? t('popover.impact.none')
      : uncoveredLine(uncovered, t)
    return
  }
  const lines = [
    ...restores.slice(0, MAX_PATHS).map(path => t('popover.impact.restore', { path })),
    ...deletes.slice(0, MAX_PATHS).map(path => t('popover.impact.delete', { path })),
  ]
  const hidden = Math.max(0, restores.length - MAX_PATHS) + Math.max(0, deletes.length - MAX_PATHS)
  impact.textContent = hidden > 0 ? `${lines.join('\n')}\n+${hidden}` : lines.join('\n')
  const notes: HTMLElement[] = []
  if (hidden > 0) notes.push(el('div', CLASS.popoverNote, t('confirm.truncated', { count: hidden })))
  if (uncovered.length > 0) notes.push(el('div', CLASS.popoverNote, uncoveredLine(uncovered, t)))
  if (outcome.backupOff) notes.push(el('div', CLASS.popoverNote, t('popover.backupDisabled')))
  for (const note of notes) impact.append(note)
}

/**
 * Open the rewind confirmation dialog. Single stage: the impact is fetched and
 * rendered in place; only [取消] and [回退] exist.
 */
export function openConfirm(opts: ConfirmOptions): void {
  closeConfirm()
  liveSessionId = opts.session.sessionId

  // Pending retract variant: one pre-sent steering message, nothing to preview.
  if (opts.retract !== undefined) {
    openRetractConfirm(opts)
    return
  }

  const { session, seq, time, preview, anchor, t, onConfirm } = opts
  if (seq === undefined || time === undefined || onConfirm === undefined) return
  const runConfirm = onConfirm
  markOpen(anchor)

  const root = el('div', CLASS.popover)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', t('popover.title'))

  const impact = el('div', CLASS.popoverImpact, t('popover.impact.loading'))
  const actions = el('div', CLASS.popoverActions)

  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.className = CLASS.popoverPrimary
  confirm.textContent = t('popover.confirm')
  confirm.addEventListener('click', () => {
    closeConfirm()
    runConfirm()
  })

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = CLASS.popoverGhost
  cancel.textContent = t('popover.cancel')
  cancel.addEventListener('click', closeConfirm)

  actions.append(cancel, confirm)
  root.replaceChildren(
    el('div', CLASS.popoverTitle, t('popover.title')),
    el('div', CLASS.popoverTarget, preview.length > 0 ? preview : t('popover.noText')),
    impact,
    irreversibleNote(t),
    actions,
  )

  const shell = mountShell(root, anchor, confirmKeyHandler(root, confirm, () => {
    closeConfirm()
    runConfirm()
  }))
  dialogEl = root
  disposeOutside = shell.dispose
  // Focus starts on Cancel: Enter must not confirm a destructive action by
  // accident, and Cmd/Ctrl+Enter remains the deliberate shortcut.
  cancel.focus()

  void previewImpact(session.sessionId, seq, t('settings.history.unavailable'))
    .then(outcome => {
      if (dialogEl !== root) return
      renderImpact(impact, outcome, t)
      shell.position()
    })
    .catch(() => {
      if (dialogEl !== root) return
      impact.textContent = t('popover.impact.failed', { message: 'unexpected error' })
      shell.position()
    })
}

/**
 * Open the pending-retract confirmation: one pre-sent steering message, no mode
 * selection and no impact preview — the message has never been processed.
 */
function openRetractConfirm(opts: ConfirmOptions): void {
  const { preview, anchor, t, retract, onRetract } = opts
  if (retract === undefined || onRetract === undefined) return
  markOpen(anchor)

  const root = el('div', CLASS.popover)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', t('popover.retract.title'))

  const actions = el('div', CLASS.popoverActions)
  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.className = CLASS.popoverPrimary
  confirm.textContent = t('popover.retract.confirm')
  confirm.addEventListener('click', () => {
    closeConfirm()
    onRetract()
  })
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = CLASS.popoverGhost
  cancel.textContent = t('popover.cancel')
  cancel.addEventListener('click', closeConfirm)
  actions.append(cancel, confirm)

  root.replaceChildren(
    el('div', CLASS.popoverTitle, t('popover.retract.title')),
    el('div', CLASS.popoverTarget, t('popover.retract.target', {
      preview: preview.length > 0 ? preview : t('popover.noText'),
    })),
    el('div', CLASS.popoverImpact, t('popover.retract.hint')),
    actions,
  )

  const shell = mountShell(root, anchor, confirmKeyHandler(root, confirm, () => {
    closeConfirm()
    onRetract()
  }))
  dialogEl = root
  disposeOutside = shell.dispose
  cancel.focus()
}
