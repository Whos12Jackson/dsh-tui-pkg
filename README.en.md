# dsh-tui-pkg

[![npm version](https://img.shields.io/npm/v/dsh-tui-pkg)](https://www.npmjs.com/package/dsh-tui-pkg)
[![dshfind](https://dshfind.com/api/badge/Whos12Jackson/dsh-tui-pkg)](https://dshfind.com/en/plugins/Whos12Jackson/dsh-tui-pkg)
[![license](https://img.shields.io/npm/l/dsh-tui-pkg)](https://github.com/Whos12Jackson/dsh-tui-pkg/blob/main/LICENSE)

**Manage dsh-tui plugins without leaving the terminal.** · [中文](./README.md)

Browse every bundle your profile and the dsh installation offer, then install, remove, enable or disable one — from a full-screen panel with checkboxes, or with one-line text commands.

## Install

```sh
dsh plugin --profile dsh-tui add -w dsh-tui-pkg@latest
```

Requires dsh-tui ≥ 0.9 (tested on 0.11.1) and Node `^22.19 || >=24`. **Restart the TUI afterwards** — `/reload` does not reload plugin code.

## Usage

```text
/pkg                     # open the full-screen panel
/pkg list                # one-line inventory: 12 items · ● dsh-base dsh-tui … · 8 off
/pkg <name>              # one-line detail: state · rows · source · removable + the next command
/pkg <name>@<version>    # install (also accepts paths, tarballs, github:user/repo)
/pkg remove <name>       # remove (aliases rm / un / del / uninstall)
/pkg on  <name>          # enable a bundle layer (alias enable)
/pkg off <name>          # disable a bundle layer, dependency kept (alias disable)
/pkg web                 # whether the browser surface is enabled and how to enable it
/pkg help                # one-line usage
```

### Panel keys

```text
Enter = toggle the selected row's enablement     ↑↓ move · d remove selected
i focus install input (Enter installs)           r refresh · f filter (installed ⇄ all) · Esc close
```

The panel shows installed bundles only by default; press `f` to see everything the dsh installation ships (web / headless / acp / sdk surfaces). Panel results are written into the session transcript via `channel.pushLocal`, so they stay on screen instead of fading like notifications.

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
