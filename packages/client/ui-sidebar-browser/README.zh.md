---
description: "右侧 Sidebar 浏览器 tab：在 sandbox 中访问 HTTP(S) 页面，包括 loopback 服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-browser

[English](README.md) | 中文

## 概述

在独立的右侧 Sidebar tab 中浏览 HTTP(S) 页面，包括 loopback 服务。Web 使用 iframe 和应用维护的 history；Desktop 使用 Electron `<webview>`、原生导航 history 和保活页面。本包不会向被访问内容注入 Electron 或 Node 能力。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Browser 在 Web profile 中默认禁用，在 Desktop 中默认启用。Web 用户可通过 profile patch 启用随附条目。可以从右侧 Sidebar guide 打开 **浏览器**并输入 HTTP(S) URL。Chat 的[链接偏好](../ui-chat/README.zh.md)选择**应用内侧边栏**时，HTTP(S) 链接会在此打开。不带 scheme 的主机名会补全为 HTTPS。公共目标与 loopback 目标使用相同的默认 sandbox。每次 guide 操作或委托到此的消息链接操作都会创建一个新的 Browser tab。

### 何时选择

当 Web 页面需要保留在当前 Session 旁时，选择 Browser。本地文件使用 [Document Preview](../ui-sidebar-documentpreview/README.zh.md)；站点拒绝 iframe 嵌入或需要本包不授予的浏览器 capability 时，使用明确的外部浏览器操作。

### 最小配置

本包没有插件配置字段。Web profile 通过其 profile patch 启用随附条目：

```yaml
- id: ui-sidebar-browser
  disabled: false
```

Client 插件可以调用 `ctx.sidebarRight.openTab('browser', { params: { url } })` 打开 tab。可选 URL 会在导航前接受与地址栏输入相同的校验。

命令 `browser.new` 在焦点停靠分栏打开独立浏览器页，替换开始页并保留已有内容页。从聊天区或浮动内容页触发时，使用活动停靠分栏。桌面默认键在 macOS 上为 Cmd+T，在 Windows 上为 Ctrl+T；Windows 和 macOS Web 使用[快捷键服务的平台默认值](../shortcuts/README.zh.md)；Linux Web 默认不绑定此命令。开始页按钮使用蓝色地球图标，并在按钮内显示有效快捷键，不额外弹出重复提示。

工具栏提供后退、前进、刷新、前往、在系统浏览器中打开，Desktop 还提供站点登录菜单，可清除本 tab 所属站点或全部站点的存储数据。Web 还提供逐 tab sandbox 开关；关闭它是临时选择，并会显示灰字、琥珀色底的警告。Desktop 显示观察到的页面标题。重启后，Browser 展示保存的标题和 URL；只有点击恢复或刷新才打开该地址。

<a id="desktop-credentials"></a>
### Desktop 凭据

在 Desktop 中，**凭据**列出与当前页面 origin 匹配的条目。选择**填入账号密码**或**填入验证码**；**管理凭据**可新增和删除任意 HTTP(S) 站点的条目。密码和可选的 base32 动态验证码密钥或 `otpauth://totp/` URI 输入框在发出保存请求后立即清空。Web iframe 不显示凭据控件。

Electron 主进程把 `credential-vault.json` 保存在 `app.getPath('userData')` 下。系统钥匙串通过 `safeStorage` 保护密码和验证码密钥的密文；站点、名称、用户名和是否配置验证码的标志是可读元数据。写入必须有加密能力，先在同目录创建权限为 0600 的临时文件，再原子替换。文件不可读或损坏时拒绝操作并保留原文件，包括缺少验证码标志的试验文件；请恢复有效备份后重试。

每次代填都需要主窗口的批准弹窗，列明站点、条目与字段；macOS 上触控 ID 可用时，批准后必须完成指纹验证。主进程在批准前和注入前严格核对规范化 origin，隔离世界脚本还会核对实际文档 origin。敏感值只在批准后解密，仅为代填进入 guest，不通过 IPC 返回、不进入模型、不写日志。首次新增时，输入值必然短暂存在于本机表单和新增 IPC 中。

