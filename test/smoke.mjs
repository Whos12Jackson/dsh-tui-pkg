/**
 * Offline smoke test — drives /pkg against a fake host, no TUI and no install.
 *
 * The regression that matters most here is the one that shipped as 0.1.x-0.1.6:
 * every flow used to go through `ctx.tuiDialogs`, which a Loader-mounted plugin
 * can never call on dsh-tui 0.11.1 (the mediated capability rejects a non-admitted
 * caller and answers "cancelled" in ~0 ms), so `/pkg list` reported 已取消 and
 * nothing else ever worked. These tests therefore run with **no usable dialog
 * seam at all** and assert that every flow still completes.
 *
 * Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, checkUpdates, ensureInBundles, filterBundles, name, inject, overrideGithubSearch, overrideUpdatesFetcher, resolveInstallSpec, semverLt } from '../lib/index.js'

// Keep the whole suite offline: the GitHub fallback's network search is
// replaced by a no-op that finds nothing (scenarios that need candidates
// inject their own search inline).
overrideGithubSearch(async () => [])
overrideUpdatesFetcher(async () => undefined)


/** The host renders a handler's text as a notification capped at 200 cells. */
const NOTIFICATION_CELLS = 200

const BUNDLES = [
  {
    name: '@deepseek-ai/dsh-base',
    version: '0.1.7-rc.2',
    description: 'the shared dsh core as a profile bundle',
    enabled: true,
    installed: false,
    optional: false,
    removable: false,
    rows: [{ rowId: 'session', moduleName: '@deepseek-ai/dsh-session' }],
    overrides: [],
  },
  {
    name: 'dsh-tui-find',
    version: '0.4.4',
    description: 'cross-session full-text search',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [{ rowId: 'dsh-tui-find', moduleName: 'dsh-tui-find' }],
    overrides: [],
  },
  {
    name: 'dsh-tui-theme',
    version: '0.7.2',
    description: 'sakura pink themes',
    enabled: false,
    installed: true,
    optional: false,
    removable: true,
    rows: [{ rowId: 'dsh-tui-theme', moduleName: 'dsh-tui-theme' }],
    overrides: [],
  },
  {
    name: '@deepseek-ai/dsh-web-app',
    version: '0.1.7-rc.2',
    description: 'the browser surface',
    enabled: false,
    installed: false,
    optional: false,
    removable: false,
    rows: [],
    overrides: [],
  },
]

const changeResult = (over = {}) => ({
  changed: true,
  application: 'restart-required',
  stage: 'install',
  target: 'dsh-tui-theme',
  ...over,
})

/** Records every call and answers from the fixture inventory. */
function fakeManager() {
  const calls = []
  return {
    calls,
    async listBundles() {
      calls.push(['listBundles'])
      return BUNDLES.map((bundle) => ({ ...bundle }))
    },
    async inspect(spec) {
      calls.push(['inspect', spec])
      if (spec === 'nope') return { status: 'refused', problem: 'not-found', reason: '404 Not Found' }
      if (spec === 'plain-pkg') return { status: 'accepted', kind: 'registry', name: 'plain-pkg', version: '1.0.0', description: 'no bundle patch here', bundle: false, registry: 'https://registry.npmjs.org/' }
      return { status: 'accepted', kind: 'registry', name: spec.split('@')[0], version: '9.9.9', description: 'a fine plugin', bundle: true, registry: 'https://registry.npmjs.org/' }
    },
    async installBundle(spec, options) {
      calls.push(['installBundle', spec, options])
      if (spec === 'boom') throw new Error('pnpm exploded')
      if (spec === 'weak') {
        return changeResult({
          target: spec,
          changed: false,
          application: 'failed',
          error: { code: 'operation-error' },
          packageResult: { output: 'Progress: resolved 1\nERR_PNPM_FETCH_404  GET https://registry.npmjs.org/weak: Not found', logPath: 'C:/tmp/install.log' },
        })
      }
      return changeResult({ target: spec, bundle: spec, application: 'applied' })
    },
    async removeBundle(target) {
      calls.push(['removeBundle', target])
      return changeResult({ stage: 'remove', target, enabled: false })
    },
    async setBundleEnabled(target, enabled) {
      calls.push(['setBundleEnabled', target, enabled])
      return changeResult({ stage: 'enable', target, enabled, application: 'applied' })
    },
  }
}

