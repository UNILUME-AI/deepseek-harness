---
description: "面向组装 UNILUME 桌面版、或排查其登录凭据存放位置的维护者的 OS 钥匙串凭据提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-keychain

[English](README.md) | 中文

## 概述

`dsh-credentials-keychain` 把 UNILUME 桌面版的三条凭据存进 OS 钥匙串（macOS 钥匙串、Windows 凭据管理器），不再放在明文凭据文件里：引用 `UNILUME_MODEL_TOKEN`，以及记录 `unilume-desktop/default` 和 `client-connection/browser-session`。其余凭据照旧存在 `.credentials.yaml`，行为与本提供方所继承的 [`dsh-credentials-local`](../credentials-local/README.zh.md) 完全一致。启动时，它把这三条凭据从已有文件中迁出；钥匙串调用失败后，新值只放在内存中，重启即丢失。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在桌面版组合中用它替换 `dsh-credentials-local`，作为 `credentials` 服务加载。消费方照旧使用 `ctx.credentials`，无需任何改动。

### 设置

```yaml
- id: credentials
  name: '@deepseek-ai/dsh-credentials-keychain'
```

它接受与 [`dsh-credentials-local`](../credentials-local/README.zh.md) 相同的配置字段。

### 哪些凭据进钥匙串

| 凭据 | 钥匙串账户名 | 存储内容 |
|---|---|---|
| 引用 `UNILUME_MODEL_TOKEN` | `UNILUME ref UNILUME_MODEL_TOKEN` | 值本身 |
| 记录 `unilume-desktop/default` | `UNILUME record unilume-desktop/default` | 记录的 JSON |
| 记录 `client-connection/browser-session` | `UNILUME record client-connection/browser-session` | 记录的 JSON |

所有条目的服务名都是 `UNILUME dsh credentials`。Windows 凭据管理器把条目命名为 `<账户名>.<服务名>`，因此每个条目名都以 `UNILUME` 开头。`resolve` 和 `describe` 报告来源 `keychain`；`listRecords` 和 `describeRecord` 会列出钥匙串中的记录，但不带值。对 `UNILUME_MODEL_TOKEN`，启动环境仍然优先，两个 `.env` 文件仍排在钥匙串之后。

### 从已有文件迁出凭据

启动时，提供方把 `.credentials.yaml` 中找到的这三条凭据逐条写进钥匙串，再逐条读回并与文件中的值比对。只有全部一致，它才改写文件、去掉这几条，并删除同目录下的 `.credentials.yaml.bak-*` 备份和残留的 `.credentials.yaml.*.tmp` 文件。任何一步失败，文件保持原样并继续提供这几条凭据，下次启动再试。

### 可能出错的地方

- **钥匙串不可用**——第一次调用失败时，记录一条带原始错误的警告，并把这三条凭据切换到进程内存，触发失败的操作也在内存中完成。之后的读、写、删、描述和列举都走内存，不重试钥匙串，也不重复警告。不写凭据文件或临时文件。内存值在重启后丢失，用户需要重新登录；新进程照常先试钥匙串。尚未迁移的文件条目继续提供值，直到本次进程内的内存改写或删除覆盖它；文件和备份保持原样，留待下次迁移。
- **条目超过 2560 个 UTF-8 字节**——写入在调用后端之前拒绝，内存模式也一样。这类输入错误不会把钥匙串标为不可用。
- **登出**——钥匙串可用时，`unset` 和 `deleteRecord` 删除钥匙串条目以及文件里仍残留的副本。内存模式下，它们删除内存值，并在本次进程内隐藏尚未迁移的文件值，文件保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方子类：钥匙串分流、启动迁移、钥匙串错误上报，以及 `@napi-rs/keyring` 后端 |
| — | 不发布运行时不变量配套：钥匙串与文件是两个独立的存储，不存在可由第二次观察核对的自有关系。 |

### 写入与文件锁

这三条凭据的写入和删除，跑在文件存储的操作队列上。钥匙串可用时，还会持有它的 `<文件>.lock` 写锁，重读文件、提交到钥匙串，再以原子改写去掉文件副本。尚未迁移的文件值优先于钥匙串条目，因为下一次迁移会用它覆盖该条目。钥匙串调用失败后，修改仍在队列中串行执行，但跳过文件锁和文件改写；内存条目覆盖文件值，删除标记防止文件旧值重新出现。迁移只接受经过读回校验的 OS 钥匙串写入，不接受内存副本。

### 记录文本

记录在钥匙串中的文本是 `JSON.stringify(record)`。读取时经文件存储的严格文档解析器准入；写入时，若记录的 JSON 文本解析回来与原值不相等则拒绝，所以 `Date`、类实例或非有限数会像在文件中一样被拒绝。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件凭据提供方](../credentials-local/README.zh.md)——本提供方继承的存储及其保留的全部行为。
- [凭据引用接缝](../credentials/README.zh.md)——两个提供方共同实现的操作。
- [原子写](../../util/atomic-write/README.zh.md)——写锁与原子替换。

-----

<a id="model-experience"></a>
## 模型体验

间接影响：经由 `ctx.credentials` 的消费方，由它们负责存储值所带来的任何面向模型的行为。

#### KV Cache 影响

不直接造成失效；存储的值从不进入请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **其他进程对钥匙串的改动不发事件**——钥匙串可用时，每次读取都直接查询；但 `credentials/reference-updated` 和 `credentials/record-updated` 只对本进程的写入和文件变化触发。内存值只属于当前提供方实例。
- **凭据集合是固定的**——这三条凭据是 UNILUME 桌面版的常量，不是配置项。
- **文件仍是禁读路径**——`agentDeniedReadPaths` 照旧列出 `.credentials.yaml`，因为其余凭据仍在其中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

打包后的桌面版仍需证明：在 macOS 和 Windows 上签名后，预编译的 `@napi-rs/keyring` 二进制能够加载；升级并重启之后，系统不会再次弹出钥匙串访问确认。

</details>
