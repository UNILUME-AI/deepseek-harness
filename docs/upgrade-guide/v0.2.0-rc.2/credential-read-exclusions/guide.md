---
kind: upgrade-guide
description: "Confined local file tools reject credential-file reads and process backends report their read-exclusion gaps."
---

# Confined credential-file reads

English | [中文](guide.zh.md)

## Change

Previously, local restricted modes permitted credential-file reads. `read-only` and `workspace-write` now exclude the actual file published by `dsh-credentials-local` and optional `sandbox-policy.deniedReadPaths`. Filesystem content reads reject with `FS_SANDBOX_DENIED`; Seatbelt denies named reads and bwrap masks existing files with empty content. Local process backends report `partial` with exclusions because their guarantees have [known gaps](../../../../packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work). `danger-full-access` remains unrestricted.

## Migration

1. Keep credentials behind `ctx.credentials`; remove agent workflows that inspect the managed YAML file directly.
2. Custom credential providers that store local files override `agentDeniedReadPaths` with their actual resolved absolute filenames. Providers with no local files inherit the empty list.
3. Add other protected host filenames to `deniedReadPaths` on the shared `sandbox-policy` row in `cordis.yml` or its profile patch. Relative paths fail at load. Remote providers must not interpret these host paths as remote filenames.
4. Verify a restricted filesystem read of the configured credential file returns `FS_SANDBOX_DENIED`, while an ordinary workspace read succeeds. Check the reported process enforcement and [backend limits](../../../../packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work) before treating it as secret isolation.
