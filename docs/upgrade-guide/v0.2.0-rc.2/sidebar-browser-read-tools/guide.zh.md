---
kind: upgrade-guide
description: "右栏浏览器配置要求外壳认证口令，且仅提供读取和导航工具。"
---

# 右栏浏览器认证与读取工具

[English](guide.md) | 中文

## 变更

Playwright 提供方的 `mode: sidebar` 要求从桌面 Host 环境读取 `socketToken`。它隐藏脚本和输入工具，把 `browser_tabs` 限制为 `action: list`，并在执行时再次拒绝猜测的工具名。导航仅接受 HTTP(S) 网址。快照和截图工具移除 `filename`，并拒绝含该字段的调用；默认产物保存在 Session cwd 下提供方自己的 `.playwright-mcp` 输出目录中。launch、attach 和 extension 模式保留原工具目录。

编程式 MCP 适配器可以返回 `undefined` 以不注册工具。调用类型为 `McpToolDecorator` 的值时，必须先处理这种返回值，再读取工具字段。

## 迁移

1. 在 profile 的 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 配置行中，在 `socketPath` 旁添加 `socketToken: !!js process.env.DSH_SIDEBAR_BROWSER_TOKEN`。桌面外壳每次启动提供新口令；把它留在环境中，不写入日志或网址。
2. 从提示词和工具排序中移除右栏的脚本和输入工具引用。保留快照、截图、导航、后退前进和列标签。调用 `browser_tabs` 时使用 `action: list`，导航使用 HTTP(S) 网址，快照和截图不传 `filename`。从 Session cwd 下的 `.playwright-mcp` 读取默认产物。
3. 若代码调用 `McpToolDecorator`，先检查返回值是否为 `undefined`，再使用返回的选项。
4. 确认右栏工具目录没有 `browser_evaluate`，且直接调用它失败、页面不变。通过桌面应用验证快照、截图和导航。
