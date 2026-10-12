---
description: "The desktop-only credentials_list and credentials_fill model tools over the Electron credential vault: reference-by-id filling with native approval, for users and maintainers choosing or debugging the desktop agent's credential access."
kind: "package-reference"
---

# @deepseek-ai/dsh-desktop-credential-tools

English | [中文](README.zh.md)

## Summary

This package gives the desktop agent two tools: `credentials_list` shows which login entries the user saved for the site in the active sidebar browser tab, and `credentials_fill` fills one entry after the user approves in the shell's native dialog. Passwords and one-time codes never reach the model or the Host process; results carry entry metadata, field names, and error categories only. The shipped web-app patch mounts it only on the desktop profile.

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

Mount this package when the desktop agent should help with logins: the model references a saved entry by id, the user approves each fill, and the shell writes the secret straight into the page.

### When to choose it

Choose it inside the Electron desktop composition, where the shell owns a credential vault and the sidebar browser. Avoid it everywhere else: the tools need the desktop Host IPC channel, so the shipped patch row disables the plugin on web and headless profiles, and an unsupported mount answers every call with `unavailable`.

### Minimal configuration

The plugin declares no `Config`; mounting the row is the whole setup. The shipped row in [`@deepseek-ai/dsh-bundle-web-app`'s cordis.patch.yml](../../bundle/web-app/cordis.patch.yml) carries the desktop-only gate:

```yaml
- id: desktop-credential-tools
  name: '@deepseek-ai/dsh-desktop-credential-tools'
  disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin runs in the desktop Host child process. `apply` adapts the process IPC channel into a `DesktopCredentialBridge` and registers both tools with one `ctx.effect()`, so disposal unregisters them together. Each tool call sends one request envelope (`credentials-list` or `credentials-fill` plus a correlation id) to the Electron main process and awaits its answer. Aborting a call settles it locally while the shell-side approval already shown stays open; the tool registry's cancellation contract then reports the aborted call to the model, whose description says the outcome is unknown and must be confirmed with the user.

The main process resolves the target page as the most recently activated sidebar browser guest that is still visible: the renderer reports activation over IPC whenever a tab becomes visible (queued until the guest lease exists), reports deactivation when the tab is hidden, and a guest `focus` event reprioritizes within split panes. Before answering, and for a fill again after approval and before each field injection, the shell checks that the tracked lease is still the active one and asks the renderer to confirm the tab is still visible — a changed lease or an unanswered or negative confirmation ends the request with `no-active-page` before any further injection, so a tab hidden during approval is never filled. Answers carry field names and error categories (`unavailable`, `no-window`, `no-active-page`, `not-found`, `origin-mismatch`, `denied`, `error`) — never a secret or a page value. Approval, origin re-checks, decryption, and injection stay in the shell, as documented under [Sidebar Browser desktop credentials](../../client/ui-sidebar-browser/README.md#desktop-credentials).

No runtime invariant companion is published: the package owns no durable state, and its request/response mapping is covered by direct tests.

### Source map

| File | Role |
|---|---|
| [`src/protocol.ts`](src/protocol.ts) | Wire envelopes, branded entry ids, and error categories shared with the shell |
| [`src/bridge.ts`](src/bridge.ts) | Correlated requestor over the Host IPC channel, with answer validation |
| [`src/tools.ts`](src/tools.ts) | The two tool definitions and their model-visible result text |
| [`src/index.ts`](src/index.ts) | Plugin entry: `name` / `inject` / `apply` wiring |

### Export shape

The plugin is a function/namespace plugin: it exports `name` / `inject` / `apply` and no default export, so the Loader keeps its namespace intact.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Sidebar Browser desktop credentials](../../client/ui-sidebar-browser/README.md#desktop-credentials) — the vault, approval dialog, and fill guarantees this package relies on.
- [desktop group map](../README.md) — the sibling group page.
- [Desktop application README](../../../apps/desktop/README.md) — the shell half: vault storage, IPC sender validation, and active-tab tracking.
- [Adding a tool cookbook](../../../docs/cookbook/adding-a-tool.md) — the presentation and result-metadata conventions these tools follow.

-----

<a id="model-experience"></a>
## Model Experience

### Tool definitions

#### What the model sees

Two tool definitions. `credentials_list` takes no arguments and describes itself as metadata-only. `credentials_fill` takes a required `credentialId` string ("Entry id from credentials_list.") and a required non-empty `fields` array of `username`, `password`, `totp`; its description states that the user approves every fill, that the model never sees the secret, that a navigated tab refuses the fill, and that a cancelled or interrupted call has an unknown outcome the model must confirm with the user.

#### Token effect

Two fixed-size definitions on every desktop request where the tools are visible; descriptions and parameters are constant across sessions.

#### KV Cache effect

Prefix-stable while the composition is unchanged. Mounting or unmounting the plugin invalidates reuse from the tool-definition block onward.

### Tool-call results

#### What the model sees

A list call returns `Credentials for <site>:` followed by `- <label> (id: <id>, username: <username>[, one-time code available])` lines, or `No saved credentials match <site>.` A fill call returns `Filled: <fields>.`, optionally `No matching input found on the page for: <fields>.`, or `Nothing was filled.` Failures return one stable sentence per category, such as `The user did not approve the credential fill.` or `No browser tab is currently active in the user's sidebar; ask the user to open the login page there first.` No result ever contains a password, code, or page value.

#### Token effect

List results grow with the number of matching entries; fill results and failures are fixed-shape. Call arguments and results persist in the request until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints, not a task backlog.

- **Desktop profile only** — on any other profile the shipped gate leaves the plugin disabled, and an unsupported mount answers every call with `unavailable`; there is no remote-host or web fallback.
- **Visible active sidebar tab only** — filling targets the most recently activated sidebar browser guest and reconfirms with the renderer that the tab is still visible before answering, after approval, and before each field injection; it refuses once the page navigates away from the entry's site. Background tabs, iframes, and shadow roots are out of scope by design of the shell's fill path.
- **Aborted calls leave the outcome unknown** — the local abort does not cancel the shell-side approval dialog, and the registry's cancellation report replaces the tool's own answer; the description tells the model to confirm with the user. Cancelling the dialog through the protocol is deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
