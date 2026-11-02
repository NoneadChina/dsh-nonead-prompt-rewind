/**
 * @vitest-environment jsdom
 *
 * Probes for the Rewind-history settings page (`settings.section`, id `rewind`).
 * The page owns three things worth pinning: it renders only the CURRENT
 * workspace's records (the face resolves the partition), it never shows a stale
 * list from a previous session, and the destructive "clear" is two-step.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX); excluded from `tsconfig.json` (host, no JSX).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// jsdom + React act: the environment must opt in so act() does not warn.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import type { ArchiveView, CapsView, HistoryEntryView, HistoryView, UndoOutcome } from '../src/client/host-rpc.ts'
import { SettingsSection, type SettingsSectionProps } from '../src/client/settings-section.tsx'

const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${String(params['key'])}`) as unknown as SettingsSectionProps['t']

const roots: Root[] = []
const containers: HTMLElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  for (const container of containers.splice(0)) container.remove()
})

/** One history entry. */
function entry(overrides: Partial<HistoryEntryView> = {}): HistoryEntryView {
  return {
    opId: overrides.opId ?? 'op-1',
    workspaceKey: 'ws-w1',
    sessionId: 's1',
    at: 1_700_000_000_000,
    targetSeq: 5,
    hadFiles: true,
    outcome: 'success',
    shadowedEvents: 3,
    messagePreview: 'hello world',
    attachments: 0,
    undoable: true,
    ...overrides,
  }
}

/** Mount the page with `face` and let the first load settle. */
async function mount(face: {
  readonly currentSessionId?: () => string | undefined
  readonly loadHistory?: (sessionId: string) => Promise<HistoryView | undefined>
  readonly clearHistory?: (sessionId: string) => Promise<number | undefined>
  readonly undoHistory?: (sessionId: string, opId: string) => Promise<UndoOutcome | undefined>
  readonly loadCaps?: (sessionId: string) => Promise<CapsView | undefined>
  readonly loadArchive?: (sessionId: string, opId: string) => Promise<ArchiveView | undefined>
}): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  const props = {
    close: () => {},
    t,
    currentSessionId: face.currentSessionId ?? (() => 's1'),
    loadHistory: face.loadHistory ?? (async () => ({ workspace: { key: 'ws-w1' }, entries: [] })),
    clearHistory: face.clearHistory ?? (async () => 0),
    undoHistory: face.undoHistory ?? (async () => ({ kind: 'ok', restored: 1, deleted: 0 })),
    loadCaps: face.loadCaps ?? (async () => ({ history: true, undo: true, fileCheckpointing: true })),
    loadArchive: face.loadArchive ?? (async () => undefined),
  } as unknown as SettingsSectionProps
  await act(async () => {
    root.render(createElement(SettingsSection, props))
  })
  // Flush the load promise chain started by the effect.
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return container
}

