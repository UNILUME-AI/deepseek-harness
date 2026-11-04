---
description: "The OS-keychain credentials provider for maintainers composing the UNILUME desktop app or debugging where its sign-in credentials are stored."
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-keychain

English | [中文](README.zh.md)

## Summary

`dsh-credentials-keychain` keeps three UNILUME desktop credentials in the OS keychain (macOS Keychain, Windows Credential Manager) instead of the plaintext credential file: the `UNILUME_MODEL_TOKEN` reference and the `unilume-desktop/default` and `client-connection/browser-session` records. Every other credential stays in `.credentials.yaml` with exactly the behavior of [`dsh-credentials-local`](../credentials-local/README.md), which this provider extends. On start it moves those three credentials out of an existing file.

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

Load it in place of `dsh-credentials-local` as the `credentials` service in a desktop composition. Consumers keep using `ctx.credentials`; nothing changes for them.

### Setting it up

```yaml
- id: credentials
  name: '@deepseek-ai/dsh-credentials-keychain'
```

It accepts the same configuration fields as [`dsh-credentials-local`](../credentials-local/README.md).

### Which credentials go to the keychain

| Credential | Keychain account | Stored text |
|---|---|---|
| reference `UNILUME_MODEL_TOKEN` | `UNILUME ref UNILUME_MODEL_TOKEN` | the value |
| record `unilume-desktop/default` | `UNILUME record unilume-desktop/default` | the record as JSON |
| record `client-connection/browser-session` | `UNILUME record client-connection/browser-session` | the record as JSON |

Every entry uses the service name `UNILUME dsh credentials`. Windows Credential Manager names an entry `<account>.<service>`, so each entry name starts with `UNILUME`. `resolve` and `describe` report the source `keychain`; `listRecords` and `describeRecord` include keychain records without their values. The launch environment still wins for `UNILUME_MODEL_TOKEN`, and the `.env` files still rank below the keychain.

### Moving credentials out of an existing file

On start, the provider copies each of the three credentials found in `.credentials.yaml` into the keychain, reads each entry back, and compares it with the file value. Only when every entry matches does it rewrite the file without them and delete `.credentials.yaml.bak-*` backups and leftover `.credentials.yaml.*.tmp` files beside it. If any step fails, the file stays as it was and keeps serving those credentials, and the next start tries again.

### What can go wrong

- **The keychain is unavailable** — access denied, no keychain service, or a platform error makes reads and writes of the three credentials fail with an "OS keychain is unavailable" error, and the cause is logged. Nothing is written to the file instead; the user signs in again once access is allowed. `listRecords` logs the failure and leaves those records out.
- **Signing out** — `unset` and `deleteRecord` remove the keychain entry and any copy still in the file.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider subclass: keychain routing, boot migration, keychain error reporting, and the `@napi-rs/keyring` backend |
| — | No runtime invariant companion is published; the keychain and the file are separate stores with no owned relation a second observation could check. |

### Writes and the file lock

Writes and deletes of the three credentials run on the file store's operation queue under its `<file>.lock` writer lock, so they exclude each other across processes exactly like file writes. Inside the lock the provider re-reads the file, commits to the keychain, and then removes any copy of the credential from the file with an atomic rewrite. A copy still in the file is an unmigrated value and wins over the keychain entry on reads, because the next migration copies it over that entry; a write therefore becomes visible only after the file copy is gone.

### Record text

A record's keychain text is `JSON.stringify(record)`. Reads admit it through the file store's strict document parser, and writes refuse a record whose JSON text does not parse back to an equal value, so a `Date`, a class instance, or a non-finite number is rejected as it is in the file.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [File-backed credentials provider](../credentials-local/README.md) — the store this provider extends and every behavior it keeps.
- [Credential-reference seam](../credentials/README.md) — the operations both providers implement.
- [Atomic write](../../util/atomic-write/README.md) — the writer lock and atomic replacement.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumers of `ctx.credentials`, which own any model-facing behavior a stored value enables.

#### KV Cache effect

No direct invalidation; stored values never enter a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Keychain changes from other processes publish no event** — reads go to the keychain on every call, so values stay current, but `credentials/reference-updated` and `credentials/record-updated` fire only for this process's writes and for file changes.
- **The credential set is fixed** — the three credentials are constants of the UNILUME desktop app, not configuration.
- **The file stays a denied read path** — `agentDeniedReadPaths` still lists `.credentials.yaml`, because every other credential remains in it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

The packaged desktop app still has to prove that the prebuilt `@napi-rs/keyring` binary loads after signing on macOS and Windows, and that an upgrade followed by a restart raises no second keychain access prompt.

</details>
