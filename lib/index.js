/**
 * dsh-tui-pkg — in-terminal plugin manager for dsh-TUI.
 *
 * Browse every bundle the profile and the dsh installation offer (version,
 * enablement, whether it contributes a patch layer), then install, remove,
 * enable or disable one — without leaving the terminal.
 *
 * How it reaches the host — every service is soft-probed with
 * `ctx.get(name, false)`, nothing is hard-injected (see cordis.patch.yml):
 *
 * - `ctx.pluginManager` — the dsh plugin manager from the dsh-base layer:
 *   `listBundles()`, `inspect(spec)`, `installBundle(spec, options)`,
 *   `removeBundle(name)`, `setBundleEnabled(name, enabled)`. It runs pnpm
 *   inside the profile directory and reconciles `dsh.profile.bundles`, so this
 *   plugin never spawns a process and never edits profile files itself.
 * - `ctx.commands` — the human-command registry `/pkg` registers into.
 *   `ctx.tuiPluginHost.registerCommand` (the mediated C-041 path) is tried
 *   first and always degrades to this direct registration on dsh-tui 0.11.1.
 *
 * Two hard host constraints shape the whole design:
 *
 * 1. **No dialogs.** `ctx.tuiDialogs` is a *mediated* capability: its runtime
 *    checks that the caller is an admitted, non-root activation and answers
 *    "cancelled" in ~0 ms otherwise. On dsh-tui 0.11.1 the loader never runs
 *    component admission (`admit()`), so a Loader-mounted community plugin can
 *    never satisfy that check — `ctx.get('tuiDialogs')` resolves, but every
 *    call is rejected before anything renders, and `ctx.tuiDialogs` property
 *    access is not even mounted on this activation. `tuiPluginHost`'s mediated
 *    command registration fails for exactly the same reason. So this plugin
 *    asks for nothing at runtime: typing an exact name or spec IS the
 *    confirmation, and `--dry` previews an install without performing it.
 *
 * 2. **A command handler's text is a notification, capped at 200 cells.** It
 *    never enters the transcript, and a handler has no `ctx.channel` to write
 *    one. Every result here is therefore a single short line.
 *
 * Seam services may also mount after this plugin's apply, so registration is
 * polled rather than injected: a cordis `inject` callback binds the service
 * proxy's caller to the injected service's fiber, and the host then rejects
 * this plugin's own calls.
 *
 * @module dsh-tui-pkg
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Slash command name (lowercase, no leading slash); matches dsh-plugin.json. */
const COMMAND_NAME = 'pkg'
/** Contribution id declared in dsh-plugin.json's `contributes.commands`. */
const CONTRIBUTION_ID = 'dsh-tui-pkg.pkg'
/** Poll budget for a late-mounting seam: 200 × 25 ms = 5 s. */
const SEAM_POLL_ATTEMPTS = 200
const SEAM_POLL_DELAY_MS = 25

export const name = 'dsh-tui-pkg'

/** No hard injects on purpose: every host service is soft-probed with `ctx.get(name, false)`. */
export const inject = []

// ── plumbing ──────────────────────────────────────────────────────────────

/** @param {string} text */
const ok = (text) => ({ kind: 'success', text })
/** @param {string} text */
const fail = (text) => ({ kind: 'error', text })

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Read a host service without binding it to this activation.
 * @param {any} ctx plugin activation context
 * @param {string} key service name
 */
function softGet(ctx, key) {
  try {
    return ctx.get(key, false)
  } catch {
    return undefined
  }
}

/**
 * Fire-and-forget toast; silent when the seam is absent or refuses.
 * @param {any} ctx
 * @param {string} text
 * @param {'success'|'warning'|'error'|undefined} [color]
 */
function toast(ctx, text, color) {
  try {
    softGet(ctx, 'tuiToast')?.show(text, color === undefined ? undefined : { color })
  } catch {
    /* a toast must never break the command */
  }
}

/**
 * Always-on boot trail — `~/.dsh-tui/dsh-tui-pkg/boot.log`.
 *
 * A slash command that is not registered gets silently swallowed by the host
 * (the session log stays seed-only), so "it does nothing" is undiagnosable from
 * the outside. One timestamped line per lifecycle step makes every boot
 * observable: apply, the registration route, and the first invocations. Nothing
 * else is ever written here, and a failing write must never break the boot.
 * @param {string} line
 */
function mark(line) {
  try {
    const dir = join(homedir(), '.dsh-tui', 'dsh-tui-pkg')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'boot.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* best effort */
  }
}

/**
 * Boot self-test hook: with `DSH_TUI_PKG_SELFTEST=<file>` set, every step that
 * decides whether `/pkg` is reachable appends one timestamped line to that
 * file. Off by default and best-effort — a headless boot has no other way to
 * observe plugin activation, and a failing write must never break the boot.
 * @param {string} line
 */
