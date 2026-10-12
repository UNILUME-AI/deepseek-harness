---
description: "desktop 包组：packages/desktop/ 下仅适用于 Electron shell 的插件，供选择与浏览本族的读者阅读。"
kind: "package-group"
---

# packages/desktop

[English](README.md) | 中文

## 概述

desktop 组收纳只在 Electron shell 内可用的插件：它们运行在桌面 Host 或主进程中，依赖 shell 能力，如凭据保管库和原生批准对话框。其它 profile 从不挂载它们；随附的组合把每一行都门控到 desktop profile。shell 侧行为——存储、批准、IPC 校验——位于 `apps/desktop`，这些包只拥有面向 Host 的契约。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`credential-tools`](credential-tools/README.zh.md) | 让桌面 agent 经 shell 凭据保管库使用 `credentials_list` / `credentials_fill`；密文永远不到达模型 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [桌面应用 README](../../apps/desktop/README.zh.md)——Electron shell 半侧：保管库存储、批准对话框与 IPC 发送者校验。
- [侧边栏浏览器桌面凭据](../client/ui-sidebar-browser/README.zh.md#desktop-credentials)——面向用户的代填流程及其保证。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