/**
 * Minimal cordis-ish context.
 *
 * `hostMode` decides how the mediated command registration behaves: 'absent'
 * (no tuiPluginHost), 'reject' (0.11.1's non-root-activation refusal) or
 * 'accept'. `dialogs` is a seam that answers "cancelled" instantly — the exact
 * behaviour of dsh-tui 0.11.1 — and must never be required by any flow.
 */
function fakeCtx({ manager, toasts, hostMode = 'absent', dialogs = 'hostile', scenesMode = 'absent' }) {
  const registered = []
  const effects = []
  const ctx = {
    registered,
    effects,
    sceneCalls: [],
    logs: [],
    logger: {
      info: (line) => ctx.logs.push(['info', line]),
      warn: (line) => ctx.logs.push(['warn', line]),
    },
    effect(callback) {
      effects.push(callback())
      return () => {}
    },
    on() {
      return () => {}
    },
    get(key) {
      if (key === 'pluginManager') return manager
      if (key === 'tuiToast') return { show: (text, options) => (toasts.push([text, options?.color]), true) }
      if (key === 'tuiDialogs' && dialogs === 'hostile') {
        return {
          async select() {
            return undefined
          },
          async confirm() {
            return false
          },
        }
      }
      if (key === 'tuiScenes' && scenesMode === 'recording') {
        return {
          register(descriptor, identity) {
            ctx.sceneCalls.push(['register', descriptor, identity])
            return () => {}
          },
          open(id) {
            ctx.sceneCalls.push(['open', id])
            return true
          },
          close() {},
        }
      }
      if (key === 'commands') {
        return {
          register(definition) {
            registered.push({ via: 'direct', definition })
            return () => {}
          },
        }
      }
      if (key === 'tuiPluginHost' && hostMode !== 'absent') {
        return {
          registerCommand(_ctx, contributionId, definition) {
            if (hostMode === 'reject') {
              const error = new Error('mediated capability requires a non-root activation context from the host composition')
              error.name = 'ComponentIdentityError'
              throw error
            }
            registered.push({ via: 'mediated', contributionId, definition })
            return () => {}
          },
        }
      }
      return undefined
    },
  }
  return ctx
}

const toasts = []
const manager = fakeManager()
const ctx = fakeCtx({ manager, toasts })

apply(ctx)
assert.equal(name, 'dsh-tui-pkg')
assert.deepEqual(inject, [], 'the plugin must not hard-inject host services')
assert.equal(ctx.registered.length, 1, 'exactly one command is registered')
assert.equal(ctx.registered[0].via, 'direct')
const definition = ctx.registered[0].definition
assert.equal(definition.name, 'pkg', 'command name matches the manifest title')
assert.equal(definition.recordInput, false, 'the command payload is not duplicated into the session log')

const invoke = (rawInput) => definition.handler({ rawInput, signal: undefined })
/** Every handler result must survive the notification bar. */
const assertShort = (result) => {
  assert.ok(result.text.length <= NOTIFICATION_CELLS, `result exceeds ${NOTIFICATION_CELLS} cells: ${result.text}`)
  assert.equal(result.text.includes('\n'), false, `result must be one line: ${result.text}`)
  return result
}