function selfTest(line) {
  const target = process.env.DSH_TUI_PKG_SELFTEST
  if (typeof target !== 'string' || target === '') return
  try {
    appendFileSync(target, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* best effort */
  }
}

/**
 * Run `use` as soon as a seam service exists, polling over the boot window.
 * @param {any} ctx plugin activation context (logger + effect scope)
 * @param {string} label seam name for log lines
 * @param {() => any} probe resolves the seam through this plugin's own context
 * @param {(seam: any) => void} use
 */
function whenMounted(ctx, label, probe, use) {
  const run = (seam) => {
    try {
      use(seam)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-tui-pkg: ${label} setup failed (${messageOf(error)})`)
    }
  }
  const first = probe()
  if (first !== undefined) {
    run(first)
    return
  }
  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    let seam
    try {
      seam = probe()
    } catch {
      seam = undefined
    }
    if (seam === undefined) {
      if (attempts >= SEAM_POLL_ATTEMPTS) {
        clearInterval(timer)
        selfTest(`seam-timeout:${label}`)
        ctx.logger?.info?.(`dsh-tui-pkg: ${label} never mounted within the boot window; /${COMMAND_NAME} stays unavailable this session`)
      }
      return
    }
    clearInterval(timer)
    run(seam)
  }, SEAM_POLL_DELAY_MS)
  ctx.effect(() => () => clearInterval(timer))
}

// ── inventory wording (every line here must survive 200 cells) ────────────

/** @param {any} bundle */
function stateOf(bundle) {
  if (bundle.error !== undefined) return `异常 ${bundle.error.code}`
  if (bundle.enabled) return '已启用'
  if (bundle.installed) return '已安装·未启用'
  if (bundle.optional) return '自带·未启用'
  return '未安装'
}

/** @param {any} bundle */
function markOf(bundle) {
  if (bundle.enabled) return '●'
  return bundle.installed ? '○' : '·'
}

/** @param {any} bundle */
function titleOf(bundle) {
  return bundle.version === undefined ? bundle.name : `${bundle.name} ${bundle.version}`
}

/** Short package name for the compact status line. */
const shortName = (name) => name.replace(/^@[^/]+\//u, '')

/**
 * One bundle in one line, ending with the exact command that changes it.
 * @param {any} bundle
 */
function showLine(bundle) {
  const flags = [bundle.installed ? 'profile 依赖' : 'dsh 自带']
  if (bundle.removable) flags.push('可卸载')
  if (bundle.readOnlyReason !== undefined) flags.push(`只读 ${bundle.readOnlyReason}`)
  const rows = Array.isArray(bundle.rows) && bundle.rows.length > 0 ? ` · ${bundle.rows.length} 行` : ''
  const next = bundle.enabled ? `/${COMMAND_NAME} off ${bundle.name}` : `/${COMMAND_NAME} on ${bundle.name}`
  return `${markOf(bundle)} ${titleOf(bundle)} — ${stateOf(bundle)}${rows} · ${flags.join(' · ')} ｜ ${next}`
}

/** One short line per handler result — the notification bar caps it at 200 cells. */
function summarize(result, verb) {
  const bits = [result.changed ? `✓ ${verb}` : '· 未变化', result.target]
  if (result.bundle !== undefined && result.bundle !== result.target) bits.push(`层 ${result.bundle}`)
  switch (result.application) {
    case 'applied':
      bits.push('已生效')
      break
    case 'restart-required':
      bits.push('重启 dsh-tui 后生效')
      break
    case 'overridden':
      bits.push('被覆盖层压住')
      break
    case 'failed':
      bits.push('应用失败')
      break
    case 'cancelled':
      bits.push('已取消，文件已还原')
      break
    default:
      break
  }
  if (result.error !== undefined) {
    bits.push(`错误 ${result.error.code}`)
    for (const item of result.error.incompatible ?? []) bits.push(`${item.name}@${item.version} 不接受 dsh ${item.runtimeVersion}`)
  }
  if (Array.isArray(result.pendingBuilds) && result.pendingBuilds.length > 0) {
    bits.push(`待授权构建脚本：${result.pendingBuilds.join('/')}`)
  }
  return bits.join(' · ')
}

/**
 * The single most useful line out of a failed pnpm run, plus where the rest is.
 * @param {any} packageResult
 */
function failureHint(packageResult) {
  if (packageResult === undefined) return ''
  const output = typeof packageResult.output === 'string' ? packageResult.output : ''
  // pnpm's build gate: installs of git-hosted plugins (or plugins whose
  // dependencies need build scripts, e.g. protobufjs) die here with a cryptic
  // ERR_PNPM_IGNORED_BUILDS. Translate it into the exact remedy.
  const blocked = /Ignored build scripts:\s*(.+)/u.exec(output)
  if (blocked !== null || /ERR_PNPM_IGNORED_BUILDS/iu.test(output)) {
    const keys = blocked === null ? '某依赖' : blocked[1].trim()
    return `pnpm 拦截了构建脚本（${keys}）：在 profile 目录的 pnpm-workspace.yaml 里，把 allowBuilds 中对应包名改为 true 后重试（dsh plugin add 的 CLI 输出会打印确切键名）`
  }
  const interesting = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('Progress:') && !line.startsWith('Packages:'))
    .pop()
  const log = packageResult.logPath === undefined ? '' : ` · 日志 ${packageResult.logPath}`
  if (interesting === undefined) return log.trim()
  return `${interesting.slice(0, 80)}${log}`
}

const PROBLEM_TEXT = {
  'invalid-spec': '不是有效的包规格',
  'already-installed': '这个包已经装过了',
  'not-found': '注册表里找不到这个包',
  'not-a-package': '目标不是一个 npm 包',
  'not-a-bundle': '这个包没有 dsh bundle 补丁，装上也不会生效',
  network: '网络不可达',
  unknown: '未知原因',
}

const SHORT_HELP = `/${COMMAND_NAME}：无参/list=清单 · <名字>=详情 · <包名>@<版本>=安装 · remove|rm <名字> · on|off <名字> · web`

/** Verbs this command owns; any other first token is a direct name or install spec. */
const SUBCOMMANDS = new Set([
  'list',
  'ls',
  'status',
  'show',
  'info',
  'install',
  'add',
  'remove',
  'rm',
  'uninstall',
  'un',
  'del',
  'enable',
  'on',
  'disable',
  'off',
  'web',
  'help',
  '?',
])

// ── the command ───────────────────────────────────────────────────────────

/**
 * @param {any} ctx plugin activation context
 */
function commandDefinition(ctx) {
  return {
    name: COMMAND_NAME,
    description: '管理插件与 bundle：查看、安装、卸载、启用、停用',
    input: { hint: '[名字|<包名>@<版本>|status|show|install|remove|on|off]' },
    recordInput: false,
    handler: (invocation) => run(ctx, invocation),
  }
}

/**
 * Register `/pkg`. The mediated C-041 path is tried first and falls back to the
 * direct commands registry, which is the one that works on dsh-tui 0.11.1.
 * @param {any} ctx
 * @param {any} commands
 */
function registerCommand(ctx, commands) {
  const definition = commandDefinition(ctx)
  const host = softGet(ctx, 'tuiPluginHost')
  if (host !== undefined) {
    try {
      const dispose = host.registerCommand(ctx, CONTRIBUTION_ID, definition)
      ctx.effect(() => dispose)
      selfTest('registered:mediated')
      mark('registered:mediated')
      return
    } catch (error) {
      selfTest(`mediated-unavailable:${messageOf(error)}`)
      mark(`mediated-unavailable:${messageOf(error)}`)
      ctx.logger?.info?.(
        `dsh-tui-pkg: mediated command registration unavailable (${messageOf(error)}); using direct registration (C-070)`,
      )
    }
  }
  try {
    const dispose = commands.register(definition)
    ctx.effect(() => dispose)
    selfTest('registered:direct')
    mark('registered:direct')
  } catch (error) {
    selfTest(`failed:${messageOf(error)}`)
    mark(`register-failed:${messageOf(error)}`)
    ctx.logger?.warn?.(`dsh-tui-pkg: /${COMMAND_NAME} registration failed (${messageOf(error)})`)
  }
}

/**
 * @param {any} ctx
 * @param {any} invocation CommandInvocation
 * @returns {Promise<{kind:'success'|'error', text:string}>}
 */
async function run(ctx, invocation) {
  try {
    const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
    mark(`invoked:${raw === '' ? '<empty>' : raw}`)
    const space = raw.search(/\s/u)
    const verb = (space < 0 ? raw : raw.slice(0, space)).toLowerCase()
    const rest = space < 0 ? '' : raw.slice(space).trim()

    const manager = softGet(ctx, 'pluginManager')
    if (manager === undefined) {
      return fail('pluginManager 服务没有挂载，无法管理插件（它由 dsh-base 层提供，重启后再试）')
    }

    // Every dispatch is awaited: without it a rejected promise would escape the
    // try/catch below and the host would see a raw error instead of these messages.
    if (verb !== '' && !SUBCOMMANDS.has(verb)) return await direct(ctx, manager, raw)
    if (verb === '') {
      // The full-screen panel owns the bare command; the text inventory is the
      // fallback when this host grants no scene (or the panel failed to open).
      const scenes = softGet(ctx, 'tuiScenes')
      if (scenes !== undefined) {
        try {
          if (scenes.open(SCENE_ID)) {
            mark('panel-opened')
            return ok('')
          }
        } catch (error) {
          mark(`panel-open-failed:${messageOf(error)}`)
        }
      }
      return await status(ctx, manager)
    }
    if (verb === 'status' || verb === 'list' || verb === 'ls') return await status(ctx, manager)
    if (verb === 'show' || verb === 'info') return await show(ctx, manager, rest)
    if (verb === 'install' || verb === 'add') return await install(ctx, manager, rest)
    if (verb === 'remove' || verb === 'rm' || verb === 'uninstall' || verb === 'un' || verb === 'del') {
      return await remove(ctx, manager, rest)
    }
    if (verb === 'enable' || verb === 'on') return await setEnabled(ctx, manager, rest, true)
    if (verb === 'disable' || verb === 'off') return await setEnabled(ctx, manager, rest, false)
    if (verb === 'web') return await webHint(ctx, manager)
    if (verb === 'help' || verb === '?') return ok(SHORT_HELP)

    return fail(`未知子命令 ${verb}。${SHORT_HELP}`)
  } catch (error) {
    return fail(`/${COMMAND_NAME} 执行失败：${messageOf(error)}`)
  }
}

/**
 * Direct form. An installed bundle name answers with its state line; anything
 * else is an install spec, so `/pkg dsh-tui-theme@0.7.2` installs in one step.
 * @param {any} ctx
 * @param {any} manager
 * @param {string} raw the whole trimmed argument text
 */
async function direct(ctx, manager, raw) {
  const target = raw.trim()
  const bundles = await manager.listBundles()
  const bundle = bundles.find((item) => item.name === target)
  if (bundle !== undefined) return ok(showLine(bundle))
  return await install(ctx, manager, target)
}

/**
 * The inventory line — "the list".
 *
 * A handler's text is a notification capped at 200 cells and never reaches the
 * transcript, so the whole list has to fit one line: every bundle's short name
 * grouped by state, trimmed when the inventory is large. The per-bundle columns
 * (row count, source, removable) are what `/pkg <名字>` prints for one bundle.
 */
async function status(ctx, manager) {
  const bundles = await manager.listBundles()
  const on = bundles.filter((bundle) => bundle.enabled)
  const off = bundles.filter((bundle) => !bundle.enabled && bundle.installed)
  const rest = bundles.filter((bundle) => !bundle.enabled && !bundle.installed)
  const chunks = [`${bundles.length} 项`]
  if (on.length > 0) chunks.push(`● ${on.map((bundle) => shortName(bundle.name)).join(' ')}`)
  if (off.length > 0) chunks.push(`○ ${off.map((bundle) => shortName(bundle.name)).join(' ')}`)
  if (rest.length > 0) chunks.push(`${rest.length} 项未启用可用`)
  const tail = ` ｜ /${COMMAND_NAME} <名字> 看详情`
  const body = chunks.join(' · ')
  const budget = 198 - tail.length
  return ok(`${body.length > budget ? `${body.slice(0, budget - 1)}…` : body}${tail}`)
}

/**
 * @param {any} ctx
 * @param {any} manager
 * @param {string} name
 */
async function show(ctx, manager, name) {
  if (name === '') return fail(`用法：/${COMMAND_NAME} show <名字>`)
  const bundles = await manager.listBundles()
  const bundle = bundles.find((item) => item.name === name)
  if (bundle === undefined) return fail(`没有这个名字的 bundle：${name}`)
  return ok(showLine(bundle))
}

/**
 * Where the mouse-driven UI lives.
 *
 * This host gives a Loader-mounted plugin no scene, dialog or toast seam (see
 * the module header), so a clickable checkbox cannot be built here. The web
 * surface is the supported place for one, and it manages the *same* profile —
 * so this command reports whether it is switched on and how to switch it on.
 *
 * @param {any} ctx
 * @param {any} manager
 */
async function webHint(ctx, manager) {
  const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== '' ? process.env.DSH_PROFILE : '<profile 名>'
  const bundles = await manager.listBundles()
  const web = bundles.find((bundle) => bundle.name === '@deepseek-ai/dsh-web-app')
  if (web === undefined) {
    return fail(`这个 profile 的清单里没有 @deepseek-ai/dsh-web-app，无法给出 web 面板入口`)
  }
  if (web.enabled) {
    return ok(`web 面板已启用 ｜ 用 dsh --profile ${profile} 启动，浏览器打开插件页即可点选开关（同一份插件树）`)
  }
  return ok(`web 面板未启用 ｜ 启用：dsh plugin --profile ${profile} add -w @deepseek-ai/dsh-web-app ｜ 之后 dsh --profile ${profile} 同时给出浏览器界面，插件页有可点开关与搜索`)
}

/**
 * Install a package. Typing the exact spec is the confirmation — this host
 * gives a Loader-mounted plugin no dialog to ask with.
 * @param {any} ctx
 * @param {any} manager
 * @param {string} spec
 */
// ── GitHub fallback for npm-less plugins ─────────────────────────────────
// Most dsh community plugins live only on GitHub. The official CLI fails a
// bare name with a raw npm 404; /pkg instead searches GitHub and installs
// the matching repository as a git spec, then registers it in the profile
// bundle list (which the harness only auto-reconciles for registry installs).

const isBareName = (spec) => /^[a-z0-9][a-z0-9._-]*$/iu.test(spec)

/** Test seam: replaces the network search so smoke tests stay offline. */
let githubSearch = async (name) => {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(name)}+in:name&sort=stars&order=desc&per_page=8`
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-tui-pkg' },
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) return []
  const payload = await response.json()
  return (payload.items ?? []).filter((item) => item.name === name).map((item) => item.full_name)
}
export function overrideGithubSearch(fn) {
  githubSearch = fn
}

/**
 * Handoff between the text command and the panel: an ambiguous bare name is
 * resolved interactively there. Set before opening the scene; the panel picks
 * it up on mount and clears it.
 * @type {null | Array<{label: string, spec: string, name: string}>}
 */
let pendingChoices = null

/**
 * Resolve an install spec. Returns `{spec, via}` (via='github' when a bare
 * name was mapped onto a repository) or `{problem}` with a user-facing line.
 * @param {any} manager
 * @param {string} spec
 * @param {any} [inspection] reuse an existing inspect() result when available
 */
export async function resolveInstallSpec(manager, spec, inspection) {
  const detail = inspection ?? (await manager.inspect(spec))
  if (detail?.status !== 'refused') return { spec }
  if (detail.problem !== 'not-found' || !isBareName(spec)) {
    return { problem: `${PROBLEM_TEXT[detail.problem] ?? detail.problem}（${detail.reason.slice(0, 80)}）` }
  }
  let repos = []
  try {
    repos = await githubSearch(spec)
  } catch {
    repos = []
  }
  if (repos.length === 1) return { spec: `github:${repos[0]}`, via: 'github', name: spec }
  if (repos.length > 1) {
    return { choices: repos.map((repo) => ({ label: `github:${repo}`, spec: `github:${repo}`, name: spec })) }
  }
  return { problem: `${PROBLEM_TEXT['not-found']}（${detail.reason.slice(0, 80)}）` }
}

/** The running profile's manifest path, per the dsh home convention. */
function profilePackagePath() {
  const home = process.env.DSH_HOME === undefined || process.env.DSH_HOME === ''
    ? join(homedir(), '.dsh')
    : process.env.DSH_HOME
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'default', 'package.json')
}

/**
 * Git-hosted installs are not auto-reconciled into `dsh.profile.bundles` by
 * the harness (verified: the CLI leaves them out). Append the package name
 * when the installed package really declares a bundle patch, so it mounts on
 * the next boot. Returns 'bundled' | 'already' | 'skipped' | 'failed'.
 */
export function ensureInBundles(packageName) {
  if (packageName === undefined || packageName === '') return 'skipped'
  const manifestPath = profilePackagePath()
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return 'failed'
  }
  const profileDir = dirname(manifestPath)
  const installedManifest = join(profileDir, 'node_modules', packageName, 'package.json')
  let declaresBundle = false
  try {
    declaresBundle = JSON.parse(readFileSync(installedManifest, 'utf8')).dsh?.bundle?.patch !== undefined
  } catch {
    declaresBundle = false
  }
  if (!declaresBundle) return 'skipped'
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return 'failed'
  if (bundles.includes(packageName)) return 'already'
  bundles.push(packageName)
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return 'bundled'
  } catch {
    return 'failed'
  }
}

