---
description: "Right-Sidebar browser tabs for sandboxed HTTP(S) pages, including loopback services."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-browser

English | [中文](README.zh.md)

## Summary

Browse HTTP(S) pages, including loopback services, inside independent right-Sidebar tabs. Web uses an iframe with application-managed history; Desktop uses Electron `<webview>` with native navigation history and retained pages. The package never injects Electron or Node access into visited content.

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

Browser is disabled by default in Web profiles and enabled on Desktop. Enable the shipped entry through the Web profile patch to use it. Open **Browser** from the right-Sidebar guide and enter an HTTP(S) URL. Chat HTTP(S) links open here when the [link preference](../ui-chat/README.md) selects **In-App Sidebar**. A host name without a scheme becomes HTTPS. Public and loopback targets use the same default sandbox. Each guide action or delegated message-link activation creates another Browser tab.

### When to choose it

Choose Browser for a Web page that should remain beside the current Session. Choose [Document Preview](../ui-sidebar-documentpreview/README.md) for local files, and use the explicit external-browser action when a site refuses iframe embedding or needs browser capabilities this package withholds.

### Minimal configuration

The package has no plugin configuration. A Web profile enables the shipped entry through its profile patch:

```yaml
- id: ui-sidebar-browser
  disabled: false
```

Client plugins can open a tab through `ctx.sidebarRight.openTab('browser', { params: { url } })`. The optional URL passes the same validation as address-bar input before navigation.

The `browser.new` command opens a separate Browser page in the focused dock pane, replacing a guide and retaining existing content pages. From the conversation or a floating content page, it uses the active dock pane. Desktop defaults to Cmd+T on macOS and Ctrl+T on Windows; Windows and macOS Web use the [shortcut service’s platform defaults](../shortcuts/README.md); Linux Web leaves the command unbound. The guide button uses a blue globe and displays the effective shortcut inline without a duplicate tooltip.

The toolbar provides Back, Forward, Reload, Go, Open in system browser, and, on Desktop, a site sign-in menu that clears the stored data of the tab's own site or of every site. Web also offers a per-tab sandbox toggle; disabling it is temporary and displays an amber warning with neutral text. Desktop shows the observed page title. After a restart, Browser shows the saved title and URL; Restore or Reload opens that address only when requested.

<a id="desktop-credentials"></a>
### Desktop credentials

On Desktop, **Credentials** lists entries matching the current page origin. Choose **Fill username and password** or **Fill verification code**. **Manage credentials** adds and deletes entries for any HTTP(S) site. Password and optional base32 TOTP key or `otpauth://totp/` URI inputs clear immediately after the save request. The Web iframe has no credential controls.

Electron’s main process stores `credential-vault.json` under `app.getPath('userData')`. The system keyring protects password and TOTP ciphertext through `safeStorage`; site, name, username and the TOTP-presence flag remain readable metadata. Writes require encryption and use a same-directory temporary file created with mode 0600 before atomic replacement. Unreadable or malformed files reject operations and remain untouched; this includes experimental files missing the TOTP-presence flag. Restore a valid backup before retrying.

Every fill requires a main-window approval dialog naming the site, entry and fields. On macOS, available Touch ID is required after approval. The main process checks the exact normalized origin before approval and again before injection; the isolated-world script also checks the document origin. Secrets are decrypted only after approval, enter the guest only for filling, and never return through IPC, enter the model or get logged. Initial entry necessarily exists briefly in the local form and add IPC.

Filling affects visible inputs in the top-level document and dispatches input/change events without submitting. It does not traverse iframes or shadow roots, and unusual or segmented forms may require manual entry. Once filled, the target site can read the values. TOTP accepts SHA1/SHA256/SHA512, 6–8 digits and a positive integer period. On the desktop profile, the [`@deepseek-ai/dsh-desktop-credential-tools`](../../desktop/credential-tools/README.md) plugin exposes reference-only `credentials_list` / `credentials_fill` model tools over the same approval and fill path; the renderer reports the active tab while it is visible and withdraws the report when the tab is hidden, and the shell reconfirms visibility before every model fill, so a hidden tab is never the target. This feature still provides no external password-manager integration or SMS forwarding. Native approval and keyring behavior require verification on the target operating system.

<a id="desktop-site-sessions"></a>
### Desktop persistent site sessions

Desktop gives each site its own persistent storage partition keyed by the site's normalized HTTP(S) origin. The partition name is `persist:` plus a SHA-256 digest of the origin, so no plaintext site identity reaches disk paths. Cookies and Web storage survive application restarts, so a sign-in lasts until cleared. A tab's first page decides its site, which the tab's saved record keeps. Later cross-site navigations, such as a sign-in on another site, stay in the same guest and partition, and remounts, crash retries and restored tabs after a restart acquire that partition again, so sign-in data written there remains available. Chromium still isolates cookies and storage per origin inside the partition. Records saved before the site was retained use their saved page's origin.

The overflow menu in the Desktop toolbar offers **Clear sign-in for** the tab's site and **Clear all site sign-ins**. The single-site entry names the site that owns the tab's partition, which can differ from the page shown, and is available only while the tab has a live page. The main process finds the partition from the tab's guest lease, closes every guest in that partition, then erases all of its storage kinds, including cookies, localStorage, IndexedDB and service workers, plus the HTTP cache and authentication cache. Every page closed this way reloads in a fresh guest. From the moment a clear is requested until it finishes, no tab in that partition can be the model fill target, and the closed pages never become it again; a reloaded page that is still visible reports itself active on its fresh guest. Clearing all sites lists the hashed partition directories under Electron's `sessionData` `Partitions` directory together with partitions used in the current run, so it also reaches partitions left by earlier runs; no list of visited sites is written. Clearing a partition fails if Electron reports a storage path other than that directory. Acquiring a partition waits for a running clear of the same partition. A confirmation notice disappears after five seconds.