// ── registration paths ────────────────────────────────────────────────────
{
  const mediated = fakeCtx({ manager, toasts, hostMode: 'accept' })
  apply(mediated)
  assert.equal(mediated.registered[0].via, 'mediated')
  assert.equal(mediated.registered[0].contributionId, 'dsh-tui-pkg.pkg')

  const rejected = fakeCtx({ manager, toasts, hostMode: 'reject' })
  apply(rejected)
  assert.equal(rejected.registered.length, 1, 'the mediated rejection must not lose the command')
  assert.equal(rejected.registered[0].via, 'direct')
  assert.ok(rejected.logs.some(([, line]) => line.includes('direct registration')))
}

// ── the panel filter: installed-only by default, `f` toggles ──────────────
{
  assert.equal(filterBundles(BUNDLES, 'installed').length, 2, 'only the profile-installed bundles')
  assert.equal(filterBundles(BUNDLES, 'installed').every((bundle) => bundle.installed), true)
  assert.equal(filterBundles(BUNDLES, 'all').length, 4)
  assert.equal(filterBundles(BUNDLES, 'whatever').length, 4, 'unknown filter = everything')
}

// ── the panel scene: registered from apply, opened by the bare command ────
{
  const withScenes = fakeCtx({ manager, toasts, scenesMode: 'recording' })
  apply(withScenes)
  const register = withScenes.sceneCalls.find((call) => call[0] === 'register')
  assert.ok(register !== undefined, 'apply registers the panel scene')
  assert.equal(register[1].id, 'dsh-tui-pkg')
  assert.equal(typeof register[1].component, 'function')
  assert.notEqual(register[1].component, undefined)

  const bare = withScenes.registered[0].definition.handler({ rawInput: '', signal: undefined })
  const opened = await bare
  assert.equal(opened.kind, 'success')
  assert.equal(opened.text, '')
  assert.ok(withScenes.sceneCalls.some((call) => call[0] === 'open' && call[1] === 'dsh-tui-pkg'))

  // With no scene seam the bare command still falls back to the text inventory.
  const textResult = await invoke('')
  assert.match(textResult.text, /^4 项 · ● dsh-base dsh-tui-find/)

  // The panel component is host-rendered only; smoke just sanity-checks that
  // constructing it does not import anything and its factory returns a function.
  const built = register[1].component
  assert.equal(typeof built, 'function')
}

// ── the dialog seam is never required ─────────────────────────────────────
{
  // This is the 0.1.6 regression: a hostile dialog seam must not leak into any
  // flow — not as 已取消, not as an error.
  const hostile = fakeCtx({ manager, toasts, dialogs: 'hostile' })
  apply(hostile)
  const handler = hostile.registered[0].definition.handler
  for (const line of ['', ' status', ' list', ' show dsh-tui-find', ' on dsh-tui-theme', ' off dsh-tui-find', ' dsh-tui-find']) {
    const result = assertShort(await handler({ rawInput: line, signal: undefined }))
    assert.equal(result.kind, 'success', `"${line}" must not fail on a hostile dialog seam: ${result.text}`)
    assert.notEqual(result.text, '已取消')
  }
}

// ── status/list: the one-line inventory ───────────────────────────────────
{
  const result = assertShort(await invoke(' status'))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^4 项 · ● dsh-base dsh-tui-find · ○ dsh-tui-theme · 1 项未启用可用/)
  assert.match(result.text, /\/pkg <名字> 看详情/)
  assert.equal(assertShort(await invoke('')).text, result.text, 'a bare /pkg is the inventory line')
  assert.equal(assertShort(await invoke(' list')).text, result.text)
  assert.equal(assertShort(await invoke(' ls')).text, result.text)

  // A big inventory must still fit the notification cap.
  const many = fakeManager()
  many.listBundles = async () =>
    Array.from({ length: 40 }, (_, index) => ({
      name: `@scope/very-long-plugin-name-${index}`,
      version: '1.2.3',
      enabled: index % 3 === 0,
      installed: index % 2 === 0,
      optional: false,
      removable: true,
      rows: [{ rowId: `row-${index}`, moduleName: 'x' }],
      overrides: [],
    }))
  const big = fakeCtx({ manager: many, toasts })
  apply(big)
  assertShort(await big.registered[0].definition.handler({ rawInput: ' list', signal: undefined }))
}