async function install(ctx, manager, spec) {
  if (spec === '') return fail(`用法：/${COMMAND_NAME} <规格>（包名 / 包名@版本 / 路径 / tarball / git）`)
  if (/\s--/u.test(spec)) return fail(`不支持的选项：${spec}。用法：/${COMMAND_NAME} <规格>`)

  let inspection
  try {
    inspection = await manager.inspect(spec)
  } catch (error) {
    return fail(`检查 ${spec} 失败：${messageOf(error)}`)
  }
  const resolved = await resolveInstallSpec(manager, spec, inspection)
  if (resolved.problem !== undefined) return fail(`${spec}：${resolved.problem}`)
  if (resolved.choices !== undefined) {
    // Hand the candidates to the panel, where Enter can pick one interactively.
    pendingChoices = resolved.choices
    const scenes = softGet(ctx, 'tuiScenes')
    if (scenes !== undefined) {
      try {
        if (scenes.open(SCENE_ID)) return ok('')
      } catch {
        /* the panel stays reachable via /pkg; fall back to the plain list */
      }
    }
    return fail(`${spec}：GitHub 有多个同名仓库，选一个：${resolved.choices.map((choice) => choice.label).join('  ')}`)
  }
  if (resolved.via === 'github') mark(`github-resolved:${spec}→${resolved.spec}`)
  const target = resolved.spec

  const label = `${inspection.name ?? spec}${inspection.version === undefined ? '' : `@${inspection.version}`}`

  toast(ctx, `正在安装 ${label}…`)
  const requestId = randomUUID()
  const chunks = []
  let off
  try {
    off = ctx.on('plugin-manager/install-log', (chunk) => {
      if (chunk?.requestId === requestId && typeof chunk.text === 'string') chunks.push(chunk.text)
    })
  } catch {
    off = undefined
  }

  let result
  try {
    result = await manager.installBundle(target, { enabled: true, requestId })
  } catch (error) {
    return fail(`安装 ${label} 失败：${messageOf(error)}`)
  } finally {
    try {
      off?.()
    } catch {
      /* disposer already detached */
    }
  }

  if (result === undefined || result === null) return fail(`安装 ${label} 已结束但没有返回结果，用 /${COMMAND_NAME} status 确认状态`)
  if (typeof result.packageResult?.output !== 'string' && chunks.length > 0) {
    result = { ...result, packageResult: { ...(result.packageResult ?? {}), output: chunks.join('') } }
  }

  const short = summarize(result, '安装')
  if (result.changed) {
    toast(ctx, `已安装 ${label}`, 'success')
    if (resolved.via === 'github') {
      // The harness does not reconcile git-hosted installs into the bundle
      // list; register the layer ourselves so it mounts on the next boot.
      const bundled = ensureInBundles(resolved.name)
      mark(`bundle-registered:${resolved.name}:${bundled}`)
      if (bundled === 'bundled') return ok(`${short} · 已登记 bundle（重启生效）`)
      if (bundled === 'failed') return ok(`${short} · 未写入 bundles（profile 无法解析），重启前用 /${COMMAND_NAME} web 或手动补 dsh.profile.bundles`)
    }
    return ok(short)
  }
  const hint = failureHint(result.packageResult)
  toast(ctx, `安装失败：${label}`, 'error')
  return fail(hint === '' ? short : `${short} · ${hint}`)
}

