---
description: "Operate Chromium through Playwright MCP with separate browser state for each live Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-playwright-mcp

English | [中文](README.zh.md)

## Summary

Use Playwright MCP to inspect pages and operate Chromium through its upstream tools. The provider initializes a Session's MCP connection before creation or resume completes and retains it across turns. Launch a separate browser or attach one Session to an existing browser with its current tabs and login state. This published experimental package activates only when explicitly mounted.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount both entries before creating or resuming a Session, in a profile composition that supplies Agents, tools, and system prompts. Loading or reloading this provider does not adopt Sessions that are already active. Browser installation follows the upstream runtime; select an existing Chromium installation with `executablePath`.

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
  config:
    mode: launch
    headless: true
```

Use `mode: attach` and set `endpoint` to an HTTP(S) debugging URL or WS(S) browser endpoint to operate an existing browser. The new live Session claims the attachment during initialization and retains it until unloading. If the attachment is busy, that activation continues without this browser and does not retry on later turns. After release, a newly created or resumed activation can acquire it. Direct calls from another Session fail. Cleanup disconnects and leaves the external browser and its pages running.

Use `mode: extension` to operate the user’s running Chrome with its existing login state. Install Playwright Extension in that browser first; `browser` selects `chrome` (default) or `msedge`, never Playwright’s bundled Chromium. Copy the token from the extension interface into the Harness credential service or the named launch environment variable, and put only its reference in `extensionTokenEnv`. The reference resolves anew for each Session startup; a missing or empty credential fails initialization, and credential-provider failures report a generic error without the secret. Without the credential service, resolution uses the Harness launch environment. Omit the reference to select and approve a tab manually on the extension connection page. Extension connections use the same Session exclusivity and cleanup rules as attachments.

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
  config:
    mode: extension
    browser: chrome
    extensionTokenEnv: BROWSER_EXTENSION_TOKEN
    capabilities: [vision]
```

`capabilities` defaults to `[]` in every mode. Only `vision` is accepted; enabling it exposes upstream coordinate tools such as `browser_mouse_click_xy` to the model. Remove it to retain the default accessibility-based tool catalog.

| Field | Default | Meaning |
|---|---|---|
| `mode` | required | `launch`, `attach`, or `extension`, fixed for this provider activation |
| `headless` | `true` | Launch without a visible window |
| `executablePath` | upstream discovery | Chromium executable for launch |
| `endpoint` | required for attach | Existing browser debugging endpoint |
| `browser` | `chrome` | Extension browser channel: `chrome` or `msedge` |
| `extensionTokenEnv` | manual approval | Extension credential reference; extension mode only |
| `capabilities` | `[]` | Optional `vision` coordinate tools in any mode |
| `toolCallTimeoutMs` | MCP client default | Per-call timeout in milliseconds |
| `pointerCoordinates` | `pixel` | Coordinate space the configured model emits for pointer tools |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-browser-use-playwright-mcp) lists accepted fields. The profile or preset selects the browser mode. The child process clears inherited `PLAYWRIGHT_MCP_*` options and sets `PLAYWRIGHT_MCP_EXTENSION_TOKEN` only from the configured reference. The token never appears in the MCP server's arguments, but the pinned server adds it to the extension connection page URL that it passes to the browser executable. Extension mode rejects `endpoint`, `headless`, and `executablePath`.

When configuring the system prompt's `toolOrder` for the whole process, leave browser tools under `<unlisted-tools>`. Explicitly listing browser tool names can make prompt assembly fail for Sessions without a browser connection.

### Pointer coordinates

The upstream server declares pointer positions in viewport-relative CSS pixels, the same space as its default `css`-scale screenshots. Vision models instead emit coordinates under per-vendor conventions, and a BYOM deployment knows its own model's convention, so the provider declares it through `pointerCoordinates`:

| Value | Model convention |
|---|---|
| `pixel` | Absolute CSS pixels (GPT-5, GPT-6) |
| `normalized-1000-xy` | 0-1000 normalized to the viewport (Doubao Seed, Qwen3.x; Gemini is assumed to fill named `x` and `y` the same way, not yet measured) |