// ── detail: one line, ending in the command that changes it ───────────────
{
  const enabled = assertShort(await invoke(' dsh-tui-find'))
  assert.match(enabled.text, /^● dsh-tui-find 0\.4\.4 — 已启用 · 1 行 · profile 依赖 · 可卸载/)
  assert.match(enabled.text, /\/pkg off dsh-tui-find/)

  const disabled = assertShort(await invoke(' dsh-tui-theme'))
  assert.match(disabled.text, /^○ dsh-tui-theme 0\.7\.2 — 已安装·未启用/)
  assert.match(disabled.text, /\/pkg on dsh-tui-theme/)

  // `show` is kept as a soft-landing alias only, so a stray `show` never turns
  // into an install spec for a package literally named "show".
  assert.equal(assertShort(await invoke(' show dsh-tui-find')).text, enabled.text)
  assert.equal(assertShort(await invoke(' show nope')).kind, 'error')
}

// ── direct form: an installed name answers, an unknown name installs ──────
{
  const known = assertShort(await invoke(' dsh-tui-find'))
  assert.match(known.text, /^● dsh-tui-find 0\.4\.4/)

  const seen = manager.calls.filter((entry) => entry[0] === 'installBundle').length
  const installed = assertShort(await invoke(' dsh-tui-theme@0.7.2'))
  assert.equal(installed.kind, 'success')
  assert.match(installed.text, /✓ 安装 · dsh-tui-theme@0\.7\.2/)
  assert.equal(manager.calls.filter((entry) => entry[0] === 'installBundle').length, seen + 1)
  assert.ok(manager.calls.some((entry) => entry[0] === 'installBundle' && entry[1] === 'dsh-tui-theme@0.7.2'))
}

// ── install takes no flags: --dry is gone ─────────────────────────────────
{
  const seen = manager.calls.filter((entry) => entry[0] === 'installBundle').length
  const dry = assertShort(await invoke(' install dsh-tui-theme@0.7.2 --dry'))
  assert.equal(dry.kind, 'error')
  assert.match(dry.text, /不支持的选项/)
  assert.equal(manager.calls.filter((entry) => entry[0] === 'installBundle').length, seen, 'nothing installs on a rejected flag')
}

// ── install failures stay short and point at the log ──────────────────────
{
  const refused = assertShort(await invoke(' install nope'))
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /注册表里找不到这个包/)

  const thrown = assertShort(await invoke(' install boom'))
  assert.equal(thrown.kind, 'error')
  assert.match(thrown.text, /pnpm exploded/)

  const failed = assertShort(await invoke(' install weak'))
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /ERR_PNPM_FETCH_404/)
  assert.match(failed.text, /install\.log/)

  assert.equal(assertShort(await invoke(' install')).kind, 'error')
}

// ── remove ────────────────────────────────────────────────────────────────
{
  const denied = assertShort(await invoke(' remove @deepseek-ai/dsh-base'))
  assert.equal(denied.kind, 'error')
  assert.match(denied.text, /不能卸载/)

  const protectedButDisabled = assertShort(await invoke(' rm @deepseek-ai/dsh-web-app'))
  assert.equal(protectedButDisabled.kind, 'error')
  assert.match(protectedButDisabled.text, /不能卸载/)

  const removed = assertShort(await invoke(' un dsh-tui-theme'))
  assert.equal(removed.kind, 'success')
  assert.match(removed.text, /✓ 卸载 · dsh-tui-theme/)
  assert.match(removed.text, /重启后彻底卸载/)

  assert.equal(assertShort(await invoke(' remove')).kind, 'error')
  assert.equal(assertShort(await invoke(' remove nope')).kind, 'error')
}

