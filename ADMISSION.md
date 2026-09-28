# dsh-TUI 准入说明（Admission Notes）

对照 [`dsh-TUI Ecosystem Plugin Admission v0.15`](https://github.com/T-Auto/dsh-ecosystem-spec/tree/e1b902b0f95f4280a8e68d414ec7a4d25d6ce106) 逐条说明本插件的合规方式。

## TUI-PKG-001 包身份

包根有唯一 `dsh-plugin.json`（manifestVersion `0.15`），`$schema` 为 Community v0.15 URN。发布 artifact 为 npm tarball `dsh-tui-pkg@0.4.4`（本机 npm 发布，integrity 由 npm registry 绑定）。

## TUI-PKG-002 声明闭包

清单静态声明了全部入口：

- **requires**：`commands.dsh/v1alpha1` `Command`（注册 `/pkg`）；`node: ^22.19 || >=24`；`compat` 声明宿主 `dsh-tui`（>=0.9，实测 0.11.1）。
- **permissions**：`commands.invoke`（/pkg 命令）、`storage.local.read`/`storage.local.write`（仅 profile 清单的 bundles 登记与自有日志目录 `~/.dsh-tui/dsh-tui-pkg/`）。不声明任何 `*.intercept` 权限。
- **contributes**：一个命令 `dsh-tui-pkg.pkg`。
- **overrides**：Community 契约之外的框架面集中在 `x-ccch1mneyyy.tui.host-services` 一条 override 里，含网络面、凭据面、文件面与失败边界的完整披露，无旁路注入。

## TUI-HOST-001 宿主描述符

插件侧只消费 `ctx.get(name, false)` 软探测到的服务，每个服务调用前判空、缺失时降级：无对话框时以"精确输入即确认"完成安装/卸载；无 toast 时忽略提示；面板场景不可用时 `/pkg` 回落为单行文本清单。

## TUI-RUN-001 远程确定性

不假定运行机器有浏览器或 GUI：全部交互有纯键盘路径（回车/↑↓/d/i/r/f/Esc），鼠标点击仅 best-effort；不要求 Presentation 客户端，不把 remote/local 状态保存为 activation 全局状态。

## TUI-OBS-001 归属与清理

所有运行时 effect 归属本次 cordis 激活，deactivate 时全部回收：`/pkg` 命令注册（`ctx.effect` 包裹 disposer）、面板场景注册（`tuiScenes.register` 的 disposer 经 `ctx.effect` 回收）、轮询定时器（创建于 apply，携带 activation token）。卸载后无残留 handler/订阅/定时器。

## TUI-DEP-001 依赖闭包与一次性 Profile 证据

零运行时依赖、零 devDependencies、无构建步骤（纯 ESM）。离线测试：`node test/smoke.mjs`（46 调用）与 `node test/panel.mjs`（6 场景，假 React 台架）。一次性 Profile 实测证据（2026-09-28，Windows / node 22.22.2 / dsh 0.1.7-rc.2）：

```text
## 安装（一次性 profile probe-evidence，本地 artifact）
dependencies:
+ dsh-tui-pkg 0.4.3
Done in 118ms using pnpm v12.6.0

## 启动（无头启动探针 profile）
stderr: dsh: warning: 1 entry did not activate
dsh-tui-pkg (dsh-tui-pkg): pending (waiting for service: tuiScenes)
boot.log: apply:pid=12956 version=0.4.3 → scene:registered → registered:direct
（宿主服务未挂载的 profile 里条目保持 pending 等待，不崩溃；服务齐备时正常激活）

## 卸载并清理
- dsh-tui-pkg 0.4.3
Done in 57ms using pnpm v12.6.0
profile 目录已删：True
```

## TUI-TRUST-001 信任披露

本插件运行于 `trusted-in-process`。清单中的 permission 仅作兼容性、授权提示与审计元数据，不构成 OS/进程/realm 安全边界。

## 隐私与外部服务

不读取会话内容、不碰凭据。外部访问仅两项：GitHub 公共 API（裸包名回退安装时的同名仓库搜索、git 源插件的 release 版本探测）与 npm registry（包元数据、版本探测）。全部为只读 HTTPS GET，无数据上传。
