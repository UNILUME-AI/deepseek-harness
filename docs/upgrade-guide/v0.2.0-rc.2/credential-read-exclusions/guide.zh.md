---
kind: upgrade-guide
description: "受限本地文件工具拒绝读取凭据文件，进程后端报告读取排除的缺口。"
---

# 受限模式的凭据文件读取

[English](guide.md) | 中文

## 变更

原先本地受限模式允许读取凭据文件。`read-only` 与 `workspace-write` 现在排除 `dsh-credentials-local` 发布的实际文件，以及可选的 `sandbox-policy.deniedReadPaths`。fs 内容读取返回 `FS_SANDBOX_DENIED`；Seatbelt 拒绝指定路径，bwrap 把已存在文件遮盖为空内容。名单非空时，本地进程后端因[已知缺口](../../../../packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)报告 `partial`。`danger-full-access` 仍不受限。

## 迁移

1. 使用 `ctx.credentials` 访问凭据，移除让 agent 直接检查托管 YAML 文件的流程。
2. 存储本地文件的自定义凭据提供方覆写 `agentDeniedReadPaths`，返回自己实际解析的绝对文件名；不存本地文件的提供方继承空名单。
3. 其他需要保护的宿主文件在 `cordis.yml` 或 profile patch 的共享 `sandbox-policy` 行配置 `deniedReadPaths`。相对路径在加载时拒绝；远程提供方不能把宿主路径当作远程文件名。
4. 确认受限 fs 读取实际凭据文件返回 `FS_SANDBOX_DENIED`，普通工作区读取正常。判断是否足以隔离机密前，检查进程强制程度与[后端边界](../../../../packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)。