// ── /pkg web: where the mouse-driven UI lives ─────────────────────────────
{
  const hint = assertShort(await invoke(' web'))
  assert.equal(hint.kind, 'success')
  assert.match(hint.text, /web 面板未启用/)
  assert.match(hint.text, /dsh plugin --profile .+ add -w @deepseek-ai\/dsh-web-app/)

  const enabledManager = fakeManager()
  enabledManager.listBundles = async () =>
    BUNDLES.map((bundle) => (bundle.name === '@deepseek-ai/dsh-web-app' ? { ...bundle, enabled: true } : { ...bundle }))
  const enabledCtx = fakeCtx({ manager: enabledManager, toasts })
  apply(enabledCtx)
  const on = assertShort(await enabledCtx.registered[0].definition.handler({ rawInput: ' web', signal: undefined }))
  assert.match(on.text, /web 面板已启用/)
  assert.match(on.text, /浏览器/)

  const bare = fakeManager()
  bare.listBundles = async () => []
  const bareCtx = fakeCtx({ manager: bare, toasts })
  apply(bareCtx)
  assert.equal(assertShort(await bareCtx.registered[0].definition.handler({ rawInput: ' web', signal: undefined })).kind, 'error')
}

// ── enable / disable / aliases / help / unknown ───────────────────────────
{
  assert.match(assertShort(await invoke(' on dsh-tui-theme')).text, /✓ 启用 · dsh-tui-theme/)
  assert.match(assertShort(await invoke(' off dsh-tui-find')).text, /✓ 停用 · dsh-tui-find/)
  assert.match(assertShort(await invoke(' enable dsh-tui-theme')).text, /✓ 启用/)
  assert.match(assertShort(await invoke(' disable dsh-tui-find')).text, /✓ 停用/)
  assert.equal(assertShort(await invoke(' on')).kind, 'error')
  assert.match(assertShort(await invoke(' help')).text, /\/pkg/)
  assert.match(assertShort(await invoke(' what-is-this')).text, /✓ 安装|注册表|失败/, 'an unknown token is an install spec')
}

// ── missing manager service degrades with a clear message ─────────────────
{
  const bare = fakeCtx({ manager: undefined, toasts })
  apply(bare)
  const result = assertShort(await bare.registered[0].definition.handler({ rawInput: ' status', signal: undefined }))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /pluginManager/)
}

// ── boot self-test hook: the only way to observe activation headlessly ────
{
  const marker = join(tmpdir(), `dsh-tui-pkg-selftest-${process.pid}.log`)
  rmSync(marker, { force: true })
  process.env.DSH_TUI_PKG_SELFTEST = marker
  try {
    apply(fakeCtx({ manager, toasts }))
    assert.match(readFileSync(marker, 'utf8'), /registered:direct/)

    rmSync(marker, { force: true })
    apply(fakeCtx({ manager, toasts, hostMode: 'reject' }))
    const lines = readFileSync(marker, 'utf8')
    assert.match(lines, /mediated-unavailable:/)
    assert.match(lines, /registered:direct/)
  } finally {
    delete process.env.DSH_TUI_PKG_SELFTEST
    rmSync(marker, { force: true })
  }
}