/**
 * @param {any} ctx
 * @param {any} manager
 * @param {string} name
 */
async function remove(ctx, manager, name) {
  if (name === '') return fail(`用法：/${COMMAND_NAME} remove <名字>`)
  const bundles = await manager.listBundles()
  const bundle = bundles.find((item) => item.name === name)
  if (bundle === undefined) return fail(`没有这个名字的 bundle：${name}`)
  if (!bundle.removable) {
    const why = bundle.optional
      ? '它是 dsh 安装自带的，不在 profile 依赖里 —— 只能停用'
      : '管理器把它标记为不可移除'
    return fail(`${name} 不能卸载：${why}`)
  }

  let result
  try {
    result = await manager.removeBundle(name)
  } catch (error) {
    return fail(`卸载 ${name} 失败：${messageOf(error)}`)
  }
  const short = summarize(result, '卸载')
  toast(ctx, result.changed ? `已卸载 ${name}` : `卸载未生效：${name}`, result.changed ? 'success' : 'warning')
  return result.changed ? ok(`${short} · 重启后彻底卸载`) : fail(short)
}

/**
 * @param {any} ctx
 * @param {any} manager
 * @param {string} name
 * @param {boolean} enabled
 */
async function setEnabled(ctx, manager, name, enabled) {
  if (name === '') return fail(`用法：/${COMMAND_NAME} ${enabled ? 'on' : 'off'} <名字>`)
  let result
  try {
    result = await manager.setBundleEnabled(name, enabled)
  } catch (error) {
    return fail(`${enabled ? '启用' : '停用'} ${name} 失败：${messageOf(error)}`)
  }
  const short = summarize(result, enabled ? '启用' : '停用')
  toast(ctx, `${enabled ? '已启用' : '已停用'} ${name}`, result.changed ? 'success' : 'warning')
  return result.changed ? ok(short) : fail(short)
}

