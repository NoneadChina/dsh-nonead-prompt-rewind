/**
 * The plugin's own page inside Settings (`settings.section`, id `rewind`).
 *
 * It renders the rewind history for the CURRENT workspace only: the partition
 * is derived host-side from the active session (`WorkspaceView.sessionIds`
 * reverse lookup), so the client never passes a partition key and cannot read
 * another workspace's history.
 *
 * One entry at most is undoable: the newest not-yet-undone rewind of the active
 * session (the chain tail). Undo restores FILES only — the conversation cannot
 * come back, because `foldSurface` removed those nodes from the surface — and
 * the host refuses when a file changed after the rewind (`stale-undo`).
 *
 * Theming: every element carries a `dsh-rewind-history-*` class from
 * `./styles.ts` whose colours are dsw tokens, so light and dark follow the host
 * theme. No inline colours live here on purpose.
 *
 * @module dsh-rewind/client/settings-section
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArchiveView, CapsView, HistoryEntryView, HistoryView, UndoOutcome } from './host-rpc.ts'
import type { RewindKey } from './locales.ts'
import { SettingsCard, type SettingsCardProps } from './settings-card.tsx'

/** Copy the page reads; the canonical key set lives in `./locales.ts`. */
export type SectionLabelKey =
  | 'settings.nav'
  | 'settings.workspace'
  | 'settings.history.empty'
  | 'settings.history.refresh'
  | 'settings.history.clear'
  | 'settings.history.clearConfirm'
  | 'settings.history.export'
  | 'settings.history.copied'
  | 'settings.history.undone'
  | 'settings.history.undo'
  | 'settings.history.undoConfirm'
  | 'settings.history.conversationOnly'
  | 'settings.history.archive'
  | 'settings.history.archiveHide'
  | 'settings.history.archiveFailed'
  | 'settings.history.count'
  | 'settings.history.files'
  | 'settings.history.archiveTitle'
  | 'settings.history.unavailable'
  | 'settings.caps.degraded'
  | 'history.outcome.ok'
  | 'history.outcome.partial'
  | 'history.outcome.failed'

/**
 * Host undo codes → the page's own copy (§6.3). An unknown code still shows the
 * generic line plus the raw code, so a host that grew a new refusal is
 * diagnosable instead of silently blank.
 */
const UNDO_ERROR_KEYS: Readonly<Record<string, RewindKey>> = {
  'rewind/already-undone': 'undoError.alreadyUndone',
  'rewind/not-undoable': 'undoError.notUndoable',
  'rewind/undo-not-top': 'undoError.notTop',
  'rewind/stale-undo': 'undoError.stale',
  'rewind/undo-cross-workspace': 'undoError.crossWorkspace',
  'rewind/undo-other-session': 'undoError.wrongSession',
}

/** One badge label per forced outcome. */
const OUTCOME_KEYS: Readonly<Record<HistoryEntryView['outcome'], RewindKey>> = {
  success: 'history.outcome.ok',
  partial: 'history.outcome.partial',
  failed: 'history.outcome.failed',
}

/** What the slot registration injects into the page. */
export interface SettingsSectionFace {
  /** The active session's id, or undefined when the window has none. */
  readonly currentSessionId: () => string | undefined
  /** Read the current workspace's history over the host RPC channel. */
  readonly loadHistory: (sessionId: string) => Promise<HistoryView | undefined>
  /** Clear the current workspace's history; returns how many were removed. */
  readonly clearHistory: (sessionId: string) => Promise<number | undefined>
  /** Undo one completed rewind (chain tail only, once per entry). */
  readonly undoHistory: (sessionId: string, opId: string) => Promise<UndoOutcome | undefined>
  /** Read one rewind's conversation archive (the folded-away dialogue). */
  readonly loadArchive: (sessionId: string, opId: string) => Promise<ArchiveView | undefined>
  /** The host's capability report, so the page can name what is missing. */
  readonly loadCaps: (sessionId: string) => Promise<CapsView | undefined>
}

