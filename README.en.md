# dsh-tui-pkg

[![npm version](https://img.shields.io/npm/v/dsh-tui-pkg)](https://www.npmjs.com/package/dsh-tui-pkg)
[![dshfind](https://dshfind.com/api/badge/Whos12Jackson/dsh-tui-pkg)](https://dshfind.com/en/plugins/Whos12Jackson/dsh-tui-pkg)
[![license](https://img.shields.io/npm/l/dsh-tui-pkg)](https://github.com/Whos12Jackson/dsh-tui-pkg/blob/main/LICENSE)

**Manage dsh-tui plugins with one command.** · [中文](./README.md)

## The core: `/pkg`

One command opens a full-screen panel that does everything — browse, install, remove, enable, disable:

```text
/pkg
```

```text
bundles (3/12, installed only) Enter=toggle · ↑↓ move · d remove · i install · r refresh · f filter · Esc close
☑ dsh-tui 0.11.1        | on · 1 row · dep · read-only
☑ dsh-tui-find 0.4.4    | on · 1 row · dep · removable
☑ dsh-tui-pkg 0.3.3     | on · 1 row · dep · removable
install: (i to focus, Enter installs, Esc closes)
```

| Key | Action |
|---|---|
| **Enter** | toggle the selected row's enablement (clicking ☑ works too, but some terminals never report the mouse) |
| `↑↓` / `d` / `i` | move / remove selected / focus the install input (Enter installs) |
| `r` / `f` / `Esc` | refresh / toggle view (installed ⇄ all) / close |

Only installed bundles show by default; `f` reveals the dsh-installation surfaces (web / headless / acp / sdk). Panel results are written into the session transcript via `channel.pushLocal` — they stay on screen instead of fading like notifications.

## Other commands (briefly)

For one-shot use without the panel:

| Command | What it does |
|---|---|
| `/pkg list` | one-line inventory |
| `/pkg <name>` | one-line detail (state / rows / source / removable) |
| `/pkg <name>@<version>` | install directly (paths, tarballs, git too) |
| `/pkg remove\|on\|off <name>` | remove / enable / disable |
| `/pkg web` | whether the browser surface is on and how to turn it on |

Any first token that is not a known subcommand resolves against the inventory first (an installed name answers with its detail line), otherwise the whole input is an install spec — so `/pkg dsh-tui-theme@0.7.2` installs in one step. `show` / `install` aliases are still recognized for compatibility.


## Design notes (why it looks like this)

- **One line per text result.** A command handler's text is rendered by the host as a notification capped at 200 cells and never enters the transcript; the panel exists precisely to get past that.
- **No confirm dialogs.** `ctx.tuiDialogs` is a *mediated* capability: it requires the caller to be an admitted, non-root activation, and the dsh-tui 0.11.1 loader never runs admission for Loader-mounted plugins (measured: calls answer "cancelled" in ~0 ms). Typing an exact spec is the confirmation instead.
- **One intentional `inject`.** `tuiScenes` is declared at entry level in `cordis.patch.yml` purely as an ordering guarantee — a scene must be registered from a live activation context, and a poll-timer callback does not carry one (`tuiScenes.register requires a live Cordis activation context` otherwise). Everything else is soft-probed with `ctx.get(name, false)`.
- **Zero side effects.** No subprocesses, no file writes outside the profile: all operations delegate to the dsh plugin manager (`ctx.pluginManager`, the official pnpm path with automatic `dsh.profile.bundles` reconciliation and rollback).

## Development

```sh
node test/smoke.mjs     # offline smoke tests against a fake host
node --check lib/index.js
npm pack
```

```
lib/index.js            the whole implementation (pure ESM, zero runtime deps, no build step)
cordis.patch.yml        profile mount layer
dsh-plugin.json         community manifest (community-draft 0.15, permissions complete)
test/smoke.mjs          offline smoke tests
```

### Boot self-test

```sh
$env:DSH_TUI_PKG_SELFTEST="C:\tmp\pkg-selftest.log"
dsh --profile dsh-tui    # start, then exit
```

Records the registration route, whether the five host seams are mounted, the real `listBundles()` count, a real `/pkg status` run, the first leg of a one-click install against the real registry, and the availability of the scene/status/toast/dialog seams.

## License

MIT
