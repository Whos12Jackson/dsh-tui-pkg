# dsh-tui-pkg

[![npm version](https://img.shields.io/npm/v/dsh-tui-pkg)](https://www.npmjs.com/package/dsh-tui-pkg)
[![dshfind](https://dshfind.com/api/badge/Whos12Jackson/dsh-tui-pkg)](https://dshfind.com/zh/plugins/Whos12Jackson/dsh-tui-pkg)
[![license](https://img.shields.io/npm/l/dsh-tui-pkg)](https://github.com/Whos12Jackson/dsh-tui-pkg/blob/main/LICENSE)

**在 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 里管理插件 —— 一个命令。** · [English](./README.en.md)

## 核心：`/pkg`

在 TUI 里敲一个命令，打开全屏管理面板 —— 浏览、安装、卸载、启用、停用全在这里：

```text
/pkg
```

```text
插件与 bundle（3/12，仅已安装） 回车=启停 · ↑↓ 选择 · d 卸载 · i 安装 · r 刷新 · f 过滤 · Esc 退出
☑ dsh-tui 0.11.1        ｜ 启用 · 1行 · 依赖 · 只读
☑ dsh-tui-find 0.4.4    ｜ 启用 · 1行 · 依赖 · 可卸
☑ dsh-tui-pkg 0.3.3     ｜ 启用 · 1行 · 依赖 · 可卸
安装: （i 聚焦输入，回车安装，Esc 退出面板）
```

| 键 | 作用 |
|---|---|
| **回车** | 切换选中行的启用 ⇄ 停用（☑ 上点鼠标也可以，但部分终端不报鼠标） |
| `↑↓` / `d` / `i` | 选行 / 卸载选中行 / 聚焦底部安装输入（回车安装） |
| `r` / `f` / `Esc` | 刷新 / 切换显示（仅已安装 ⇄ 全部）/ 退出 |

默认只显示**已安装**的 bundle；按 `f` 才看到 dsh 自带的 web/headless/acp/sdk 表面开关。面板里的操作结果会写进**会话记录**（`pushLocal`），不会像通知条那样一闪而过。

## 其他命令（简要）

不想开面板时，文本命令也是一行直达：

| 命令 | 作用 |
|---|---|
| `/pkg list` | 一行清单 |
| `/pkg <名字>` | 一行详情（状态/行数/来源/可否卸载） |
| `/pkg <包名>@<版本>` | 直接安装（路径 / tarball / git 也行） |
| `/pkg remove\|on\|off <名字>` | 卸载 / 启用 / 停用 |
| `/pkg web` | web 面板状态与开启方式 |

判定规则：第一个词不是已知子命令时，命中已装名字就当详情，否则整串当安装规格（所以 `/pkg dsh-tui-theme@0.7.2` 一键安装）。`show` / `install` 等旧写法仍被识别，仅作兼容。

**只有 GitHub 没有 npm 的插件**（社区大多数如此）：直接输裸包名就行 —— /pkg 发现 npm 上没有，会自动搜 GitHub 同名仓库；唯一命中就按 git 源安装并**自动登记 bundle**，多个同名会列出规格让你挑。


## 安装与卸载

```sh
dsh plugin --profile dsh-tui add -w ./dsh-tui-pkg-0.3.1.tgz
dsh plugin --profile dsh-tui remove -w dsh-tui-pkg
```

**装完要重启 dsh-tui**（`/restart` 或重开终端）—— `/reload` 不重载插件代码。`/pkg` 自己的安装/卸载同理，结果行会写明。

## 宿主 UI 接缝的边界（0.3.1 修订：场景已打通）

0.3.1 起**全屏面板可用**（`/pkg` 打开；注册需要入口级 `inject: [tuiScenes]`，原因见下文"为什么只有 tuiScenes 进了 inject"）。但其余 UI 接缝仍不给 Loader 挂载的社区插件，实测（真实启动，`DSH_TUI_PKG_SELFTEST` 自检）：

```text
dialog:cancelled:0ms
toast:show=false
```

根因：这些服务的运行时过 `requirePluginCaller`（`dsh-adapter/host-access.js`），要求调用方是**经过准入的、活的、非 root activation**：

```js
const caller = requirePluginCaller(this.ctx, 'tuiScenes.register', this)
if (!Context.is(caller)) throw ... requires a Cordis activation context
if (caller === root || callerFiber === rootFibers.get(root)) throw ... requires a non-root calling activation
```

而 dsh-tui 0.11.1 的 loader **从不调用 `admit()`**。于是：

- **场景**（全屏面板、鼠标勾选）✗
- **对话框**（确认框、选择器）✗
- **toast / 状态行**（返回 false / no-op）✗
- 唯一能把多行文本写进会话记录的 `channel.pushLocal()` **只在场景 props 里** → 多行表格 ✗

**这不是本插件特殊，是所有社区插件一样** —— 你机器上那个很流行的 `dsh-tui-find`，它的 `/find` 全屏界面在这台机器上应该也打不开（试一下就知道）。

### 所以现在的分工

| 需求 | 现状 |
| --- | --- |
| 看清单 | 一行：`●` 已启用 / `○` 装了未启用 的名字 + 未启用可用计数 |
| 看单个细节（状态/行数/来源/可否卸载） | `/pkg <名字>` —— 一行里全给齐 |
| 切换启用 | `/pkg on|off <名字>`，结果行确认 |
| **鼠标勾选** | ❌ TUI 里做不到；**web 面板可以**（见下） |

### 想要鼠标勾选？把 web 面板加进这个 profile

`dsh-web-app` 是 dsh 安装自带的 bundle，启用即可：

```sh
dsh plugin --profile dsh-tui add -w @deepseek-ai/dsh-web-app
# 之后 dsh --profile dsh-tui 同时提供终端界面与浏览器界面
```

那样你就有官方插件页：**可点的开关、搜索、安装向导，而且管的就是同一个 profile**（不是另一个）。等哪天宿主给 Loader 插件开放准入，本插件会自动改回对话框/场景路线 —— 自检里那三行探测就是留给那一天的开关。

不想记这些的话，直接敲 **`/pkg web`** —— 它会报当前状态并给出该敲的那一行（profile 名自动取 `DSH_PROFILE`）。

## 它是怎么工作的

插件**不启动任何进程、不改任何 profile 文件**：

| 能力 | 来源 |
| --- | --- |
| bundle 清单、安装、卸载、启用停用 | `ctx.pluginManager`（官方 pnpm 路径，含 `dsh.profile.bundles` 自动登记与失败回滚） |
| `/pkg` 命令注册 | `ctx.commands`（先试中介路径，失败自动回落直注册） |
| 失败时的 pnpm 输出 | cordis 事件 `plugin-manager/install-log`（只取末行 + 日志路径） |

### 为什么结果永远是一行

命令 handler 返回的文本被宿主当**通知条**渲染，上限 `COMMAND_RESULT_CELLS = 200` 格，且**不进会话记录**。所以每条结果都是单行 —— 冒烟测试对每条结果都断言「≤200 格且不含换行」，对大清单还专门跑一遍截断用例。

### 为什么只有 `tuiScenes` 进了 `inject`，其余全软探测

除 `tuiScenes` 外的每个宿主服务都用 `ctx.get(name, false)` 软探测 + 轮询等挂载。唯一的例外是 `tuiScenes`，在 `cordis.patch.yml` 里做了**入口级 inject，纯粹当排序保证用**：

- 场景必须从**活的 activation 上下文**注册。实测轮询定时器的回调不携带该上下文 —— 注册会抛 `tuiScenes.register requires a live Cordis activation context`（boot.log 里 0.3.0 那次就是）。声明 `inject: [tuiScenes]` 后，`apply()` 在 scenes 挂载之后、于 loader 自己的 activation 里执行，注册即成功（实测 `scene:registered`，且命令注册也从 394ms 的轮询变为同步 +2ms）。
- `tuiScenes` 属于 dsh-tui bundle，本插件面向的任何 profile 都必然挂载它，所以这个 inject 不会造成永久 pending。
- 动态 `ctx.inject([...], cb)` 仍不用：回调里的服务代理会把调用者绑到被注入服务的 fiber 上，注册归属会变成"别的 activation"。

### 安全边界

- 改动 profile 的两个动作是**安装**和**卸载**，必须由你写出确切的名字/规格触发（没有对话框可问，"写清"就是确认）。
- 装不上的包会说清原因：`not-found` / `not-a-bundle` / 网络不可达等；不支持的选项直接拒绝（不会把 `--dry` 当成包名）。
- **保护 dsh 自带的 bundle**：`removable === false` 的（如 `@deepseek-ai/dsh-web-app`）只能启用/停用，卸载会被拒绝并说明理由。
- 失败时给一行根因 + 日志路径。
- 不读会话内容、不碰凭据、不写 profile 之外的文件。

## 开发

```sh
node test/smoke.mjs     # 离线冒烟（含"恶意 UI 接缝"回归：任何流程都不许依赖对话框）
node --check lib/index.js
npm pack
```

```
lib/index.js            全部实现（纯 ESM，零运行时依赖，无构建步骤）
cordis.patch.yml        profile 挂载层（入口级 inject: [tuiScenes]，见上文）
dsh-plugin.json         社区规范清单（community-draft 0.15，permissions 写全）
test/smoke.mjs          离线冒烟测试
```

### 启动自检

```sh
$env:DSH_TUI_PKG_SELFTEST="C:\tmp\pkg-selftest.log"
dsh --profile dsh-tui          # 起来后正常退出即可
```

记录：注册路径、五个接缝是否挂载、`listBundles()` 真实条数、**真实跑一遍 `/pkg status`**、一键安装第一步（对真实注册表 `inspect`）、以及场景/状态行/toast/对话框四条 UI 接缝的可用性。

本机实测（dsh-tui 0.11.1 / dsh 0.1.7-rc.2）：

```text
mediated-unavailable: ... requires a non-root activation context from the host composition
registered:direct
seams:commands=true manager=true dialogs=true toast=true host=true
bundles:12 enabled:4
status:success:12 项 · ● dsh-base dsh-tui dsh-tui-find dsh-tui-pkg · 8 项未启用可用 ｜ /pkg <名字> 看详情
inspect:dsh-tui-theme:accepted:dsh-tui-theme@0.7.2:bundle=true
scene-failed:dsh-tui: tuiScenes.register requires a live Cordis activation context
status:set:function
toast:show=false
dialog:cancelled:0ms
```

要求 dsh-tui ≥ 0.9（实测 0.11.1），Node `^22.19 || >=24`。

## License

MIT

## 相关链接

- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) — 本插件运行的终端宿主
- [dshtui.com](https://dshtui.com) — dsh-TUI 生态官网