代填只查找顶层文档中可见的输入框，触发 input/change 事件，不提交表单。不会遍历 iframe 或 shadow root；特殊或分段表单可能需要手动填写。填入后，目标站点可以读取这些值。动态验证码支持 SHA1/SHA256/SHA512、6–8 位数字和正整数周期。在 desktop profile 下，[`@deepseek-ai/dsh-desktop-credential-tools`](../../desktop/credential-tools/README.zh.md) 插件在同一批准与代填路径之上提供只按引用工作的 `credentials_list` / `credentials_fill` 模型工具；渲染进程在标签页可见期间上报激活、隐藏时撤销上报，shell 在每次模型代填前还会复核可见性，隐藏标签页绝不会成为代填目标。本功能仍不提供外部密码管理器接入或短信转发；原生批准与钥匙串行为仍需在目标操作系统验证。

<a id="desktop-site-sessions"></a>
### Desktop 站点持久会话

Desktop 为每个站点分配独立的持久存储分区，分区键是站点规范化后的 HTTP(S) origin。分区名是 `persist:` 加 origin 的 SHA-256 摘要，磁盘路径上不出现明文站点标识。Cookie 与 Web storage 跨应用重启保留，登录状态一直有效直到被清除。tab 的首个页面决定它所属的站点，并记入 tab 的保存记录。之后的跨站导航（例如到另一个站点登录）留在同一个 guest 和分区里；重新挂载、崩溃后重试和重启后恢复都会再次申请这个分区，因此写在其中的登录数据仍然可用。Chromium 在分区内仍按 origin 隔离 cookie 与 storage。保留站点之前保存的记录使用其保存页面的 origin。

Desktop 工具栏的溢出菜单提供**清除某站点的登录**和**清除全部站点登录**。单站点一项写明 tab 分区所属的站点，它可能与当前显示的页面不同；只有 tab 有活动页面时才可用。主进程按 tab 的 guest 租约找到分区，关闭该分区的全部 guest，再擦除它的全部存储类型（包括 cookie、localStorage、IndexedDB 与 Service Worker）以及 HTTP 缓存和认证缓存，随后被关闭的每个页面都各自在新的 guest 中重新加载。从请求清除到清除结束，该分区里的任何 tab 都不能作为模型代填目标，被关闭的页面也不会再成为目标；重新加载后仍可见的页面会在新 guest 上重新上报激活。清除全部站点会列出 Electron `sessionData` 下 `Partitions` 目录中哈希命名的分区目录，并加上本次运行用过的分区，因此也能覆盖此前运行留下的分区；不写任何访问过的站点清单。若 Electron 报告的存储路径不是该目录，清除该分区会失败。申请分区会等待同一分区上正在进行的清除。确认提示五秒后消失。

分区键选择 origin 而不是 registrable domain，因为 origin 不需要 public suffix 表，并且与凭据保管库的 origin 校验完全一致；同注册域的兄弟子域因此不共享登录。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

### 协议策略

地址解析器接受 HTTP 与 HTTPS，包括 loopback 目标。`file:` URL、脚本/data/blob 输入、内嵌凭据、DSH 应用自身 origin 和畸形地址会被拒绝。本地文件由 Document Preview 负责渲染。

### Iframe 载体

Web 默认使用 `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`。frame 没有直接的下载或顶层导航 flag。popup 会脱离 sandbox；在 Web 中，逃逸的 popup 会保留 opener，并可以导航顶层应用。被访问的 origin 可以使用自身 Cookie 与 Web storage，但跨域目标无法读取 DSH DOM、storage 或 API 响应。iframe 不发送 referrer，也不添加包自有的 Permissions Policy，因此浏览器默认策略与用户授权生效。toolbar 可以为当前 tab occurrence 移除 sandbox；该选择不持久化。未受 sandbox 约束的页面可以按浏览器 activation 规则导航顶层应用，并使用下载、模态对话框和输入锁定。本包不代理或探测远程页面。

Web 记录 toolbar 提交和 typed tab 打开。导航状态机把每个受控 revision 的第一次 iframe load 视为已知，把后续 load 视为页面已经变化到不可读取 URL 的证据。进入 unknown 状态后，地址会显示标记，后退、前进和外部打开会禁用，刷新则返回最后一个受控 URL。body 重挂载时会重新加载应用最后已知的 URL，并且仅在尚无受控目标时使用可选初始 URL。不产生 iframe load 的 History API 与 fragment 变化仍不可见。iframe `error` event 会显示临时加载失败 notice，直到下一个受控加载，但不会改变 URL history。

