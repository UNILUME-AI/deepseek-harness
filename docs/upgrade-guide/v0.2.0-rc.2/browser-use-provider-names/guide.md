---
kind: upgrade-guide
description: "Browser-use callers must replace providerName with providerNames and handle zero or multiple providers."
---

# Browser-use provider names

English | [中文](guide.zh.md)

## Change

`ctx.browserUse.providerName` is replaced by `ctx.browserUse.providerNames`, a readonly array of registered provider names in registration order. Compositions can register multiple providers with distinct names; the array is empty when none are registered. Callers of the former getter must handle zero to multiple providers. See the [browser-use service](../../../../packages/browser-use/browser-use/README.md) for registration and cleanup semantics.

## Migration

1. Replace reads of `ctx.browserUse.providerName` with `ctx.browserUse.providerNames` in provider-selection and availability code.
2. Handle an empty array as no registered provider. For one or more names, iterate over the providers or select an explicit name; do not assume the first element is present or the sole provider.
3. Verify the caller with no registered provider, one provider, and two distinct providers. Confirm selection uses the intended name and disposal removes that name from the array.