// ── GitHub fallback for npm-less plugins ──────────────────────────────────
{
  // A single matching repository resolves onto a github: spec.
  overrideGithubSearch(async () => ['Easyhoov/dsh-tui-feishu'])
  const single = await resolveInstallSpec(manager, 'dsh-tui-feishu', { status: 'refused', problem: 'not-found', reason: 'not-found (registry 404)' })
  assert.equal(single.spec, 'github:Easyhoov/dsh-tui-feishu')
  assert.equal(single.via, 'github')
  assert.equal(single.name, 'dsh-tui-feishu')

  // Several candidates become an interactive choice list, not a guess.
  overrideGithubSearch(async () => ['a/dsh-tui-feishu', 'b/dsh-tui-feishu'])
  const multi = await resolveInstallSpec(manager, 'dsh-tui-feishu', { status: 'refused', problem: 'not-found', reason: 'not-found (registry 404)' })
  assert.ok(Array.isArray(multi.choices), 'ambiguous names yield choices')
  assert.deepEqual(multi.choices.map((choice) => choice.spec), ['github:a/dsh-tui-feishu', 'github:b/dsh-tui-feishu'])
  assert.equal(multi.choices[0].name, 'dsh-tui-feishu')

  // Refusals that are not plain not-found stay untouched.
  overrideGithubSearch(async () => ['x/y'])
  const other = await resolveInstallSpec(manager, 'dsh-tui-feishu', { status: 'refused', problem: 'not-a-bundle', reason: 'no dsh.bundle.patch' })
  assert.match(other.problem, /没有 dsh bundle 补丁/)
  assert.equal(other.spec, undefined)

  overrideGithubSearch(async () => [])
}

// ── bundle registration for git-hosted installs ───────────────────────────
{
  const home = join(tmpdir(), `dsh-tui-pkg-smoke-${Date.now()}`)
  const profileDir = join(home, 'profiles', 'probe')
  mkdirSync(join(profileDir, 'node_modules', 'dsh-tui-feishu'), { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  writeFileSync(
    join(profileDir, 'node_modules', 'dsh-tui-feishu', 'package.json'),
    JSON.stringify({ name: 'dsh-tui-feishu', version: '0.10.1', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
  writeFileSync(manifestPath, JSON.stringify({ dsh: { profile: { bundles: ['dsh-base', 'dsh-tui'] } } }))

  const before = process.env.DSH_HOME
  const beforeProfile = process.env.DSH_PROFILE
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'probe'
  try {
    assert.equal(ensureInBundles('dsh-tui-feishu'), 'bundled')
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).dsh.profile.bundles, ['dsh-base', 'dsh-tui', 'dsh-tui-feishu'])
    assert.equal(ensureInBundles('dsh-tui-feishu'), 'already')
    // A package without a bundle patch must not be registered.
    assert.equal(ensureInBundles('no-such-package'), 'skipped')
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    if (beforeProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = beforeProfile
    rmSync(home, { recursive: true, force: true })
  }
}

// ── new-version detection ─────────────────────────────────────────────────
{
  // Version comparison: numeric triples, prerelease ordering.
  assert.equal(semverLt('0.4.1', '0.4.2'), true)
  assert.equal(semverLt('0.4.10', '0.4.9'), false)
  assert.equal(semverLt('1.0.0', '1.0.0'), false)
  assert.equal(semverLt('0.1.7-rc.2', '0.1.7'), true, 'a prerelease is older than the stable release')
  assert.equal(semverLt('0.1.7', '0.1.7-rc.2'), false)
  assert.equal(semverLt('0.11.1', '0.2.0'), false)

  // The registry seam drives the panel hints; offline-safe with the override.
  overrideUpdatesFetcher(async (packageName) => (packageName === 'dsh-tui-find' ? '0.9.0' : undefined))
  const hints = await checkUpdates([
    { name: 'dsh-tui-find', version: '0.4.4', installed: true },
    { name: 'dsh-tui-theme', version: '0.7.2', installed: true },
    { name: '@deepseek-ai/dsh-web-app', version: '0.1.7-rc.2', installed: false },
  ])
  assert.equal(hints.get('dsh-tui-find'), '0.9.0')
  assert.equal(hints.has('dsh-tui-theme'), false)
  assert.equal(hints.has('@deepseek-ai/dsh-web-app'), false, 'installation-supplied surfaces are not flagged')
  overrideUpdatesFetcher(async () => undefined)
}

assert.ok(toasts.length > 0, 'toasts were emitted')
console.log(`✓ smoke ok — ${manager.calls.length} manager calls, ${toasts.length} toasts`)