### Controller

每个 tab 的 `BrowserController` 负责地址校验、命令和显式恢复。`BrowserFrame` 提供与载体无关的导航状态；`IframeImpl` 使用 `BrowserNavigation`，`ElectronWebViewImpl` 观察 Chromium history。`BrowserPresentation` 负责 DOM 的物理挂载。Slot injection 提供 `useBrowserState` 和普通 callback，React body 不接收 provider 对象或 observable。

Desktop 主进程批准 guest 租约，并执行挂载、导航和权限策略。租约请求携带 tab 所属的站点，主进程按其规范化 origin 派生持久分区。preload 只暴露限定范围的 Browser 操作。共享声明通过标准 `/types` 出口配合 `import type` 引入；Host 与 Client 使用独立 tsconfig 编译。Desktop Browser tab 声明 `keepMounted`，Sidebar 因而在切 tab、切 Session、收起与浮动期间保留其 DOM。

页面刷新快捷键调用工具栏使用的同一重载操作。其 Tooltip 和 ARIA 组合随有效绑定更新。Desktop 通过所属窗口路由已批准 guest 中的有效快捷键；获焦 webview 必须仍持有该 guest 的租约。Web 保留浏览器专用组合。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [右侧 Sidebar](../../../docs/subsystems/sidebar-right.zh.md)——tab composition、导航与生命周期。
- [Document Preview](../ui-sidebar-documentpreview/README.zh.md)——本地源码、Markdown、图片、HTML 与 PDF 渲染。
- [Sidebar Browser 决策](../../../.agents/notes/implemented/feature/2026-09-16-sidebar-browser.zh.md)——iframe 行为与 controller 所有权。
- [Desktop Browser 决策](../../../.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.zh.md)——webview 租约、CWD 存储分组与手动恢复。

-----

<a id="model-experience"></a>
## 模型体验

无。Browser tab 是用户侧呈现状态，不注册工具、prompt section 或 Session event。

#### KV Cache 影响

无；浏览内容不进入模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

隔离策略有意放弃部分浏览器兼容性：

- 很多站点拒绝 iframe 嵌入，或需要默认 sandbox 不向 frame 授予的下载与顶层导航。HTTPS 应用还可能按 mixed-content 策略阻止公共 HTTP 页面。关闭 sandbox 会用自身限制换取兼容性，但不会绕过 mixed-content 或 private-network 策略。未受 sandbox 约束的 frame 可以按浏览器 activation 规则导航顶层应用，并使用下载、模态对话框和输入锁定。该模式不会按 Browser tab 隔离被访问 origin 的 Cookie，也无法阻止 iframe 内页面自行选择后续 URL。
- 在 Web 中，逃逸出 sandbox 的 popup 会保留 opener，并可以通过该链导航顶层应用。Desktop 会单独处理 popup 创建。
- 后续 iframe load 能表明发生了导航，但无法给出新的跨域 URL。History API 与 fragment 变化可能仍不可见；状态变成 unknown 后，Web 的后退与前进不可用。
- 出于安全原因，浏览器会隐藏很多 iframe 失败：DNS、TLS、mixed-content、CSP 与 `X-Frame-Options` 失败可能触发 `load`，也可能不提供可操作 event，而不是触发 `error`。加载失败 notice 只能作为 best-effort 提示。
- 只要 tab 仍在 Sidebar 布局中，保存的标题和 URL 就会跨刷新与插件卸载保留。关闭 tab 会删除其检查点。重启恢复不恢复页面内存、未保存的表单或 Chromium history 栈。
- 本地文件会被拒绝，并继续由 Document Preview 负责。
- Desktop 为每个站点分配独立的持久存储分区，键为规范化 origin 并哈希进分区名；Cookie 与 Web storage 跨应用重启保留，直到从工具栏的站点登录菜单清除。持久分区把 cookie 明文落盘，仅受文件系统权限保护。guest 权限、下载与原生 popup 均被拒绝；通过检查的 HTTP(S) popup 请求会打开 Sidebar tab。Host 地址过滤不是通用私网或 DNS-rebinding 防火墙。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。每个导航 provider 拥有自身的实时状态并直接发布检查点；UI 通过 controller 消费同一份 provider 状态。
