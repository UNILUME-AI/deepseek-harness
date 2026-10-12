---
kind: upgrade-guide
description: "浏览器操作调用方必须把 providerName 改为 providerNames，并处理零个或多个提供方。"
---

# 浏览器操作提供方名称

[English](guide.md) | 中文

## 变更

`ctx.browserUse.providerName` 替换为 `ctx.browserUse.providerNames`，后者是按注册顺序排列的已注册提供方名称只读数组。组合可以注册多个不同名称的提供方；没有已注册提供方时数组为空。原 getter 的调用方必须处理零到多个提供方。注册及清理语义见[浏览器操作服务](../../../../packages/browser-use/browser-use/README.zh.md)。

## 迁移

1. 在提供方选择和可用性代码中，把 `ctx.browserUse.providerName` 的读取改为 `ctx.browserUse.providerNames`。
2. 把空数组作为没有已注册提供方处理。存在一个或多个名称时，遍历提供方或选择明确的名称；不要假定第一个元素存在或代表唯一提供方。
3. 分别用零个、一个和两个不同提供方验证调用方。确认选择使用预期名称，且释放注册后该名称从数组中移除。
