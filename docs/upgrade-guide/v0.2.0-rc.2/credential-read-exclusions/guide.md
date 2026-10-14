---
kind: upgrade-guide
description: "Confined local file tools reject credential-file reads and process backends report their read-exclusion gaps."
---

# Confined credential-file reads

English | [中文](guide.zh.md)

## Change

Previously, local restricted modes permitted credential-file reads. `read-only` and `workspace-write` now exclude the actual file published by `dsh-credentials-local` and optional `sandbox-policy.deniedReadPaths`. Filesystem content reads reject with `FS_SANDBOX_DENIED`; Grep rejects protected explicit targets and filters directory matches. Seatbelt denies named reads and mutations; bwrap masks existing files with empty content. Seatbelt and bwrap retain their enforcement judgment; Landlock reports `partial` with exclusions and Windows ACL remains `partial`. Their read guarantees have [known gaps](../../../../packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work). `danger-full-access` remains unrestricted.

## Migration

1. Keep credentials behind `ctx.credentials`; remove agent workflows that inspect the managed YAML file directly.
2. Custom credential providers that store local files override `agentDeniedReadPaths` with their actual resolved absolute filenames. Providers with no local files inherit the empty list.
3. Add other protected host filenames to `deniedReadPaths` on the shared `sandbox-policy` row in `cordis.yml` or its profile patch. Relative paths and existing directories fail at load; use filenames, including absent ones. SSH providers remove host-only exclusions before sending a policy to the remote helper.
4. Verify a restricted filesystem read of the configured credential file returns `FS_SANDBOX_DENIED`, while an ordinary workspace read succeeds. Check the reported process enforcement and [backend limits](../../../../packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work) before treating it as secret isolation.
