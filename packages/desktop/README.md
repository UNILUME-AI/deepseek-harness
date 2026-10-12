---
description: "The desktop package group: Electron-shell-only plugins under packages/desktop/, for readers choosing or navigating the family."
kind: "package-group"
---

# packages/desktop

English | [中文](README.zh.md)

## Summary

The desktop group holds plugins that only work inside the Electron shell: they run in the desktop Host or main process and rely on shell capabilities such as the credential vault and native approval dialogs. Other profiles never mount them; the shipped composition gates each row to the desktop profile. Shell-side behavior — storage, approval, IPC validation — lives in `apps/desktop`, while these packages own the Host-facing contracts.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`credential-tools`](credential-tools/README.md) | Gives the desktop agent `credentials_list` / `credentials_fill` over the shell's credential vault; secrets never reach the model | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Desktop application README](../../apps/desktop/README.md) — the Electron shell half: vault storage, approval dialog, and IPC sender validation.
- [Sidebar Browser desktop credentials](../client/ui-sidebar-browser/README.md#desktop-credentials) — the user-facing fill flow and its guarantees.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
