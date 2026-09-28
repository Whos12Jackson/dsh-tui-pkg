# dsh-tui-pkg

[![npm version](https://img.shields.io/npm/v/dsh-tui-pkg)](https://www.npmjs.com/package/dsh-tui-pkg)
[![dshfind](https://dshfind.com/api/badge/Whos12Jackson/dsh-tui-pkg)](https://dshfind.com/zh/plugins/Whos12Jackson/dsh-tui-pkg)
[![license](https://img.shields.io/npm/l/dsh-tui-pkg)](https://github.com/Whos12Jackson/dsh-tui-pkg/blob/main/LICENSE)

**在 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 里管理插件 —— 一个命令。** · [English](./README.en.md)

浏览、安装、卸载、启用、停用插件，都不用离开终端。支持 npm 包和只有 GitHub 仓库的插件，自带新版本探测。

## 安装

```sh
dsh plugin --profile dsh-tui add -w dsh-tui-pkg@latest
```

```sh
dsh plugin --profile dsh-tui remove -w dsh-tui-pkg   # 卸载
```

要求 dsh-tui ≥ 0.9（实测 0.11.1），Node `^22.19 || >=24`。**装完重启 dsh-tui**（`/reload` 不重载插件代码）。

## 核心：`/pkg`

一个命令打开全屏管理面板：

```text
/pkg
```

```text
插件与 bundle（3/12，仅已安装） 回车=启停 · ↑↓ 选择 · d 卸载 · i 安装 · r 刷新 · f 过滤 · Esc 退出
☑ dsh-tui 0.11.1        ｜ 启用 · 1行 · 依赖 · 只读
☑ dsh-tui-find 0.4.4    ｜ 启用 · 1行 · 依赖 · 可卸  ⬆新版 0.5.0
☑ dsh-tui-pkg 0.4.3     ｜ 启用 · 1行 · 依赖 · 可卸
安装: （i 聚焦输入，回车安装，Esc 退出面板）
```

| 键 | 作用 |
|---|---|
| **回车** | 切换选中行的启用 ⇄ 停用（☑ 上点鼠标也可以，但部分终端不报鼠标） |
| `↑↓` / `d` / `i` | 选行 / 卸载选中行 / 聚焦底部安装输入（回车安装） |
| `r` / `f` / `Esc` | 刷新 / 切换显示（仅已安装 ⇄ 全部）/ 退出 |

默认只显示**已安装**的 bundle；按 `f` 才看到 dsh 自带的 web/headless/acp/sdk 表面开关。面板里的操作结果会写进**会话记录**，不会像通知条那样一闪而过。

**新版本探测**：打开面板（或按 `r`）时自动检查已装插件的新版本，行尾亮 `⬆新版 x.y.z` 表示有更新 —— npm 装的查注册表，git 源装的查 GitHub releases；只提示"比当前版本新"的，结果缓存 10 分钟。

## 其他命令（简要）

不想开面板时，文本命令也是一行直达：

| 命令 | 作用 |
|---|---|
| `/pkg list` | 一行清单 |
| `/pkg <名字>` | 一行详情（状态/行数/来源/可否卸载） |
| `/pkg <包名>@<版本>` | 直接安装（路径 / tarball / git 也行） |
| `/pkg remove\|on\|off <名字>` | 卸载 / 启用 / 停用 |
| `/pkg web` | web 面板状态与开启方式 |

判定规则：第一个词不是已知子命令时，命中已装名字就当详情，否则整串当安装规格（所以 `/pkg dsh-tui-theme@0.7.2` 一键安装）。

**只有 GitHub 没有 npm 的插件**（社区大多数如此）：直接输裸包名就行 —— 找不到 npm 包会自动搜 GitHub 同名仓库；唯一命中就按 git 源安装并**自动登记 bundle**。**多个同名仓库**时面板进入选择模式：`↑↓` 选择、回车安装、Esc 取消（文本命令触发时也会自动打开面板）。

## License

MIT

## 相关链接

- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) — 本插件运行的终端宿主
- [dshtui.com](https://dshtui.com) — dsh-TUI 生态官网
