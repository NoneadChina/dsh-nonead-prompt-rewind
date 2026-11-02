/**
 * Client plugin styling: one injected `<style>` tag (scoped class names),
 * following the dsh design tokens (`--dsw-*`) so the button and popover blend
 * with the conversation chrome.
 *
 * @module dsh-rewind/client/styles
 */

/** Class names shared between the injected DOM and the stylesheet. */
export const CLASS = {
  button: 'dsh-rewind-btn',
  popover: 'dsh-rewind-popover',
  popoverTitle: 'dsh-rewind-popover-title',
  popoverTarget: 'dsh-rewind-popover-target',
  popoverOption: 'dsh-rewind-popover-option',
  popoverOptionLabel: 'dsh-rewind-popover-option-label',
  popoverOptionHint: 'dsh-rewind-popover-option-hint',
  popoverImpact: 'dsh-rewind-popover-impact',
  popoverNote: 'dsh-rewind-popover-note',
  popoverActions: 'dsh-rewind-popover-actions',
  popoverPrimary: 'dsh-rewind-popover-primary',
  popoverGhost: 'dsh-rewind-popover-ghost',
  guardHint: 'dsh-rewind-guard-hint',
} as const

/**
 * The ↶ glyph, drawn inline so the bundle stays dependency-free.
 *
 * Geometry follows the same rules as the neighbouring copy icon: one 16-unit
 * grid, no fill, round caps/joins, two simple strokes.
 *
 * Shape (chosen by the user from a rendered comparison sheet): a crisp 45°
 * arrow whose tail curves back toward the left, so the stroke ends pointing the
 * same way the arrow does — that closed loop is what reads as "undo" rather
 * than "back". The previous artwork put a 4-unit arrow arm, a 4-radius hook and
 * a 1.5-unit vertical tail into the same corner; at 15px those four curves
 * smeared together. Stroke is 1.4 (not 1.25) so the glyph does not thin out
 * beside the dense outline-plus-fill copy icon.
 */
export const REWIND_ICON_SVG = [
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
  '  <path d="M6.2 3.4 2.8 6.8l3.4 3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '  <path d="M2.8 6.8h6.4a3.4 3.4 0 0 1 0 6.8H6.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  '</svg>',
].join('')

/** One injected stylesheet (scoped under `.dsh-rewind-*`). */
export const STYLE = `
.dsh-rewind-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* The neighbouring action buttons scale by this delta too. */
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border: none;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-rewind-btn svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}
@media (hover: hover) {
  .dsh-rewind-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}

.dsh-rewind-popover {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: min(300px, calc(100vw - 24px));
  padding: 16px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  isolation: isolate;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  /* Elevated surface: match the menu cards' l2 scrollbar tokens. */
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.dsh-rewind-popover-title {
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}
.dsh-rewind-popover-target {
  margin: 2px 0 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  word-break: break-all;
  /* The full message sits above the popover; two lines are enough context. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.dsh-rewind-popover-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin: 0 0 2px;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-rewind-popover-option:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* Arrow navigation moves real focus, so the focused row carries the pointer's
   fill and the browser ring is suppressed: in dark mode the UA two-tone ring
   draws its dark half against the filled row and reads as a residue edge (the
   harness Menu suppresses it the same way). */
.dsh-rewind-popover-option:focus-visible:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: none;
}
.dsh-rewind-popover-option:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-rewind-popover-option-label {
  font-weight: 500;
}
.dsh-rewind-popover-option-hint {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rewind-popover-impact {
  margin: 4px 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
}
.dsh-rewind-popover-note {
  margin-top: 6px;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rewind-popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.dsh-rewind-popover-primary,
.dsh-rewind-popover-ghost {
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  font: inherit;
  cursor: pointer;
}
.dsh-rewind-popover-primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsh-rewind-popover-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}
.dsh-rewind-popover-primary:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-rewind-popover-ghost {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rewind-popover-ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-rewind-popover-ghost:active {
  background: var(--dsw-alias-interactive-bg-active);
}

.dsh-rewind-guard-hint {
  position: fixed;
  z-index: 1000;
  max-width: min(440px, calc(100vw - 24px));
  padding: 8px 12px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  isolation: isolate;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-panel);
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  pointer-events: none;
}

/* ---- Plugin configuration form ---- */
/* Only the card's own controls: the two switch rows, their hints, and the divider. */
.dsh-rewind-settings-divider {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-rewind-settings-section {
  display: grid;
  gap: 6px;
  padding: 12px 0;
}
.dsh-rewind-settings-toggle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-rewind-settings-toggle-label {
  flex: 1;
  min-width: 0;
}
.dsh-rewind-settings-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

/* ---- Rewind history page (settings.section) ----
   Visual language mirrors the prompt-history page: one host column, a card per
   group, a bordered list with hairline separators, 12px controls and an
   h2-sized title with a workspace pill.
   EVERY token here exists in the harness theme. The previous rules used
   the --dsw-alias-border-light token, which the host NEVER defines (0
   occurrences in the installed app), so every border silently fell back to a
   grey rgba and the page read as flat and unfinished. */
.dsh-rewind-history {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0 10px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary);
}
.dsh-rewind-history-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-rewind-history-headrow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.dsh-rewind-history-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
/* The plugin mark beside the heading: flex must never shrink it. */
.dsh-rewind-history-logo {
  display: block;
  flex: none;
}
.dsh-rewind-history-badge {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.7;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.dsh-rewind-history-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rewind-history-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-rewind-history-btn {
  font: inherit;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}
.dsh-rewind-history-btn:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-rewind-history-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-border-focus, currentColor);
  outline-offset: 1px;
}
.dsh-rewind-history-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* Destructive confirm state: the second click actually clears. */
.dsh-rewind-history-btn--warn {
  color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
}
.dsh-rewind-history-btn--warn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
/* Secondary action (open the archive): quiet until hovered. */
.dsh-rewind-history-btn--quiet {
  color: var(--dsw-alias-label-secondary);
}
.dsh-rewind-history-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 14px 16px;
}
.dsh-rewind-history-section {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 2px 0 10px;
}
.dsh-rewind-history-section b {
  font-size: 14px;
  font-weight: 600;
}
.dsh-rewind-history-section span {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rewind-history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
}
.dsh-rewind-history-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-rewind-history-row:first-child {
  border-top: 0;
}
.dsh-rewind-history-row.is-undone {
  opacity: 0.6;
}
.dsh-rewind-history-rowhead {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.dsh-rewind-history-rowactions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-rewind-history-age {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-rewind-history-target {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rewind-history-preview {
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-rewind-history-meta {
  margin-left: auto;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rewind-history-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rewind-history-hint.is-error {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-rewind-history-empty {
  padding: 18px 4px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
}
/* Archive viewer: header + scrollable body + hairline separators, matching the
   prompt-history reader so the two pages read as one product. */
.dsh-rewind-history-viewer {
  margin-top: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
}
.dsh-rewind-history-viewer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-rewind-history-viewer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
}
.dsh-rewind-history-pre {
  margin: 0;
  padding: 12px;
  max-height: 320px;
  overflow: auto;
  border-top: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rewind-history-config {
  border-top: 1px solid var(--dsw-alias-border-l2);
  padding-top: 14px;
}
/* Narrow settings panes: stack the header actions instead of squeezing them. */
@media (max-width: 480px) {
  .dsh-rewind-history-headrow {
    flex-direction: column;
    align-items: stretch;
  }
}
`
