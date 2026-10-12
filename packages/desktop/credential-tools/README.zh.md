---
description: "基于 Electron 凭据保管库的桌面专属 credentials_list 与 credentials_fill 模型工具：按 id 引用、原生批准后代填，供选择或调试桌面 agent 凭据能力的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-desktop-credential-tools

[English](README.md) | 中文

## 概述

本包为桌面 agent 提供两个工具：`credentials_list` 列出用户为当前侧边栏浏览器标签页所在站点保存的登录条目，`credentials_fill` 在用户通过 shell 原生对话框批准后代填其中一条。密码与一次性验证码永远不会到达模型或 Host 进程；结果只携带条目元数据、字段名和错误类别。随附的 web-app patch 只在 desktop profile 下挂载本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当桌面 agent 需要协助登录时挂载本包：模型按 id 引用已保存的条目，用户逐次批准代填，shell 将密文直接写入页面。

### 何时选择

只在 Electron 桌面组合内选择它——那里 shell 拥有凭据保管库和侧边栏浏览器。其它场景都不要用：这两个工具依赖桌面 Host IPC 通道，随附的 patch 行会在 web 与 headless profile 下禁用本插件，而在不受支持的组合里挂载，每次调用只会得到 `unavailable`。

### 最小配置

本插件不声明 `Config`；挂载该行即是全部配置。[`@deepseek-ai/dsh-bundle-web-app` 的 cordis.patch.yml](../../bundle/web-app/cordis.patch.yml) 中随附的行带有 desktop-only 门控：

```yaml
- id: desktop-credential-tools
  name: '@deepseek-ai/dsh-desktop-credential-tools'
  disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本插件运行在桌面 Host 子进程中。`apply` 把进程 IPC 通道适配成 `DesktopCredentialBridge`，并用一个 `ctx.effect()` 注册两个工具，dispose 时一并注销。每次工具调用向 Electron 主进程发送一个请求信封（`credentials-list` 或 `credentials-fill` 加关联 id）并等待应答；中止调用只就地收尾，已经弹出的 shell 侧批准对话框不会被取消——工具注册表的取消契约会向模型报告该调用被中止，工具描述中已声明此时结果未知、必须向用户确认。

主进程把目标页面解析为最近激活且仍可见的侧边栏浏览器 guest：标签页变为可见时渲染进程经 IPC 上报激活（guest 租约尚未建立时先入队），标签页隐藏时上报失活，分屏场景下由 guest 的 `focus` 事件重新排序。应答前，以及代填时在批准之后和每个字段注入之前，shell 都会核对所跟踪的租约仍是当前激活租约，并向渲染进程确认该标签页当前可见——租约已变、未应答或否定确认一律以 `no-active-page` 结束请求，不再注入任何字段，因此批准期间被隐藏的标签页不会被代填。应答只携带字段名和错误类别（`unavailable`、`no-window`、`no-active-page`、`not-found`、`origin-mismatch`、`denied`、`error`）——绝不含密文或页面值。批准、来源复核、解密和注入全部留在 shell，见[侧边栏浏览器桌面凭据](../../client/ui-sidebar-browser/README.zh.md#desktop-credentials)。

本包不发布 runtime invariant companion：它不拥有任何持久状态，请求/应答映射由直接测试覆盖。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/protocol.ts`](src/protocol.ts) | 与 shell 共享的线路信封、branded 条目 id 与错误类别 |
| [`src/bridge.ts`](src/bridge.ts) | Host IPC 通道上的关联请求器，含应答校验 |
| [`src/tools.ts`](src/tools.ts) | 两个工具定义及其模型可见结果文本 |
| [`src/index.ts`](src/index.ts) | 插件入口：`name` / `inject` / `apply` 接线 |

### 导出形状

本插件是函数/命名空间插件：导出 `name` / `inject` / `apply`，没有 default 导出，Loader 因此保持其命名空间完整。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [侧边栏浏览器桌面凭据](../../client/ui-sidebar-browser/README.zh.md#desktop-credentials)——本包依赖的保管库、批准对话框与代填保证。
- [desktop 组地图](../README.zh.md)——同组页面。
- [桌面应用 README](../../../apps/desktop/README.zh.md)——shell 半侧：保管库存储、IPC 发送者校验与激活标签页跟踪。
- [添加工具 cookbook](../../../docs/cookbook/adding-a-tool.zh.md)——这些工具遵循的呈现与结果元数据约定。

-----

<a id="model-experience"></a>
## 模型体验

### 工具定义

#### 模型看到什么

两个工具定义。`credentials_list` 无参数，自述只返回元数据。`credentials_fill` 需要必填的 `credentialId` 字符串（"Entry id from credentials_list."）和必填的非空 `fields` 数组（取值为 `username`、`password`、`totp`）；其描述声明每次代填都需用户批准、模型永远看不到密文、页面已跳转的标签页会被拒绝，且被取消或中断的调用结果未知、模型必须向用户确认。

#### Token 影响

在工具可见的每个桌面请求上是两份固定大小的定义；描述与参数跨会话不变。

#### KV Cache 影响

组合不变时前缀稳定。挂载或卸载本插件会使工具定义块之后的缓存复用失效。

### 工具调用结果

#### 模型看到什么

list 调用返回 `Credentials for <site>:` 后跟若干 `- <label> (id: <id>, username: <username>[, one-time code available])` 行，或 `No saved credentials match <site>.`。fill 调用返回 `Filled: <fields>.`，可选地附加 `No matching input found on the page for: <fields>.`，或 `Nothing was filled.`。失败按类别各返回一条固定句子，如 `The user did not approve the credential fill.` 或 `No browser tab is currently active in the user's sidebar; ask the user to open the login page there first.`。任何结果都不含密码、验证码或页面值。

#### Token 影响

list 结果随匹配条目数增长；fill 结果与失败都是固定形态。调用参数与结果在压缩前一直留在请求中。

#### KV Cache 影响

仅追加；新可见内容跟在可复用的请求前缀之后，不会使已有 KV 缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是当前的包约束，不是任务待办。

- **仅限 desktop profile**——其它 profile 下随附门控保持插件禁用，在不受支持的组合里挂载只会让每次调用返回 `unavailable`；没有远程宿主或 web 回退。
- **仅限当前可见的激活侧边栏标签页**——代填目标是最近激活的侧边栏浏览器 guest，应答前、批准后以及每个字段注入前都会向渲染进程确认该标签页当前可见；页面跳离条目站点后会被拒绝。后台标签页、iframe 和 shadow root 按 shell 代填路径的设计本就不在范围内。
- **中止调用后结果未知**——本地中止不会取消 shell 侧的批准对话框，注册表的取消报告会取代工具自身的应答；工具描述已要求模型向用户确认。经协议取消对话框留作后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
