/**
 * Rewind archives: the folded-away conversation, written to disk at rewind time.
 *
 * WHY: a rewind is irreversible for the CONVERSATION. It appends a marker whose
 * `surfaceOp` replaces the target and everything after it, and the surface is
 * rebuilt by replaying the log through `foldSurface` — the host offers only
 * `append` and `replace`, so there is no way to unfold it again. The events stay
 * in the append-only log, but nothing in the UI can reach them.
 *
 * This module closes that gap cheaply: before the marker shadows them, render the
 * affected surface events into a markdown archive under
 * `<dsh home>/rewind-archives/<session>/<opId>.md`. The history entry carries the
 * relative path, so the settings page can offer "open the archive" later.
 *
 * Nothing here touches the session log or the surface: it only reads events the
 * caller already holds and writes one new file.
 *
 * @module dsh-nonead-prompt-rewind/archive
 */

/** Directory (under the harness home) that holds every archive. */
export const ARCHIVE_DIR = 'rewind-archives'

/** Cap on one rendered tool-result excerpt. */
const TOOL_EXCERPT_CHARS = 240

/** Cap on one rendered user/assistant message (keeps archives readable). */
const MESSAGE_CAP_CHARS = 20_000

/** The structural slice of one session event an archive reads. */
export interface ArchiveEvent {
  readonly seq: number
  readonly type: string
  readonly time?: number
  readonly data?: unknown
}

/** Everything needed to render one archive. */
export interface ArchiveInput {
  /** Owning session id (used only in the header). */
  readonly sessionId: string
  /** The history entry id this archive belongs to. */
  readonly opId: string
  /** Rewind target: the user message the conversation was returned to. */
  readonly targetSeq: number
  /** When the rewind ran (epoch ms). */
  readonly at: number
  /** The full event log the caller already holds. */
  readonly events: readonly ArchiveEvent[]
  /** Surface events the marker shadows (the plan's `shadowedSeqs`, flattened). */
  readonly shadowedSeqs: readonly (number | readonly number[])[]
}

/**
 * Flatten the shadowed list. `sourceEventSeqs` groups events that shared one
 * surface node (a user message plus the runtime-context injection right after
 * it), so the nested form must be expanded before lookup — reading only the
 * scalars silently drops every user message.
 * @param seqs - the plan's shadowed seqs, possibly grouped.
 * @returns the flat, de-duplicated seq list in original order.
 */
export function flattenShadowedSeqs(seqs: readonly (number | readonly number[])[]): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const item of seqs) {
    const add = (value: number): void => {
      if (seen.has(value)) return
      seen.add(value)
      out.push(value)
    }
    if (typeof item === 'number') add(item)
    else for (const value of item) add(value)
  }
  return out
}

/** `HH:MM:SS` in local time, or '' when the event carried no time. */
function clock(time: unknown): string {
  if (typeof time !== 'number') return ''
  const d = new Date(time)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
}

/** Read a text field defensively (log records are structurally untrusted). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Join the `text` blocks of a message-like content array. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('')
}

/** Clip one string to `max` characters with a visible marker. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断 ${text.length - max} 字）`
}

/** Counters reported by {@link renderArchiveMarkdown}. */
export interface ArchiveStats {
  readonly users: number
  readonly assistants: number
  readonly tools: number
  readonly total: number
}

/**
 * Render one archive as markdown.
 *
 * Only what a human needs is kept: human user messages, assistant text (tool
 * calls and reasoning are dropped), and a short excerpt per tool result. Injected
 * context rows (`source.kind !== 'user'`) are skipped — they are machine noise,
 * and a rewind of them is not something the user acted on.
 *
 * @param input - the session slice to render.
 * @returns the markdown body plus its counters.
 */
export function renderArchiveMarkdown(input: ArchiveInput): { readonly markdown: string; readonly stats: ArchiveStats } {
  const bySeq = new Map<number, ArchiveEvent>()
  for (const event of input.events) bySeq.set(event.seq, event)

  const md: string[] = []
  let users = 0
  let assistants = 0
  let tools = 0

  for (const seq of flattenShadowedSeqs(input.shadowedSeqs)) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const data = asRecord(event.data) ?? {}
    const time = clock(event.time)

    if (event.type === 'user/message') {
      const source = asRecord(data['source'])
      // Human prompts only: runtime-context / plugin injections ride the same
      // event type and would bury the conversation.
      if (source?.['kind'] !== 'user') continue
      const text = textOf(data['content'])
      if (text.trim() === '') continue
      users++
      md.push(`\n---\n\n## 👤 用户 · seq ${seq}${time === '' ? '' : ` · ${time}`}\n\n${clip(text, MESSAGE_CAP_CHARS)}\n`)
      continue
    }

    if (event.type === 'assistant/message') {
      const text = textOf(asRecord(data['message'])?.['content'])
      if (text.trim() === '') continue
      assistants++
      md.push(`\n## 🤖 助手 · seq ${seq}${time === '' ? '' : ` · ${time}`}\n\n${clip(text, MESSAGE_CAP_CHARS)}\n`)
      continue
    }

    if (event.type === 'tool/result') {
      tools++
      const message = asRecord(data['message'])
      const callId = typeof message?.['toolCallId'] === 'string'
        ? message['toolCallId']
        : typeof data['callId'] === 'string' ? data['callId'] : ''
      const body = JSON.stringify(message ?? data).slice(0, TOOL_EXCERPT_CHARS)
      md.push(`\n<details><summary>🔧 工具结果 · seq ${seq}${callId === '' ? '' : ` · ${callId}`}</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>\n`)
    }
  }

  const header = [
    '# 回退存档：被折叠的对话',
    '',
    `- 会话：${input.sessionId}`,
    `- 回退记录：${input.opId}`,
    `- 回退目标：seq ${input.targetSeq}`,
    `- 回退时间：${new Date(input.at).toISOString()}`,
    `- 折叠事件：${users} 条用户消息、${assistants} 条助手回复、${tools} 条工具结果`,
    '',
    '> 对话回退不可撤销（surface 由日志重放折叠而成，宿主没有 unfold 操作）。',
    '> 这份存档按原始 seq 顺序还原了被折叠的内容，来自 append-only 会话日志，未做改写。',
    '',
  ].join('\n')

  return { markdown: `${header}\n${md.join('\n')}`, stats: { users, assistants, tools, total: users + assistants + tools } }
}

/** One archive file's identity (relative to the archive root). */
export interface ArchiveRef {
  /** `<sessionId>/<opId>.md`, always POSIX-separated. */
  readonly relativePath: string
}

/**
 * Build the relative archive path for one rewind.
 * @param sessionId - owning session.
 * @param opId - history entry id; it is `${millis}-${8 hex}` by construction.
 * @returns the relative reference.
 */
export function archiveRef(sessionId: string, opId: string): ArchiveRef {
  const segment = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, '_') || '_'
  return { relativePath: `${segment(sessionId)}/${segment(opId)}.md` }
}

/**
 * Resolve an archive reference against the root, refusing anything that escapes.
 * @param root - archive root (absolute).
 * @param relativePath - a value previously produced by {@link archiveRef}.
 * @returns the absolute path, or undefined when the reference is unsafe.
 */
export function resolveArchivePath(root: string, relativePath: string): string | undefined {
  if (relativePath === '' || relativePath.includes('..') || relativePath.startsWith('/') || relativePath.startsWith('\\')) return undefined
  if (!/^[a-zA-Z0-9._/-]+$/.test(relativePath)) return undefined
  return `${root.replace(/[\\/]+$/, '')}/${relativePath}`
}
