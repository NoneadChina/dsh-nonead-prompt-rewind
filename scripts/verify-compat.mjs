#!/usr/bin/env node
/**
 * Verifies the plugin against a matrix of DSH core releases.
 *
 * The plugin declares `engines.dsh` as a range, so a release line can only be
 * claimed if it actually typechecks and passes the suite. This script pins
 * every `@deepseek-ai/dsh-*` dev dependency to one version at a time, installs
 * it, and runs the three typecheck configs plus vitest. The repository's
 * `package.json` is restored and the baseline install replayed on the way out,
 * including after a failure, so a run never leaves a mixed dependency tree.
 *
 * Usage: npm run verify:compat [-- version ...]
 *   npm run verify:compat                  # the default matrix
 *   npm run verify:compat -- 0.2.3-alpha.2 # a single release
 *
 * A version whose packages cannot be installed (a release that never shipped
 * every package the plugin imports) is reported as `unavailable`, not as a
 * pass: that is exactly how the 0.2.0 line disappears from the matrix.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgPath = join(root, 'package.json')
const original = readFileSync(pkgPath, 'utf8')
const baseline = JSON.parse(original).devDependencies ?? {}
const CORE_PREFIX = '@deepseek-ai/dsh-'
const coreNames = Object.keys(baseline).filter((name) => name.startsWith(CORE_PREFIX))
const DEFAULT_MATRIX = ['0.2.1-rc.5', '0.2.2-rc.5', '0.2.3-alpha.2']
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/

const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'))
for (const version of requested) {
  if (!VERSION.test(version)) {
    console.error(`verify-compat: refusing an unexpected version string: ${version}`)
    process.exit(2)
  }
}
const matrix = requested.length > 0 ? requested : DEFAULT_MATRIX

const run = (command) => {
  const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { code: result.status ?? 1, output }
}

const tail = (text, lines = 24) => {
  const kept = text.trim().split(/\r?\n/).slice(-lines)
  return kept.map((line) => `    ${line}`).join('\n')
}

const pinCore = (version, keep = new Set()) => {
  const pkg = JSON.parse(original)
  for (const name of coreNames) {
    if (keep.has(name)) continue
    pkg.devDependencies[name] = version
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

/**
 * Installs the pinned tree, substituting the baseline version for any core
 * package the release never published. A missing package is a fact about that
 * release, not about the plugin's runtime contract: those packages are dev-only
 * here (the plugin imports none of them), so the rest of the line still gets a
 * real typecheck and test run. The substitution is reported with the result.
 */
const installPinned = (version) => {
  const keep = new Set()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    pinCore(version, keep)
    const install = run('npm i --no-save --no-package-lock --no-audit --no-fund')
    if (install.code === 0) return { ok: true, keep, install }
    const absent = install.output.match(/No matching version found for (@deepseek-ai\/[a-z-]+)@/i)
    if (absent === null) return { ok: false, keep, install }
    const name = absent[1]
    if (!coreNames.includes(name) || keep.has(name)) return { ok: false, keep, install }
    keep.add(name)
    console.log(`  ${name}@${version} was never published; keeping ${baseline[name]}`)
  }
  return { ok: false, keep, install: { code: 1, output: '' } }
}

const restore = () => {
  writeFileSync(pkgPath, original)
  const install = run('npm i --no-audit --no-fund')
  if (install.code !== 0) {
    console.error('verify-compat: restoring the baseline install failed; run `npm i` by hand')
    console.error(tail(install.output))
  }
}

const STEPS = [
  ['host typecheck', 'npx tsc --noEmit -p tsconfig.json'],
  ['client typecheck', 'npx tsc --noEmit -p tsconfig.client.json'],
  ['client-test typecheck', 'npx tsc --noEmit -p tsconfig.client-test.json'],
  ['vitest', 'npx vitest run --reporter=dot'],
]

const results = []
try {
  for (const version of matrix) {
    console.log(`\n=== ${version}: pinning ${coreNames.length} core packages ===`)
    const installed = installPinned(version)
    if (!installed.ok) {
      console.log('  install: FAILED')
      console.log(tail(installed.install.output))
      results.push({ version, state: 'unavailable', steps: [], absent: [...installed.keep] })
      writeFileSync(pkgPath, original)
      continue
    }
    const steps = []
    for (const [label, command] of STEPS) {
      const step = run(command)
      steps.push({ label, code: step.code })
      console.log(`  ${label}: ${step.code === 0 ? 'ok' : 'FAILED'}`)
      if (step.code !== 0) console.log(tail(step.output))
    }
    results.push({
      version,
      state: steps.every((step) => step.code === 0) ? 'pass' : 'fail',
      steps,
      absent: [...installed.keep],
    })
    writeFileSync(pkgPath, original)
  }
} finally {
  restore()
}

console.log('\ncompatibility matrix')
for (const result of results) {
  const detail = result.steps.map((step) => `${step.label}=${step.code === 0 ? 'ok' : 'fail'}`).join(' ')
  const absent = result.absent.length === 0 ? '' : `  absent: ${result.absent.join(', ')}`
  console.log(`  ${result.version.padEnd(12)} ${result.state}${detail === '' ? '' : `  (${detail})`}${absent}`)
}
const failed = results.filter((result) => result.state === 'fail')
if (failed.length > 0) {
  console.error(`\nverify-compat: ${failed.length} release(s) failed`)
  process.exit(1)
}
console.log('\nverify-compat: every installable release passed')