/** Props the settings shell binds for this page. */
export type SettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'rewind'>
  & InjectFace<SettingsSectionFace>
  // The configuration knobs are optional: absent when the host has no
  // `configForms` entry for this bundle, and the page then omits that block.
  & Partial<SettingsCardProps>

/** One load attempt. */
type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'no-session' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly view: HistoryView }

/** BCP-47 tag to format with: the host page language, else the browser's. */
function pageLocale(): string {
  const page = typeof document === 'undefined' ? '' : document.documentElement.lang
  if (page !== '') return page
  const nav = typeof navigator === 'undefined' ? '' : navigator.language
  return nav === '' ? 'en' : nav
}

/** A narrow relative formatter, or undefined when the runtime lacks Intl. */
function makeRelativeFormatter(): Intl.RelativeTimeFormat | undefined {
  if (typeof Intl === 'undefined' || typeof Intl.RelativeTimeFormat !== 'function') return undefined
  try {
    return new Intl.RelativeTimeFormat(pageLocale(), { numeric: 'auto', style: 'narrow' })
  } catch {
    return undefined
  }
}

/**
 * "How long ago", localized through `Intl.RelativeTimeFormat` (narrow style),
 * with a locale-time fallback when the runtime has no Intl.
 */
function relativeTime(at: number, now: number, formatter: Intl.RelativeTimeFormat | undefined): string {
  if (formatter === undefined) return new Date(at).toLocaleString()
  const seconds = Math.round((at - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return formatter.format(seconds, 'second')
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour')
  return formatter.format(Math.round(seconds / 86400), 'day')
}

/** The target cell: an unresolved target (host-side failure) shows a dash. */
function targetLabel(seq: number): string {
  return seq < 0 ? '—' : `@${seq}`
}

/** One history row: outcome badge, stamp, target, preview, file count, undo. */
function HistoryRow(props: {
  readonly entry: HistoryEntryView
  readonly t: SettingsSectionProps['t']
  readonly now: number
  readonly formatter: Intl.RelativeTimeFormat | undefined
  readonly canUndo: boolean
  readonly confirming: boolean
  readonly onUndo: (opId: string) => void
  /** Loaded archive markdown for THIS row, when its viewer is open. */
  readonly archiveText: string | undefined
  readonly onArchive: (opId: string) => void
}): React.ReactNode {
  const { entry, t, now, formatter, canUndo, confirming, onUndo, archiveText, onArchive } = props
  const undone = entry.undoneAt !== undefined
  const files = entry.files
  const fileCount = files === undefined ? 0 : files.restored + files.deleted
  // A rewind that only removed conversation nodes leaves nothing to roll back
  // (file restore is the only undoable action). Say so on the row, otherwise a
  // missing button reads as a rendering bug.
  const conversationOnly = entry.outcome === 'success' && !entry.undoable && !undone
  return (
    <li className={undone ? 'dsh-rewind-history-row is-undone' : 'dsh-rewind-history-row'}>
      <div className="dsh-rewind-history-rowhead">
        <span className="dsh-rewind-history-age" title={new Date(entry.at).toISOString()}>
          {relativeTime(entry.at, now, formatter)}
        </span>
        <span className="dsh-rewind-history-target">{targetLabel(entry.targetSeq)}</span>
        <span className="dsh-rewind-history-badge">{t(OUTCOME_KEYS[entry.outcome])}</span>
        {fileCount === 0 ? null : (
          <span className="dsh-rewind-history-meta">{t('settings.history.files', { count: fileCount })}</span>
        )}
        {undone
          ? (
              <span className="dsh-rewind-history-meta">
                {t('settings.history.undone', { time: relativeTime(entry.undoneAt ?? entry.at, now, formatter) })}
              </span>
            )
          : conversationOnly
            ? <span className="dsh-rewind-history-meta">{t('settings.history.conversationOnly')}</span>
            : null}
      </div>
      {entry.messagePreview === ''
        ? null
        : <div className="dsh-rewind-history-preview" title={entry.messagePreview}>{entry.messagePreview}</div>}
      {canUndo || entry.archivePath !== undefined
        ? (
            <div className="dsh-rewind-history-rowactions">
              {canUndo
                ? (
                    <button
                      type="button"
                      className={confirming ? 'dsh-rewind-history-btn dsh-rewind-history-btn--warn' : 'dsh-rewind-history-btn'}
                      onClick={() => onUndo(entry.opId)}
                    >
                      {confirming ? t('settings.history.undoConfirm') : t('settings.history.undo')}
                    </button>
                  )
                : null}
              {entry.archivePath === undefined
                ? null
                : (
                    <button
                      type="button"
                      className="dsh-rewind-history-btn dsh-rewind-history-btn--quiet"
                      onClick={() => onArchive(entry.opId)}
                    >
                      {archiveText === undefined ? t('settings.history.archive') : t('settings.history.archiveHide')}
                    </button>
                  )}
            </div>
          )
        : null}
      {archiveText === undefined
        ? null
        : (
            <div className="dsh-rewind-history-viewer">
              <div className="dsh-rewind-history-viewer-head">
                <span className="dsh-rewind-history-viewer-title">{t('settings.history.archiveTitle')}</span>
                <button
                  type="button"
                  className="dsh-rewind-history-btn dsh-rewind-history-btn--quiet"
                  onClick={() => onArchive(entry.opId)}
                >
                  {t('settings.history.archiveHide')}
                </button>
              </div>
              <pre className="dsh-rewind-history-pre">{archiveText}</pre>
            </div>
          )}
    </li>
  )
}

/**
 * The plugin's own artwork, inlined so the settings heading carries the same
 * brand mark the plugin market shows. It mirrors `assets/icon.svg` exactly: a
 * 36-unit canvas, a 28-unit tile, the two-stop blue gradient, and the closed
 * rewind glyph from `styles.ts`. The gradient id is page-scoped so two mounts
 * cannot steal each other's fill.
 * @returns the icon element.
 */
function SettingsIcon(): React.ReactNode {
  return (
    <svg className="dsh-rewind-history-logo" width="22" height="22" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <g transform="translate(18 18) scale(0.9286) translate(-18 -18)">
        <rect x="4" y="4" width="28" height="28" rx="8" fill="url(#dsh-rewind-settings-logo)" />
        <g transform="translate(4.35 3.125) scale(1.75)" stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6.2 3.4 2.8 6.8l3.4 3.4" />
          <path d="M2.8 6.8h6.4a3.4 3.4 0 0 1 0 6.8H6.6" />
        </g>
      </g>
      <defs>
        <linearGradient id="dsh-rewind-settings-logo" x1="18" y1="4" x2="18" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#69B9FF" />
          <stop offset="1" stopColor="#324DE2" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/**
 * The navigation glyph contributed to `settings.section.icon`, addressed by the
 * same `rewind` id as the page: a line that loops back on itself under a left
 * arrow. "Undo" says it in one stroke, and it stays legible at the shell's ~16px
 * nav size. A clock face was rejected on purpose — the harness already uses one
 * for the neighbouring Prompt history page, and two clock-like glyphs would
 * read as the same entry.
 *
 * Colour and the icon container stay the shell's job, so the stroke is
 * `currentColor` and the selected state needs no local styling.
 * @param props - the shell's requested square edge in px, plus the selected flag.
 * @returns the navigation icon element.
 */
export function SettingsNavIcon({ size }: Readonly<{ size: number; active: boolean }>): React.ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* The return arrow: pointing back to where the conversation started. */}
      <path d="M9.5 14.5 4 9l5.5-5.5" />
      {/* The line that loops back around, the "history" half of the mark. */}
      <path d="M4 9h11a5.5 5.5 0 0 1 0 11h-6.5" />
    </svg>
  )
}

/**
 * The Rewind history settings page.
 * @param props - locale seat, shell props, and the injected history face.
 * @returns the page content.
 */
export function SettingsSection(props: SettingsSectionProps): React.ReactNode {
  const { t, currentSessionId, loadHistory, clearHistory, undoHistory, loadArchive, loadCaps } = props
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [caps, setCaps] = useState<CapsView | undefined>(undefined)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [confirmingUndo, setConfirmingUndo] = useState<string | undefined>(undefined)
  // At most one archive viewer is open at a time: they are long documents.
  const [archive, setArchive] = useState<{ readonly opId: string; readonly text: string } | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const sessionId = currentSessionId()
  // `inject()` hands the page fresh closures on every render. Keep them in a
  // ref so the load effect keys on the SESSION only — a dependency on the
  // closures would re-fire the request on every render.
  const face = useRef({ loadHistory, clearHistory, undoHistory, loadArchive, loadCaps })
  face.current = { loadHistory, clearHistory, undoHistory, loadArchive, loadCaps }
  // The session a mutation was STARTED for. A response that lands after the
  // active session changed must not write state belonging to the new one.
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const formatter = useMemo(() => makeRelativeFormatter(), [])
  // A response that arrives after the session/partition changed must not
  // overwrite the newer state (a fast workspace switch would otherwise show the
  // previous workspace's list).
  const loadSeq = useRef(0)
  // Same guard for the archive viewer: the slowest of two clicks must not win.
  const archiveSeq = useRef(0)

  const reload = useCallback((): void => {
    const seq = (loadSeq.current += 1)
    if (sessionId === undefined) {
      setState({ kind: 'no-session' })
      return
    }
    setState({ kind: 'loading' })
    void Promise.all([face.current.loadHistory(sessionId), face.current.loadCaps(sessionId)])
      .then(([view, reported]) => {
        if (seq !== loadSeq.current) return
        // The page may have followed a session switch while the RPC ran: the
        // captured session is no longer the one this page shows.
        if (sessionRef.current !== sessionId) return
        setCaps(reported)
        setState(view === undefined ? { kind: 'unavailable' } : { kind: 'ready', view })
      })
  }, [sessionId])

  // Reload on mount and whenever the active session (and thus the partition)
  // changes; a stale list from the previous workspace is never shown.
  useEffect(() => { reload() }, [reload])
  // A switch invalidates everything the previous session's page was showing,
  // including in-flight confirmations and an open archive.
  useEffect(() => {
    archiveSeq.current += 1
    setArchive(undefined)
    setNotice(undefined)
    setConfirmingUndo(undefined)
    setConfirmingClear(false)
  }, [sessionId])

  const onClear = (): void => {
    if (sessionId === undefined) return
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    setConfirmingClear(false)
    void face.current.clearHistory(sessionId).then(cleared => {
      if (sessionRef.current !== sessionId) return
      if (cleared === undefined) {
        setNotice(t('settings.history.unavailable'))
        return
      }
      reload()
    })
  }

  const onUndo = (opId: string): void => {
    if (sessionId === undefined) return
    if (confirmingUndo !== opId) {
      setConfirmingUndo(opId)
      return
    }
    setConfirmingUndo(undefined)
    void face.current.undoHistory(sessionId, opId).then((outcome: UndoOutcome | undefined) => {
      if (sessionRef.current !== sessionId) return
      if (outcome === undefined) {
        setNotice(t('settings.history.unavailable'))
        return
      }
      if (outcome.kind === 'error') {
        const key = UNDO_ERROR_KEYS[outcome.code]
        setNotice(key === undefined ? `${t('undoError.failed')} (${outcome.code})` : t(key))
        return
      }
      setNotice(undefined)
      reload()
    })
  }

  const onArchive = (opId: string): void => {
    // Clicking the open row closes it; clicking another row switches to it.
    // Every click invalidates the previous request, so a slow response cannot
    // reopen (or replace) what the user has since chosen.
    const seq = (archiveSeq.current += 1)
    if (archive?.opId === opId) {
      setArchive(undefined)
      return
    }
    if (sessionId === undefined) return
    void face.current.loadArchive(sessionId, opId).then((view: ArchiveView | undefined) => {
      if (seq !== archiveSeq.current) return
      if (sessionRef.current !== sessionId) return
      if (view === undefined) {
        setNotice(t('settings.history.archiveFailed'))
        return
      }
      setNotice(undefined)
      setArchive({ opId, text: view.text })
    })
  }

  const onExport = (): void => {
    if (state.kind !== 'ready') return
    const body = JSON.stringify(state.view, null, 2)
    void navigator.clipboard?.writeText(body).then(
      () => { setNotice(t('settings.history.copied')) },
      () => { setNotice(t('settings.history.copyFailed')) },
    )
  }

  const now = Date.now()
  const entries = state.kind === 'ready' ? [...state.view.entries].reverse() : []
  // The chain tail is the newest not-yet-undone entry OF THE ACTIVE SESSION.
  // Only that one may be undone: an older one requires the newer file state to
  // be rolled back first (§6.3).
  const tailOpId = entries.find(entry => entry.sessionId === sessionId && entry.undoneAt === undefined)?.opId

  return (
    <div className="dsh-rewind-history">
      <div className="dsh-rewind-history-head">
        <div className="dsh-rewind-history-headrow">
          <h2 className="dsh-rewind-history-title">
            <SettingsIcon />
            {t('settings.nav')}
          </h2>
          <div className="dsh-rewind-history-actions">
            <button type="button" className="dsh-rewind-history-btn" onClick={reload}>
              {t('settings.history.refresh')}
            </button>
            <button
              type="button"
              className="dsh-rewind-history-btn"
              onClick={onExport}
              disabled={state.kind !== 'ready'}
            >
              {t('settings.history.export')}
            </button>
            <button
              type="button"
              className={confirmingClear ? 'dsh-rewind-history-btn dsh-rewind-history-btn--warn' : 'dsh-rewind-history-btn'}
              onClick={onClear}
              disabled={entries.length === 0}
            >
              {confirmingClear ? t('settings.history.clearConfirm') : t('settings.history.clear')}
            </button>
          </div>
        </div>
        {/* The workspace lives on the subtitle line: inside the title it fought
            the heading for width and wrapped "回退历史" onto two lines. */}
        <p className="dsh-rewind-history-sub">
          {state.kind === 'ready'
            ? (
                <>
                  <span className="dsh-rewind-history-badge">
                    {state.view.workspace.path ?? state.view.workspace.key}
                  </span>
                  <span>{t('settings.history.count', { count: entries.length })}</span>
                </>
              )
            : '\u00a0'}
        </p>
      </div>

      <section className="dsh-rewind-history-card">
        {notice === undefined ? null : <div className="dsh-rewind-history-hint">{notice}</div>}

        {/* A degraded host keeps working; the page states what it lost instead of
            pretending the feature is intact. */}
        {caps !== undefined && (!caps.history || !caps.undo || !caps.fileCheckpointing)
          ? <div className="dsh-rewind-history-hint">{t('settings.caps.degraded')}</div>
          : null}

        {state.kind === 'loading' ? <div className="dsh-rewind-history-hint">…</div> : null}
        {state.kind === 'no-session' || state.kind === 'unavailable'
          ? <div className="dsh-rewind-history-hint">{t('settings.history.unavailable')}</div>
          : null}
        {state.kind === 'ready' && entries.length === 0
          ? <div className="dsh-rewind-history-empty">{t('settings.history.empty')}</div>
          : null}
        {entries.length === 0 ? null : (
          <ul className="dsh-rewind-history-list">
            {entries.map(entry => (
              <HistoryRow
                key={entry.opId}
                entry={entry}
                t={t}
                now={now}
                formatter={formatter}
                canUndo={entry.undoable && entry.undoneAt === undefined && entry.opId === tailOpId}
                confirming={confirmingUndo === entry.opId}
                onUndo={onUndo}
                archiveText={archive?.opId === entry.opId ? archive.text : undefined}
                onArchive={onArchive}
              />
            ))}
          </ul>
        )}
      </section>

      {/* The configuration knobs, rendered by the SAME card the Plugins page
          uses (one form model, one draft). Omitted when the host gave no form. */}
      {(props as Partial<SettingsCardProps>).useSettingsCard === undefined
        ? null
        : (
            <div className="dsh-rewind-history-config">
              <SettingsCard {...(props as unknown as SettingsCardProps)} />
            </div>
          )}
    </div>
  )
}

/** Re-export for the registration site so it does not import the key union twice. */
export type { RewindKey }
