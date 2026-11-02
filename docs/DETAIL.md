# Rewind

Rewind the conversation in place to any earlier user message, optionally restoring the workspace files edited after it. Everything happens in the same window: no new branch, no window switch, no leftover copy.

A rewind appends a single marker to the session log — the original events stay in the log and are never deleted or rewritten. File restore draws only from the plugin's own snapshot store, which tracks the paths write-class tools touched and keeps a before-image only when the content actually changes.

- Target: any earlier user message, chosen from the message's ↶ button or the Rewind history page.
- Scope: conversation only, or conversation plus restored workspace files.
- Undo: a rewind that moved files can be undone once from the Rewind history page; a conversation-only rewind cannot be undone, because the surface has already folded those events away.
