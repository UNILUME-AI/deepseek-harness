---
description: "The OS-keychain credentials provider for maintainers composing the UNILUME desktop app or debugging where its sign-in credentials are stored."
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-keychain

English | [中文](README.zh.md)

## Summary

`dsh-credentials-keychain` keeps three UNILUME desktop credentials in the OS keychain (macOS Keychain, Windows Credential Manager) instead of the plaintext credential file: the `UNILUME_MODEL_TOKEN` reference and the `unilume-desktop/default` and `client-connection/browser-session` records. Every other credential stays in `.credentials.yaml` with exactly the behavior of [`dsh-credentials-local`](../credentials-local/README.md), which this provider extends. On start it migrates those three credentials from an existing file; keychain failures keep new values only in memory until restart.

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

- **The keychain is unavailable** — the first failed call logs one warning with the original error and switches the three credentials to process memory, including the failed operation. Subsequent reads, writes, deletes, descriptions, and listings use memory without retrying the keychain or repeating the warning. No credential or temporary file is written. Memory values are lost on restart, so the user must sign in again; the new process tries the keychain normally. Unmigrated file entries keep serving until a memory update or deletion overrides them; their files and backups stay untouched for the next migration.
- **An entry exceeds 2560 UTF-8 bytes** — writes reject before calling the backend, including in memory mode. This input error does not mark the keychain unavailable.
- **Signing out** — `unset` and `deleteRecord` remove the keychain entry and any copy still in the file while the keychain is available. In memory mode they remove the memory value and hide an unmigrated file value for this process, leaving the file unchanged.

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

Writes and deletes of the three credentials run on the file store's operation queue. While the keychain is available, they also take its `<file>.lock` writer lock, re-read the file, commit to the keychain, and remove any file copy with an atomic rewrite. An unmigrated file value wins over the keychain entry because the next migration copies it over that entry. After a keychain failure, mutations stay on the queue but skip file locks and rewrites; memory entries override file values, with deletion markers preventing those values from reappearing. Migration accepts only writes verified in the OS keychain, never memory copies.

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

- **Keychain changes from other processes publish no event** — while the keychain is available, reads query it on every call, but `credentials/reference-updated` and `credentials/record-updated` fire only for this process's writes and for file changes. Memory values are private to the provider instance.
- **The credential set is fixed** — the three credentials are constants of the UNILUME desktop app, not configuration.
- **The file stays a denied read path** — `agentDeniedReadPaths` still lists `.credentials.yaml`, because every other credential remains in it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

The packaged desktop app still has to prove that the prebuilt `@napi-rs/keyring` binary loads after signing on macOS and Windows, and that an upgrade followed by a restart raises no second keychain access prompt.

</details>
