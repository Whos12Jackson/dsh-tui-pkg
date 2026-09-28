# dsh-tui-pkg

[![npm version](https://img.shields.io/npm/v/dsh-tui-pkg)](https://www.npmjs.com/package/dsh-tui-pkg)
[![dshfind](https://dshfind.com/api/badge/Whos12Jackson/dsh-tui-pkg)](https://dshfind.com/en/plugins/Whos12Jackson/dsh-tui-pkg)
[![license](https://img.shields.io/npm/l/dsh-tui-pkg)](https://github.com/Whos12Jackson/dsh-tui-pkg/blob/main/LICENSE)

**Manage [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) plugins with one command.** · [中文](./README.md)

Browse, install, remove, enable and disable plugins without leaving the terminal. Works with npm packages and GitHub-only plugins, with new-version detection built in.

## Install

```sh
dsh plugin --profile dsh-tui add -w dsh-tui-pkg@latest
```

```sh
dsh plugin --profile dsh-tui remove -w dsh-tui-pkg   # uninstall
```

Requires dsh-tui ≥ 0.9 (tested on 0.11.1) and Node `^22.19 || >=24`. **Restart dsh-tui afterwards** — `/reload` does not reload plugin code.

## The core: `/pkg`

One command opens the full-screen panel:

```text
/pkg
```

```text
bundles (3/12, installed only) Enter=toggle · ↑↓ move · d remove · i install · r refresh · f filter · Esc close
☑ dsh-tui 0.11.1        | on · 1 row · dep · read-only
☑ dsh-tui-find 0.4.4    | on · 1 row · dep · removable  ⬆new 0.5.0
☑ dsh-tui-pkg 0.4.3     | on · 1 row · dep · removable
install: (i to focus, Enter installs, Esc closes)
```

| Key | Action |
|---|---|
| **Enter** | toggle the selected row's enablement (clicking ☑ works too, but some terminals never report the mouse) |
| `↑↓` / `d` / `i` | move / remove selected / focus the install input (Enter installs) |
| `r` / `f` / `Esc` | refresh / toggle view (installed ⇄ all) / close |

Only installed bundles show by default; `f` reveals the dsh-installation surfaces (web / headless / acp / sdk). Panel results are written into the session transcript, so they stay on screen instead of fading like notifications.

**New-version detection**: opening the panel (or pressing `r`) checks installed plugins for newer versions and lights up `⬆new x.y.z` on the row — npm-installed plugins query the registry, git-installed ones query GitHub releases; only versions *newer* than the installed one are flagged, and results are cached for 10 minutes.

## Other commands (briefly)

For one-shot use without the panel:

| Command | What it does |
|---|---|
| `/pkg list` | one-line inventory |
| `/pkg <name>` | one-line detail (state / rows / source / removable) |
| `/pkg <name>@<version>` | install directly (paths, tarballs, git too) |
| `/pkg remove\|on\|off <name>` | remove / enable / disable |
| `/pkg web` | whether the browser surface is on and how to turn it on |

Any first token that is not a known subcommand resolves against the inventory first (an installed name answers with its detail line), otherwise the whole input is an install spec — so `/pkg dsh-tui-theme@0.7.2` installs in one step.

**GitHub-only plugins** (most of the community): just type the bare name. When npm has no such package, `/pkg` searches GitHub for matching repositories — a single exact match installs from the git spec and **registers the bundle automatically**; with several matches, the panel switches to a picker: `↑↓` to choose, Enter installs, Esc cancels (the text command opens the panel too).

## License

MIT

## Links

- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) — the terminal host this plugin runs in
- [dshtui.com](https://dshtui.com) — the dsh-TUI ecosystem site