describe('SettingsSection (history page)', () => {
  it('renders the workspace header and the empty state', async () => {
    const container = await mount({
      loadHistory: async () => ({ workspace: { key: 'ws-w1', path: 'D:/proj' }, entries: [] }),
    })
    expect(container.textContent).toContain('settings.nav')
    // The workspace is a pill beside the title, not a "workspace: <path>" line.
    expect(container.textContent).toContain('D:/proj')
    expect(container.textContent).toContain('settings.history.empty')
  })

  it('renders one row per entry, newest first', async () => {
    const container = await mount({
      loadHistory: async () => ({
        workspace: { key: 'ws-w1' },
        entries: [
          entry({ opId: 'a', at: 1_700_000_000_000, targetSeq: 3, messagePreview: 'older' }),
          entry({ opId: 'b', at: 1_700_000_000_100, targetSeq: 7, messagePreview: 'newer' }),
        ],
      }),
    })
    const text = container.textContent ?? ''
    expect(text).toContain('@7')
    expect(text).toContain('newer')
    expect(text).toContain('@3')
    // Newest first: the newer target appears before the older one.
    expect(text.indexOf('@7')).toBeLessThan(text.indexOf('@3'))
  })

  it('marks an undone entry', async () => {
    const container = await mount({
      loadHistory: async () => ({
        workspace: { key: 'ws-w1' },
        entries: [entry({ undoneAt: 1_700_000_000_500 })],
      }),
    })
    expect(container.textContent).toContain('settings.history.undone')
  })

  it('says a conversation-only rewind is not undoable instead of leaving a silent gap', async () => {
    // File restore is the only undoable action: a rewind that only removed
    // conversation nodes has nothing to roll back and therefore no button.
    // The row must SAY that, or a missing button reads as a rendering bug.
    const container = await mount({
      loadHistory: async () => ({
        workspace: { key: 'ws-w1' },
        entries: [entry({ undoable: false, hadFiles: false })],
      }),
    })
    expect(container.textContent).toContain('settings.history.conversationOnly')
    const undoButtons = [...container.querySelectorAll('button')]
      .filter(button => button.textContent === 'settings.history.undo')
    expect(undoButtons).toHaveLength(0)
  })

  it('keeps the undo button (no conversation-only note) when files did move', async () => {
    const container = await mount({
      loadHistory: async () => ({
        workspace: { key: 'ws-w1' },
        entries: [entry({ undoable: true, hadFiles: true })],
      }),
    })
    expect(container.textContent).not.toContain('settings.history.conversationOnly')
    const undoButtons = [...container.querySelectorAll('button')]
      .filter(button => button.textContent === 'settings.history.undo')
    expect(undoButtons).toHaveLength(1)
  })

  it('opens the conversation archive inline when the entry has one', async () => {
    // The archive is the only way back to a rewind's folded dialogue, so the row
    // must offer it exactly when the entry carries a path.
    const loadArchive = vi.fn(async () => ({ path: 's1/op-1.md', text: '# archived dialogue' }))
    const container = await mount({
      loadHistory: async () => ({
        workspace: { key: 'ws-w1' },
        entries: [entry({ archivePath: 's1/op-1.md' })],
      }),
      loadArchive,
    })
    const open = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'settings.history.archive')
    expect(open).toBeDefined()
    await act(async () => { open?.click() })
    await act(async () => { await Promise.resolve() })
    expect(loadArchive).toHaveBeenCalledWith('s1', 'op-1')
    expect(container.textContent).toContain('# archived dialogue')
    // The same button now closes it.
    expect(container.textContent).toContain('settings.history.archiveHide')
  })

  it('hides the archive button when the entry has no archive', async () => {
    const container = await mount({
      loadHistory: async () => ({ workspace: { key: 'ws-w1' }, entries: [entry({ archivePath: undefined })] }),
    })
    expect(container.textContent).not.toContain('settings.history.archive')
  })

  it('reports an unavailable host RPC instead of rendering a stale list', async () => {
    const container = await mount({ loadHistory: async () => undefined })
    expect(container.textContent).toContain('settings.history.unavailable')
    expect(container.textContent).not.toContain('@5')
  })

  it('reports the no-session case without calling the RPC', async () => {
    const loadHistory = vi.fn(async () => undefined)
    const container = await mount({ currentSessionId: () => undefined, loadHistory })
    expect(container.textContent).toContain('settings.history.unavailable')
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('clears only after a second click', async () => {
    const clearHistory = vi.fn(async () => 2)
    const loadHistory = vi.fn(async () => ({ workspace: { key: 'ws-w1' }, entries: [entry()] }))
    const container = await mount({ loadHistory, clearHistory })
    const buttons = [...container.querySelectorAll('button')]
    const clear = buttons.find(button => button.textContent?.startsWith('settings.history.clear'))
    expect(clear).toBeDefined()
    await act(async () => { clear?.click() })
    // First click only arms the confirm; nothing was cleared yet.
    expect(clearHistory).not.toHaveBeenCalled()
    expect(clear?.textContent).toContain('settings.history.clearConfirm')
    await act(async () => { clear?.click() })
    expect(clearHistory).toHaveBeenCalledWith('s1')
    // The confirmed clear reloads the list (one mount load + one refresh).
    expect(loadHistory.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('offers undo only on the chain tail', async () => {
    const container = await mount({
      loadHistory: async () => ({
        workspace: { key: 'ws-w1' },
        entries: [
          entry({ opId: 'old', at: 1_700_000_000_000, targetSeq: 3 }),
          entry({ opId: 'new', at: 1_700_000_000_100, targetSeq: 7 }),
        ],
      }),
    })
    const undoButtons = [...container.querySelectorAll('button')]
      .filter(button => button.textContent === 'settings.history.undo')
    expect(undoButtons).toHaveLength(1)
    // The single undoable row is the newest one (@7), not the older @3.
    const row = undoButtons[0]?.closest('li')
    expect(row?.textContent).toContain('@7')
  })

  it('undoes only after a second click, then reloads', async () => {
    const undoHistory = vi.fn(async () => ({ kind: 'ok', restored: 1, deleted: 0 }) as const)
    const loadHistory = vi.fn(async () => ({ workspace: { key: 'ws-w1' }, entries: [entry()] }))
    const container = await mount({ loadHistory, undoHistory })
    const undo = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'settings.history.undo')
    expect(undo).toBeDefined()
    await act(async () => { undo?.click() })
    expect(undoHistory).not.toHaveBeenCalled()
    expect(undo?.textContent).toBe('settings.history.undoConfirm')
    await act(async () => { undo?.click() })
    expect(undoHistory).toHaveBeenCalledWith('s1', 'op-1')
    expect(loadHistory.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('surfaces a host refusal instead of pretending the undo worked', async () => {
    const undoHistory = vi.fn(async () => ({
      kind: 'error',
      code: 'rewind/stale-undo',
      message: 'refusing to undo: changed after the rewind: a.ts',
    }) as const)
    const loadHistory = vi.fn(async () => ({ workspace: { key: 'ws-w1' }, entries: [entry()] }))
    const container = await mount({ loadHistory, undoHistory })
    const undo = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'settings.history.undo')
    await act(async () => { undo?.click() })
    await act(async () => { undo?.click() })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('undoError.stale')
    // A refused undo must not refresh as if it had succeeded.
    expect(loadHistory).toHaveBeenCalledTimes(1)
  })

  it('names a degraded host instead of hiding the loss', async () => {
    const container = await mount({
      loadCaps: async () => ({ history: false, undo: false, fileCheckpointing: true }),
      loadHistory: async () => undefined,
    })
    expect(container.textContent).toContain('settings.caps.degraded')
  })

  it('stays quiet on a fully capable host', async () => {
    const container = await mount({})
    expect(container.textContent).not.toContain('settings.caps.degraded')
  })
})