// ── new-version detection ─────────────────────────────────────────────────
// The panel flags installed plugins whose registry/repository has a newer
// version. npm dist-tags is the primary source; plugins installed from a
// `github:` dependency spec fall back to the repository's latest release tag.

const UPDATE_TTL_MS = 10 * 60 * 1000
const updateCache = new Map()

/** Test seam. */
let updatesFetcher = async (name) => {
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name
  const response = await fetch(`https://registry.npmjs.org/-/package/${encoded}/dist-tags`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) return undefined
  const tags = await response.json()
  return typeof tags.latest === 'string' ? tags.latest : undefined
}
export function overrideUpdatesFetcher(fn) {
  updatesFetcher = fn
}

/** a < b across dot-triples; an absent prerelease beats a present one. */
export function semverLt(a, b) {
  const pa = String(a ?? '').split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = String(b ?? '').split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const left = pa[index] ?? 0
    const right = pb[index] ?? 0
    if (left !== right) return left < right
  }
  const hasPrerelease = (version) => String(version ?? '').includes('-')
  if (hasPrerelease(a) !== hasPrerelease(b)) return hasPrerelease(a)
  return false
}

async function githubLatestTag(spec) {
  const match = /^github:([^/]+\/[^@#]+)/u.exec(spec)
  if (match === null) return undefined
  const response = await fetch(`https://api.github.com/repos/${match[1]}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-tui-pkg' },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) return undefined
  const payload = await response.json()
  return typeof payload.tag_name === 'string' ? payload.tag_name.replace(/^v/u, '') : undefined
}

function profileDependencies() {
  try {
    const manifest = JSON.parse(readFileSync(profilePackagePath(), 'utf8'))
    return manifest.dependencies ?? {}
  } catch {
    return {}
  }
}

/**
 * For every profile-installed bundle, resolve the newest known version.
 * Returns a Map of bundle name → newer version (only when newer exists).
 * @param {any[]} bundles
 */
export async function checkUpdates(bundles) {
  const deps = profileDependencies()
  const out = new Map()
  await Promise.all(
    bundles.filter((bundle) => bundle.installed).map(async (bundle) => {
      if (bundle.version === undefined || bundle.version === '') return
      const cached = updateCache.get(bundle.name)
      if (cached !== undefined && Date.now() - cached.at < UPDATE_TTL_MS) {
        if (cached.latest !== undefined) out.set(bundle.name, cached.latest)
        return
      }
      let latest
      try {
        latest = await updatesFetcher(bundle.name)
        if (latest === undefined) {
          const spec = deps[bundle.name]
          if (typeof spec === 'string' && spec.startsWith('github:')) latest = await githubLatestTag(spec)
        }
      } catch {
        latest = undefined
      }
      updateCache.set(bundle.name, { latest, at: Date.now() })
      if (latest !== undefined && semverLt(bundle.version, latest)) out.set(bundle.name, latest)
    }),
  )
  return out
}

// ── the panel (full-screen scene) ────────────────────────────────────────

/** Scene id; also the title shown while the panel is open. */
const SCENE_ID = 'dsh-tui-pkg'

/**
 * The two panel views. Default is the installed set only: the panel would
 * otherwise be dominated by the dsh-installation-supplied surface switches
 * (web / headless / acp / sdk / experimental) that nobody installed.
 * @param {any[]} bundles
 * @param {'installed'|'all'} filter
 */
export function filterBundles(bundles, filter) {
  if (filter !== 'installed') return bundles
  return bundles.filter((bundle) => bundle.installed)
}

/**
 * The panel component. Built with the HOST's React (`props.React.createElement`
 * only — no JSX, no React import, hooks only off `props.React`), because the
 * host reconciler rejects elements from any other React copy.
 *
 * Layout per row: ☑/☐ (click = toggle enable), short name + version (click =
 * select), and a dim fact tail (state · row count · source · removable). The
 * bottom line is the install input. Results are written into the transcript
 * through `channel.pushLocal`, so they do not vanish like notifications do.
 *
 * @param {any} ctx plugin activation context
 * @param {() => any} managerGetter resolves the plugin manager per use
 */
export function panelComponent(ctx, managerGetter) {
  return function Panel(props) {
    const { React, ui, channel, close } = props
    const { Box, Text, useInput } = ui
    const [bundles, setBundles] = React.useState([])
    const [selected, setSelected] = React.useState(0)
    const [draft, setDraft] = React.useState('')
    const [focusInput, setFocusInput] = React.useState(false)
    const [filter, setFilter] = React.useState('installed')
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState('')
    const [choices, setChoices] = React.useState(pendingChoices ?? [])
    const [updates, setUpdates] = React.useState(new Map())
    const visible = filterBundles(bundles, filter)
    const picking = choices.length > 0

    const say = (text) => {
      setNotice(text)
      const timer = setTimeout(() => setNotice((current) => (current === text ? '' : current)), 4000)
      timer?.unref?.()
    }

    const push = (lines) => {
      try {
        channel?.pushLocal?.(SCENE_ID, lines)
      } catch {
        /* the transcript is a nicety, never a dependency */
      }
    }
    const refresh = async () => {
      const manager = managerGetter()
      if (manager === undefined) return
      try {
        const list = await manager.listBundles()
        setBundles(list)
        // New-version hints; cached per name for 10 minutes, so re-checks are cheap.
        void checkUpdates(list)
          .then((map) => setUpdates(map))
          .catch(() => {})
      } catch (error) {
        push([`读取清单失败：${messageOf(error)}`])
      }
    }
    React.useEffect(() => {
      // Consume the handoff from the text command (ambiguous GitHub names);
      // the state initializer already captured it, so just clear the slot.
      pendingChoices = null
      void refresh()
    }, [])

    const toggle = async (bundle) => {
      if (busy) return
      setBusy(true)
      const manager = managerGetter()
      if (manager === undefined) {
        setBusy(false)
        return
      }
      try {
        const result = await manager.setBundleEnabled(bundle.name, !bundle.enabled)
        const line = summarize(result, bundle.enabled ? '停用' : '启用')
        push([line])
        say(line)
        await refresh()
      } catch (error) {
        const line = `切换 ${bundle.name} 失败：${messageOf(error)}`
        push([line])
        say(line)
      } finally {
        setBusy(false)
      }
    }
    const removeSelected = async () => {
      const bundle = visible[selected]
      if (bundle === undefined) return
      if (!bundle.removable) {
        const line = `${bundle.name} 不能卸载（dsh 自带或受保护，只能停用）`
        push([line])
        say(line)
        return
      }
      const manager = managerGetter()
      if (manager === undefined) return
      try {
        const result = await manager.removeBundle(bundle.name)
        const line = summarize(result, '卸载')
        push([line])
        say(line)
        await refresh()
        setSelected((current) => Math.min(current, visible.length - 2))
      } catch (error) {
        const line = `卸载 ${bundle.name} 失败：${messageOf(error)}`
        push([line])
        say(line)
      }
    }
    const submit = async () => {
      const spec = draft.trim()
      if (spec === '') return
      const manager = managerGetter()
      if (manager === undefined) return
      setDraft('')
      const startLine = `安装 ${spec} …`
      push([startLine])
      say(startLine)
      try {
        let resolved
        try {
          resolved = await resolveInstallSpec(manager, spec)
        } catch (error) {
          resolved = { problem: `检查 ${spec} 失败：${messageOf(error)}` }
        }
        if (resolved.problem !== undefined) {
          const line = `安装 ${spec} 失败：${resolved.problem}`
          push([line])
          say(line)
          await refresh()
          return
        }
        if (resolved.choices !== undefined) {
          setChoices(resolved.choices)
          setSelected(0)
          const line = `GitHub 有 ${resolved.choices.length} 个同名仓库，↑↓ 选择 · 回车安装 · Esc 取消`
          push([line])
          say(line)
          return
        }
        const result = await manager.installBundle(resolved.spec, { enabled: true })
        let line = summarize(result, '安装')
        if (result.changed && resolved.via === 'github') {
          const bundled = ensureInBundles(resolved.name)
          if (bundled === 'bundled') line = `${line} · 已登记 bundle（重启生效）`
        }
        push([line])
        say(line)
      } catch (error) {
        const line = `安装 ${spec} 失败：${messageOf(error)}`
        push([line])
        say(line)
      }
      await refresh()
    }

    const installChoice = async (candidate) => {
      const manager = managerGetter()
      if (manager === undefined) return
      setChoices([])
      const spec = candidate.spec
      const startLine = `安装 ${spec} …`
      push([startLine])
      say(startLine)
      try {
        const result = await manager.installBundle(spec, { enabled: true })
        let line = summarize(result, '安装')
        if (result.changed) {
          const bundled = ensureInBundles(candidate.name)
          if (bundled === 'bundled') line = `${line} · 已登记 bundle（重启生效）`
        }
        push([line])
        say(line)
      } catch (error) {
        const line = `安装 ${spec} 失败：${messageOf(error)}`
        push([line])
        say(line)
      }
      await refresh()
    }

    useInput((input, key) => {
      if (picking) {
        if (key.escape) {
          setChoices([])
          say('')
          return
        }
        if (key.upArrow) {
          setSelected((current) => Math.max(0, current - 1))
          return
        }
        if (key.downArrow) {
          setSelected((current) => Math.min(choices.length - 1, current + 1))
          return
        }
        if (key.return) {
          const candidate = choices[selected]
          if (candidate !== undefined) void installChoice(candidate)
        }
        return
      }
      if (key.escape) {
        if (focusInput || draft !== '') {
          setFocusInput(false)
          setDraft('')
        } else {
          close()
        }
        return
      }
      if (focusInput) {
        if (key.return) void submit()
        else if (key.backspace) setDraft((current) => current.slice(0, -1))
        else if (key.upArrow) setFocusInput(false)
        else if (key.downArrow) setFocusInput(false)
        else if (typeof input === 'string' && input !== '' && !/[\r\n]/u.test(input)) setDraft((current) => current + input)
        return
      }
      if (key.upArrow) {
        setSelected((current) => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setSelected((current) => Math.min(Math.max(0, visible.length - 1), current + 1))
        return
      }
      if (key.return) {
        // Enter toggles the selected row's enablement — the keyboard path that
        // works even where mouse reporting is unavailable. The checkbox click
        // stays as a bonus for terminals that do report the mouse.
        const bundle = visible[selected]
        if (bundle !== undefined) void toggle(bundle)
        return
      }
      if (input === 'r' || input === 'R') void refresh()
      else if (input === 'd' || input === 'D') void removeSelected()
      else if (input === 'i' || input === 'I') setFocusInput(true)
      else if (input === 'f' || input === 'F') {
        setFilter((current) => (current === 'installed' ? 'all' : 'installed'))
        setSelected(0)
      }
    })

    return React.createElement(
      Box,
      { flexDirection: 'column' },
      ...(picking
        ? [
            React.createElement(
              Text,
              { bold: true },
              `多个同名仓库（${choices.length}）· ↑↓ 选择 · 回车安装 · Esc 取消`,
            ),
            ...choices.map((choice, index) =>
              React.createElement(
                Text,
                {
                  key: choice.spec,
                  bold: index === selected,
                  color: index === selected ? 'accent' : undefined,
                  onClick: () => setSelected(index),
                },
                `${index === selected ? '▶' : ' '} ${choice.label}`,
              ),
            ),
          ]
        : [
            React.createElement(
              Text,
              { bold: true },
              `插件与 bundle（${visible.length}/${bundles.length}${filter === 'installed' ? '，仅已安装' : '，全部'}） 回车=启停 · ↑↓ 选择 · d 卸载 · i 安装 · r 刷新 · f 过滤 · Esc 退出`,
            ),
            ...visible.map((bundle, index) =>
              React.createElement(
                Box,
                { key: bundle.name, flexDirection: 'row' },
                React.createElement(Text, { onClick: () => void toggle(bundle) }, `${bundle.enabled ? '☑' : '☐'} `),
                React.createElement(
                  Text,
                  {
                    bold: index === selected,
                    color: index === selected ? 'accent' : undefined,
                    onClick: () => setSelected(index),
                  },
                  `${shortName(bundle.name)}${bundle.version === undefined ? '' : ` ${bundle.version}`}`,
                ),
                React.createElement(
                  Text,
                  { dimColor: true },
                  ` ｜ ${bundle.enabled ? '启用' : bundle.installed ? '停用' : '未启用'} · ${Array.isArray(bundle.rows) ? bundle.rows.length : 0}行 · ${bundle.installed ? '依赖' : '自带'} · ${bundle.removable ? '可卸' : '只读'}`,
                ),
                updates.get(bundle.name) === undefined
                  ? null
                  : React.createElement(Text, { color: 'warning' }, ` ⬆新版 ${updates.get(bundle.name)}`),
              ),
            ),
          ]),
      notice === ''
        ? null
        : React.createElement(Text, { color: 'warning' }, `⚠ ${notice}`),
      React.createElement(
        Text,
        { color: focusInput ? 'accent' : undefined },
        focusInput
          ? `安装: ${draft}▏`
          : '安装: （i 聚焦输入，回车安装，Esc 退出面板）',
      ),
    )
  }
}

// ── activation ────────────────────────────────────────────────────────────

/**
 * Boot self-test: report which host seams the live composition mounted, run
 * `/pkg status` for real, and check the install path's first leg against the
 * real registry. This is the only end-to-end check that needs no keyboard.
 * @param {any} ctx
 */
async function selfTestProbe(ctx) {
  const manager = softGet(ctx, 'pluginManager')
  const dialogs = softGet(ctx, 'tuiDialogs')
  selfTest(
    `seams:commands=${softGet(ctx, 'commands') !== undefined} manager=${manager !== undefined} dialogs=${dialogs !== undefined} toast=${softGet(ctx, 'tuiToast') !== undefined} host=${softGet(ctx, 'tuiPluginHost') !== undefined}`,
  )
  if (manager === undefined) return
  try {
    const bundles = await manager.listBundles()
    selfTest(`bundles:${bundles.length} enabled:${bundles.filter((bundle) => bundle.enabled).length}`)
  } catch (error) {
    selfTest(`bundles-failed:${messageOf(error)}`)
  }
  try {
    const result = await commandDefinition(ctx).handler({ rawInput: ' status', signal: undefined })
    selfTest(`status:${result.kind}:${result.text}`)
  } catch (error) {
    selfTest(`status-failed:${messageOf(error)}`)
  }
  try {
    const result = await commandDefinition(ctx).handler({ rawInput: ' web', signal: undefined })
    selfTest(`web:${result.kind}:${result.text}`)
  } catch (error) {
    selfTest(`web-failed:${messageOf(error)}`)
  }
  // The first leg of the one-click install, against the real registry: exactly
  // what `/pkg <name>@<version>` resolves before it installs.
  try {
    const inspection = await manager.inspect('dsh-tui-theme')
    selfTest(
      inspection.status === 'accepted'
        ? `inspect:dsh-tui-theme:accepted:${inspection.name}@${inspection.version}:bundle=${inspection.bundle}`
        : `inspect:dsh-tui-theme:refused:${inspection.problem}`,
    )
  } catch (error) {
    selfTest(`inspect-failed:${messageOf(error)}`)
  }
  // Which *extension* seams accept a Loader-mounted plugin? Dialogs are mediated
  // and refused (below), but scenes/shortcuts/settings are what the working
  // community plugin relies on — so probe them explicitly instead of assuming.
  const scenes = softGet(ctx, 'tuiScenes')
  if (scenes !== undefined) {
    try {
      const dispose = scenes.register({ id: 'dsh-tui-pkg-probe', title: 'probe', component: () => null }, ctx)
      selfTest('scene:registered')
      const opened = scenes.open('dsh-tui-pkg-probe')
      selfTest(`scene:open=${opened} active=${scenes.active?.id ?? 'none'}`)
      try {
        scenes.close()
      } catch {
        /* already closed */
      }
      try {
        dispose()
      } catch {
        /* already disposed */
      }
      selfTest('scene:closed')
    } catch (error) {
      selfTest(`scene-failed:${messageOf(error)}`)
    }
  } else {
    selfTest('scene:absent')
  }

  const statusService = softGet(ctx, 'tuiStatus')
  if (statusService !== undefined) {
    try {
      const dispose = statusService.set?.('dsh-tui-pkg:probe', 'probe')
      selfTest(`status:set:${typeof dispose}`)
      if (typeof dispose === 'function') dispose()
    } catch (error) {
      selfTest(`status-failed:${messageOf(error)}`)
    }
  }

  const toastService = softGet(ctx, 'tuiToast')
  if (toastService !== undefined) {
    try {
      selfTest(`toast:show=${toastService.show('dsh-tui-pkg probe')}`)
    } catch (error) {
      selfTest(`toast-threw:${messageOf(error)}`)
    }
  }

  // Record the mediated-dialog limitation, so a future host that fixes it shows
  // up here as a working call instead of silence.
  if (dialogs !== undefined) {
    const started = Date.now()
    try {
      const answer = await dialogs.select({
        title: 'dsh-tui-pkg selftest',
        options: [{ id: 'probe', label: 'probe' }],
        timeoutMs: 900,
      })
      selfTest(`dialog:${answer === undefined ? 'cancelled' : String(answer)}:${Date.now() - started}ms`)
    } catch (error) {
      selfTest(`dialog-threw:${messageOf(error)}`)
    }
  }
}

/**
 * @param {any} ctx plugin activation context
 */
export function apply(ctx) {
  mark(`apply:pid=${process.pid} version=0.4.2`)
  // The panel must be registered from THIS activation (synchronously when the
  // seam is ready, or from a poll timer created during apply — both carry the
  // activation's own token, which is what tuiScenes.register checks).
  whenMounted(
    ctx,
    'scenes',
    () => softGet(ctx, 'tuiScenes'),
    (scenes) => {
      try {
        const dispose = scenes.register(
          { id: SCENE_ID, title: 'dsh-tui-pkg', component: panelComponent(ctx, () => softGet(ctx, 'pluginManager')) },
          ctx,
        )
        ctx.effect(() => dispose)
        mark('scene:registered')
      } catch (error) {
        mark(`scene-failed:${messageOf(error)}`)
      }
    },
  )
  whenMounted(
    ctx,
    'commands',
    () => softGet(ctx, 'commands'),
    (commands) => {
      registerCommand(ctx, commands)
      ctx.logger?.info?.(`dsh-tui-pkg: /${COMMAND_NAME} registered`)
      if (typeof process.env.DSH_TUI_PKG_SELFTEST === 'string' && process.env.DSH_TUI_PKG_SELFTEST !== '') {
        void selfTestProbe(ctx).catch((error) => selfTest(`probe-failed:${messageOf(error)}`))
      }
    },
  )
}
