#!/usr/bin/env node
/**
 * Verifies the plugin against a matrix of DSH core releases.
 *
 * The plugin declares `engines.dsh` as a range, so a release can only be
 * claimed if it actually typechecks and passes the suite. This script pins
 * every `@deepseek-ai/dsh-*` dev dependency to one version at a time, installs
 * it, and runs the three typecheck configs plus vitest. The repository's
 * `package.json` is restored and the baseline install replayed on the way out,
 * including after a failure, so a run never leaves a mixed dependency tree.
 *
 * Usage: npm run verify:compat [-- version ...] [--all | --unclaimed]
 *   npm run verify:compat                  # every claimed release (the default)
 *   npm run verify:compat -- 0.2.3-alpha.2 # a single release
 *   npm run verify:compat -- --all         # claimed + the recorded unclaimed ones
 *   npm run verify:compat -- --unclaimed   # only the recorded unclaimed ones
 *
 * The default matrix is every installable release inside `engines.dsh`, not a
 * sample: the floor is `0.2.1-alpha.3` because that is the first build whose
 * token meter carries the marker-aware fold (stateVersion 6), and a rewind on
 * an earlier build would publish a smaller token figure than the user spent.
 * `0.2.1-alpha.1` and `0.2.1-alpha.2` are kept as RECORDED_UNCLAIMED so the
 * difference stays auditable instead of disappearing from the script.
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
/**
 * Every release the declared `engines.dsh` range admits, in publish order.
 *
 * The floor is `0.2.1-alpha.3`: `0.2.1-alpha.1` and `0.2.1-alpha.2` predate the
 * marker-aware token fold (`stateVersion 6`), so a rewind there publishes the
 * cut surface's smaller figure. That is a host capability the plugin cannot
 * supply from outside, which is why those two builds sit in
 * {@link RECORDED_UNCLAIMED} rather than in the declared range.
 */
const CLAIMED_MATRIX = [
  '0.2.1-alpha.3',
  '0.2.1-alpha.4',
  '0.2.1-alpha.5',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.4',
  '0.2.1-rc.5',
  '0.2.2-alpha.2',
  '0.2.2-alpha.3',
  '0.2.2-rc.1',
  '0.2.2-rc.2',
  '0.2.2-rc.3',
  '0.2.2-rc.4',
  '0.2.2-rc.5',
  '0.2.3-alpha.1',
  '0.2.3-alpha.2',
]

/**
 * Installable releases outside the declared range, kept so the boundary stays
 * auditable: each one installs, typechecks and runs, and fails exactly the
 * token-meter probe (compat-gaps G4). A non-zero exit here is expected; the
 * flag exists so the difference is re-measured instead of assumed.
 */
const RECORDED_UNCLAIMED = ['0.2.1-alpha.1', '0.2.1-alpha.2']

const VERSION = /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/
const flags = new Set(process.argv.slice(2).filter((argument) => argument.startsWith('-')))
const unknownFlags = [...flags].filter((flag) => flag !== '--all' && flag !== '--unclaimed')
if (unknownFlags.length > 0) {
  console.error(`verify-compat: unknown flag(s): ${unknownFlags.join(', ')}`)
  process.exit(2)
}

const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'))
for (const version of requested) {
  if (!VERSION.test(version)) {
    console.error(`verify-compat: refusing an unexpected version string: ${version}`)
    process.exit(2)
  }
}
const matrix = requested.length > 0
  ? requested
  : flags.has('--unclaimed')
    ? RECORDED_UNCLAIMED
    : flags.has('--all')
      ? [...CLAIMED_MATRIX, ...RECORDED_UNCLAIMED]
      : CLAIMED_MATRIX

/**
 * A recorded-unclaimed build is reported but never turns the run red: its
 * failure is the finding that keeps it out of the range. An explicitly
 * requested version outside both lists is treated as a claim under test, so a
 * future line is verified strictly from the moment it is named.
 */
const unclaimed = new Set(RECORDED_UNCLAIMED)
const claimOf = (version) => (unclaimed.has(version) ? 'unclaimed' : 'claimed')

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
      results.push({ version, claim: claimOf(version), state: 'unavailable', steps: [], absent: [...installed.keep] })
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
      claim: claimOf(version),
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
  const tag = result.claim === 'unclaimed' ? ' (recorded unclaimed)' : ''
  console.log(`  ${result.version.padEnd(14)} ${result.state}${tag}${detail === '' ? '' : `  (${detail})`}${absent}`)
}

const failed = results.filter((result) => result.claim === 'claimed' && result.state === 'fail')
const unavailable = results.filter((result) => result.claim === 'claimed' && result.state === 'unavailable')
const unclaimedFailed = results.filter((result) => result.claim === 'unclaimed' && result.state !== 'pass')
const unclaimedPassed = results.filter((result) => result.claim === 'unclaimed' && result.state === 'pass')

if (unclaimedPassed.length > 0) {
  const names = unclaimedPassed.map((result) => result.version).join(', ')
  console.error(`\nverify-compat: ${names} now pass; move them into CLAIMED_MATRIX and widen engines.dsh`)
}
if (failed.length > 0) {
  console.error(`\nverify-compat: ${failed.length} claimed release(s) failed`)
  process.exit(1)
}
if (unavailable.length > 0) {
  const names = unavailable.map((result) => result.version).join(', ')
  console.error(`\nverify-compat: ${names} could not be installed; a claimed release must be installable`)
  process.exit(1)
}
const claimedCount = results.filter((result) => result.claim === 'claimed').length
const unclaimedNote = unclaimedFailed.length === 0
  ? ''
  : ` (${unclaimedFailed.length} recorded unclaimed release(s) failed as expected)`
console.log(`\nverify-compat: all ${claimedCount} claimed release(s) passed${unclaimedNote}`)
