---
kind: upgrade-guide
description: "Sidebar browser configurations require a shell authentication token and expose only reading and navigation tools."
---

# Sidebar browser authentication and read tools

English | [中文](guide.zh.md)

## Change

The Playwright provider in `mode: sidebar` requires `socketToken` from the desktop Host environment. It hides script and input tools, restricts `browser_tabs` to `action: list`, and rejects guessed tool names again at execution. Navigation accepts only HTTP(S) URLs. Snapshot and screenshot tools omit `filename` and reject calls containing it; default artifacts use the provider-owned `.playwright-mcp` output directory beneath the Session cwd. Launch, attach, and extension modes retain their tool catalogs.

Programmatic MCP decorators may return `undefined` to omit a tool. Code that invokes a value typed as `McpToolDecorator` must handle that return before reading tool fields.

## Migration

1. In the profile row for `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`, add `socketToken: !!js process.env.DSH_SIDEBAR_BROWSER_TOKEN` alongside `socketPath`. The desktop shell supplies a new token on each launch; keep it in the environment, without logging it or adding it to URLs.
2. Remove Sidebar references to script or input tools from prompts and tool ordering. Keep snapshot, screenshot, navigation, back/forward, and tab listing. Use `action: list` for `browser_tabs`, HTTP(S) URLs for navigation, and no `filename` for snapshots or screenshots. Read default artifacts from `.playwright-mcp` beneath the Session cwd.
3. If your code invokes a `McpToolDecorator`, check for `undefined` before using the returned options.
4. Confirm that the Sidebar tool catalog omits `browser_evaluate` and that invoking it directly fails without changing the page. Verify snapshot, screenshot, and navigation through the desktop application.