The mapping follows each vendor's published coordinate convention, as catalogued by the model adapters in midscene. The upstream arguments are named `x` and `y`, so there is no positional axis order to swap. A normalized space requires `capabilities: [vision]`, which is what exposes the coordinate tools; configuring one without it fails activation. In a normalized space the three pointer tools (`browser_mouse_move_xy`, `browser_mouse_click_xy`, `browser_mouse_drag_xy`) are rewritten so the model sees 0-1000 viewport coordinates; arguments outside 0-1000 or not finite fail as a tool error without reaching the browser. Each coordinate call first reads the live viewport through the upstream `browser_evaluate` tool (one extra MCP round trip per call) and converts with rounding, clamped to the viewport edges. The upstream result echoes the pixel values it used, so a text line restating the 0-1000 space and the viewport size is appended to it. `pixel` keeps tool definitions and arguments byte-identical to the upstream server. The conversion matches default viewport screenshots only: full-page and element screenshots do not cover the viewport, so coordinates read from them do not convert correctly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider resolves its pinned npm entry and starts it under the current Node executable. A temporary protocol probe may precede the serving process. The [shared runtime](../browser-use-runtime/README.md) owns awaited Agent initialization, per-Session serialization, and cleanup; the [MCP client](../../mcp/mcp-client/README.md) owns transport, discovery, and result projection. No runtime invariant companion is published because the provider maintains no independent connection observation.

Browser state survives turns while its live Session remains attached. Disposal waits for server shutdown before releasing resources. Resume after reload starts fresh browser runtime state; stored conversation history does not restore cookies or pages.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [Browser-use service](../../browser-use/browser-use/README.md) — exclusive provider registration.
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) — upstream installation and browser behavior.

-----

<a id="model-experience"></a>
## Model Experience

### Browser tools and screenshots

#### What the model sees

Tools retain upstream descriptions and JSON schemas under `mcp__playwright-mcp__<tool>` names. With a normalized `pointerCoordinates` space, the three pointer tools instead present normalized 0-1000 viewport coordinates (order declared) while forwarding CSS pixels upstream. Text and screenshots use the normal tool-result pipeline and Session log. Enabling `vision` adds coordinate-tool definitions to this catalog. Screenshots require an attachment store and an image-capable model route; other routes receive the MCP image diagnostic. The MCP client also exposes resource helpers and attributed server instructions. Browser instructions are shown only after this Session owns a connection; targeted resource requests enforce the same ownership.

#### Token effect

The catalog, resource helpers, and server instructions add tool definitions and prompt text. Calls add arguments, text, and admitted images to Session history. Inline image bytes stay outside model-visible history.

#### KV Cache effect

An unchanged catalog preserves its tool-definition prefix. Results append to history; provider or catalog changes can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The integration retains the pinned server's browser and tool restrictions.

- Chromium only; Firefox and WebKit are not selectable.
- Startup failure or cancellation rejects Session creation or resume and triggers client cleanup. A disconnected client is not retried; after fixing the cause, create a new Session or unload and resume the existing one.
- Attachment exclusivity is local to this provider instance. Other processes and browser users can still modify the same pages.
- The shared resource-server inventory can show inherited server names; it does not grant access to another Session's browser.
- Cancellation does not undo navigation, clicks, or other actions already delivered to the browser.
- Tool schemas follow the pinned experimental dependency and carry no DSH stability promise.
- Extension mode connects on the first browser tool call, not at Session startup. A missing extension fails that call quickly; an unapproved connection holds it until `toolCallTimeoutMs` (the MCP client default when omitted), and later calls in the same Session wait on the same pending connection until the user approves or the Session ends. Raise `toolCallTimeoutMs` when approving manually. A token that does not match the extension's makes the connection page show `Invalid token provided.` without offering manual approval, so calls time out the same way.
- The pinned server opens the connection page with the token in its URL, so the token is briefly visible in the browser launch command line and can remain in browser history.
- Normalized pointer coordinates read the live viewport through the upstream `browser_evaluate` tool on every coordinate call; a server without that tool cannot serve normalized spaces.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
