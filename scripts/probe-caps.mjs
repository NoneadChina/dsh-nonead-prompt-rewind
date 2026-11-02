#!/usr/bin/env node
/**
 * Capability probe for dsh-nonead-prompt-rewind.
 *
 * Reports which Host/Client capabilities the installed DSH line actually ships,
 * without importing any plugin runtime or touching a Session. Used by the
 * compatibility matrix (docs/DEVELOPMENT-GUIDE.zh.md §8.3) and by CI to
 * fill the 0.2.1 / 0.2.2 / 0.3.0 rows.
 *
 * Usage:
 *   node scripts/probe-caps.mjs          # human readable
 *   node scripts/probe-caps.mjs --json   # machine readable
 *
 * Exit code is always 0 unless something throws: a missing optional capability
 * is a *result*, not a failure.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const json = process.argv.includes('--json')

/** Resolve a package's own directory + manifest; undefined when absent. */
function pkgDir(name) {
  try {
    const entry = require.resolve(name)
    let dir = dirname(entry)
    for (let i = 0; i < 8; i += 1) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        const meta = JSON.parse(readFileSync(candidate, 'utf8'))
        if (meta.name === name) return { dir, meta }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* not installed in this tree */
  }
  return undefined
}

/** Concatenate the package's built JS so we can search for API markers. */
function textOf(found) {
  if (found === undefined) return ''
  const { dir, meta } = found
  const entry = meta.module ?? meta.main
  if (typeof entry !== 'string') return ''
  try {
    return readFileSync(join(dir, entry), 'utf8')
  } catch {
    return ''
  }
}

const has = (text, marker) => text.includes(marker)

const session = pkgDir('@deepseek-ai/dsh-session')
const sessionText = textOf(session)
const settingsClient = pkgDir('@deepseek-ai/dsh-client-ui-settings')
const settingsClientText = textOf(settingsClient)
const workspace = pkgDir('@deepseek-ai/dsh-workspace')
const conversation = pkgDir('@deepseek-ai/dsh-client-ui-conversation')
const conversationText = textOf(conversation)
const tools = pkgDir('@deepseek-ai/dsh-tools')
const toolsText = textOf(tools)
const connection = pkgDir('@deepseek-ai/dsh-client-connection')

const caps = {
  // Core: conversation rewind cannot work without these.
  surfaceOp: has(sessionText, 'surfaceOp') && has(sessionText, 'sourceEventSeqs'),
  // Core: preview / history / undo all ride on Connection RPC.
  rpc: connection !== undefined,
  // Degradable.
  toolsHooks: has(toolsText, 'tools/execute') || has(toolsText, 'tools/post-execute'),
  workspaceRegistry: workspace !== undefined || has(sessionText, 'workspaceRegistry'),
  settingsSection: has(settingsClientText, 'settings.section'),
  configForms: has(settingsClientText, 'configForms'),
  uiConversationViews: has(conversationText, 'views'),
}

const missing = Object.entries(caps)
  .filter(([, ok]) => !ok)
  .map(([name]) => name)

const installed = session !== undefined

const result = {
  // `null` host means the tree has no installed dependencies: every capability
  // below is *unknown*, not absent. Never let that read as "unsupported".
  host: session?.meta.version ?? null,
  installed,
  caps: installed ? caps : null,
  missing: installed ? missing : null,
  packages: {
    session: session?.meta.version ?? null,
    settingsClient: settingsClient?.meta.version ?? null,
    workspace: workspace?.meta.version ?? null,
    conversation: conversation?.meta.version ?? null,
    tools: tools?.meta.version ?? null,
    connection: connection?.meta.version ?? null,
  },
}

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} else if (!installed) {
  process.stdout.write('host: not-installed\n')
  process.stdout.write('caps: unknown (dependencies missing — run `npm ci` first)\n')
  process.stdout.write('verdict: PROBE-SKIPPED\n')
} else {
  process.stdout.write(`host: ${result.host}\n`)
  process.stdout.write(
    `caps: ${Object.entries(caps)
      .map(([k, v]) => `${k}=${v ? 'yes' : 'NO'}`)
      .join(' ')}\n`,
  )
  if (missing.length > 0) process.stdout.write(`missing: ${missing.join(', ')}\n`)
  const core = !caps.surfaceOp || !caps.rpc
  process.stdout.write(`verdict: ${core ? 'REFUSE-ENABLE (core capability missing)' : 'ok'}\n`)
}

process.exit(0)