Partition keys use origins rather than registrable domains because origins need no public-suffix table and match the credential vault's origin checks exactly; sibling subdomains therefore do not share sign-ins.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Protocol policy

The address parser accepts HTTP and HTTPS, including loopback targets. It rejects `file:` URLs, script/data/blob input, embedded credentials, the DSH application origin, and malformed addresses. Document Preview owns local-file rendering.

### Iframe carrier

Web uses `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"` by default. The frame has no direct download or top-navigation flag. Popups leave the sandbox; in Web, an escaped popup retains its opener and can navigate the top-level application. The visited origin can use its own cookies and Web storage but a cross-origin target cannot read DSH DOM, storage, or API responses. The iframe sends no referrer and adds no package-owned Permissions Policy, so browser defaults and user grants apply. The toolbar can remove the sandbox for the current tab occurrence; the choice is not persisted. An unsandboxed page can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. The package does not proxy or probe remote pages.

Web records toolbar submissions and typed tab opens. A navigation state machine treats the first iframe load for each controlled revision as known and a later load as proof that the page changed to an unreadable URL. In that unknown state the address is marked, Back, Forward, and external-open are disabled, and Reload returns to the last controlled URL. A remounted body reloads the latest application-known URL and uses its optional initial URL only before the first controlled target. History API and fragment changes that emit no iframe load remain invisible. An iframe `error` event displays a transient load-failure notice until the next controlled load without changing URL history.

### Controller

Each tab's `BrowserController` owns address validation, commands and explicit restoration. `BrowserFrame` supplies carrier-neutral navigation state; `IframeImpl` uses `BrowserNavigation`, while `ElectronWebViewImpl` observes Chromium history. `BrowserPresentation` owns physical DOM attachment. Slot injection supplies `useBrowserState` and plain callbacks, keeping provider objects and observables out of the React body.

Desktop's main process approves guest leases and enforces attachment, navigation and permission policy. The lease request carries the tab's site, and the main process derives the persistent partition from its normalized origin. Preload exposes only scoped Browser operations. Shared declarations use the standard `/types` export with `import type`; the Host and Client compile through separate tsconfig files. Desktop Browser tabs declare `keepMounted`, so Sidebar preserves their DOM across tab changes, Session switches, collapse and floating.

The page refresh shortcut calls the same reload operation as the toolbar. Its tooltip and ARIA key combination follow the effective binding. Desktop routes accepted shortcuts from an approved guest through its owning window; the focused webview must still carry that guest’s lease. Web leaves browser-reserved combinations unchanged.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Right Sidebar](../../../docs/subsystems/sidebar-right.md) — tab composition, navigation, and lifecycle.
- [Document Preview](../ui-sidebar-documentpreview/README.md) — local source, Markdown, images, HTML, and PDF rendering.
- [Sidebar Browser decision](../../../.agents/notes/implemented/feature/2026-09-16-sidebar-browser.md) — iframe behavior and controller ownership.
- [Desktop Browser decision](../../../.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.md) — webview leases, CWD storage grouping and manual restoration.

-----

<a id="model-experience"></a>
## Model Experience

None, as Browser tabs are user-facing presentation state and register no tool, prompt section, or Session event.

#### KV Cache effect

None; browsing does not enter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The isolation policy deliberately gives up some browser compatibility:

- Many sites refuse iframe embedding or need downloads or top-level navigation withheld from the frame by the default sandbox. An HTTPS application can also block public HTTP pages as mixed content. Disabling the sandbox trades its restrictions for compatibility but does not bypass mixed-content or private-network policy. The unsandboxed frame can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. It does not isolate the visited origin's cookies per Browser tab or prevent an in-frame page from choosing its own next URL.
- In Web, a popup that escapes the sandbox retains its opener and can use that chain to navigate the top-level application. Desktop handles popup creation separately.
- A later iframe load reveals that navigation occurred but not the new cross-origin URL. History API and fragment changes may remain invisible; Web Back and Forward are unavailable after the state becomes unknown.
- Browsers conceal many iframe failures for security: DNS, TLS, mixed-content, CSP, and `X-Frame-Options` failures may emit `load` or no actionable event instead of `error`. The load-failure notice is best-effort.
- Saved title and URL survive reloads and plugin unload while the tab remains in Sidebar's layout. Closing the tab removes its checkpoint. Restart restoration does not recover page memory, unsaved forms or Chromium's history stack.
- Local files are rejected and remain owned by Document Preview.
- Desktop assigns each site its own persistent storage partition keyed by the normalized origin, which is hashed into the partition name; cookies and Web storage survive application restarts until cleared from the toolbar's site sign-in menu. Persisted partitions store cookies in plaintext on disk, protected only by file-system permissions. Guest permissions, downloads and native popups are denied; approved HTTP(S) popup requests open Sidebar tabs. Host-address filtering is not a general private-network or DNS-rebinding firewall.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Each navigation provider owns its live state and publishes checkpoints directly; the UI consumes the same provider state through its controller.
