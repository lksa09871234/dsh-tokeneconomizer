# dsh-tokeneconomizer

[English](README.md) | [简体中文](README.zh-CN.md)

适用于 DeepSeek Harness（DSH）的插件，将 [Microsoft TokenEconomizer](https://github.com/microsoft/TokenEconomizer) 的跨会话成本控制方法移植到 DSH：学习可靠的项目知识、减少未使用的工具定义、识别重复失败循环，并记录宿主实际报告的 token 用量。

这是独立的社区开源移植项目，**不是 Microsoft 官方产品**。参见[来源与许可](#来源与许可)。

## 为什么需要它

编码代理在同一项目的不同会话中，可能反复探索相同的环境问题、重复发送未使用的工具定义，或陷入相同的失败循环。本插件沿用 TokenEconomizer 的方法，利用跨会话证据减少这些重复工作。

| 机制 | 本插件的行为 |
| --- | --- |
| **微技能（Micro-skills）** | 从多次会话中重复出现的“失败后找到有效方法”模式学习环境知识，在后续会话注入简短、有长度上限且标明来源的提示。模型辅助学习默认关闭。 |
| **工具裁剪（Tool pruning）** | 统计工具定义已加载但未被使用的情况。默认只提出建议；明确应用后，通过 DSH 的代理级工具限制，从当前项目的模型请求中隐藏相应工具定义。 |
| **循环守卫（Loop guard）** | 检测相同失败、反复修改和缺乏进展的回合。只进行有限次数的重定向，随后记录提示，**不会自行终止任务**。可选模型判断有频率限制，也可以关闭。 |
| **用量账本（Usage ledger）** | 记录 DSH 报告的未缓存输入、缓存读取、缓存写入、输出以及插件自身模型调用的开销。不虚构价格、费用或节省比例。 |

## 功能与验证状态

- **单元测试通过**：离线、确定性的机制测试通过。
- **离线集成验证通过**：真实 DSH 包配合模拟模型适配器，验证事件、请求及持久化路径；不等于真实模型效果已经验证。
- **待手动验证**：需要在真实模型账户或交互式界面中验证，步骤见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 在真实 DSH profile 中加载 | 离线集成验证通过 | 在隔离的 `DSH_HOME` 中原生安装并启动，确认插件组合及加载标记。 |
| 环境知识的形成、晋升、撤回及项目隔离 | 单元测试通过 | 基于重复证据，矛盾会使知识失效；项目按会话的 `cwd` 区分。 |
| 将知识注入模型上下文 | 离线集成验证通过 | 从首个模拟模型请求中验证带边界及来源说明的系统提示区块。 |
| 模型辅助知识提议 | 调用链验证通过，真实质量待验证 | 默认关闭；其用量计入插件额外开销。 |
| 工具裁剪提案 | 单元测试通过 | 默认要求 10 个未使用提示跨至少 2 个会话，或至少 5 个会话的证据。 |
| 应用工具裁剪 | 离线集成验证通过 | 验证工具定义从发送的请求及持久化 `request/header` 中消失，而全局工具注册表保留。 |
| 还原与受保护工具 | 离线集成验证通过 | 还原的工具不再被自动提议裁剪；受保护工具不会被隐藏。 |
| 循环判断规则及正常回合基线 | 单元测试通过 | 移植上游阈值、预设及决策顺序。 |
| 回合内重定向 | 离线集成验证通过 | 重复失败时只引导一次，回合继续完成，不被取消。 |
| 面向用户的“仍然卡住”提示 | 待手动验证 | headless 路径没有插件到用户的通知渠道，提示保存在状态和日志中。 |
| 用量及插件开销 | 离线集成验证通过 | 核对账本与模拟提供方报告的 token 分类；缺失数据标记为未知。 |
| slash command 与 `te` CLI | 注册表及打包 CLI 已验证 | 交互式 TUI 和 Web 命令界面尚未手动验证。 |
| 平台 | 部分验证 | 本地 Windows 11 / Node 24 已验证；GitHub Actions 在 Linux 执行离线测试；macOS 及各平台交互式 TUI 尚未验证。 |

当前版本的 **343 项单元测试、10 项集成测试、JSDoc 类型检查、打包检查和打包后 CLI 冒烟测试**已通过。DSH rc.2 和 rc.3 的离线测试已通过 GitHub Actions。真实模型质量、实际节省比例以及交互式 TUI 行为尚未验证。

## 环境要求

- **DSH**：声明兼容 `^0.2.1-rc.2`；已验证 CLI `0.2.1-rc.2` 及 `0.2.1-rc.3` 包的对应代码路径。
- **Node.js 24 或以上**。
- **不需要 Python**：本插件以 JavaScript 移植核心机制，不运行上游 Python 插件。
- 不需要单独的模型 API key。可选模型调用通过当前 DSH 会话已有的模型路由和账户执行，消耗正常额度。
- 插件没有独立的网络分析服务或遥测；可选的知识提议和循环判断仍会通过 DSH 调用模型。

## 安装

本插件使用 DSH 原生插件机制，在 `package.json` 中通过 `dsh.bundle.patch` 声明 profile 补丁。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile my-profile add dsh-tokeneconomizer
dsh --profile my-profile
```

npm 页面：[dsh-tokeneconomizer](https://www.npmjs.com/package/dsh-tokeneconomizer)。将 `my-profile` 替换为实际使用的 profile；如需固定版本，可使用 `dsh-tokeneconomizer@0.1.0`。

### 从 GitHub Release 安装

从 [v0.1.0 Release](https://github.com/lksa09871234/dsh-tokeneconomizer/releases/tag/v0.1.0) 下载 `dsh-tokeneconomizer-0.1.0.tgz`，将路径替换为实际下载位置：

```sh
dsh plugin --profile my-profile add /absolute/path/to/dsh-tokeneconomizer-0.1.0.tgz
dsh --profile my-profile
```

Windows PowerShell 示例：

```powershell
dsh plugin --profile my-profile add "C:\path\to\dsh-tokeneconomizer-0.1.0.tgz"
dsh --profile my-profile
```

`my-profile` 应替换为你实际使用的 profile。GitHub Release 页面提供 SHA-256，可用于校验下载文件。

### 从源码安装

```sh
git clone https://github.com/lksa09871234/dsh-tokeneconomizer.git
dsh plugin --profile my-profile add "$PWD/dsh-tokeneconomizer"
dsh --profile my-profile
```

`dsh plugin add` 在指定 profile 内通过 pnpm 安装，并将插件加入 `<DSH_HOME>/profiles/<profile>/package.json` 的 `dsh.profile.bundles`。

GitHub Release 和源码安装仍然可用，不依赖 npm 安装方式。

### 使用隔离的测试环境

建议先在测试 profile 中体验。可以将 `DSH_HOME` 指向单独的目录，避免影响日常配置。

Linux / macOS：

```sh
export DSH_HOME="$PWD/.dsh-test-home"
dsh --profile te --from-default-profile headless --dump-config
```

Windows PowerShell：

```powershell
$env:DSH_HOME = "$PWD\.dsh-test-home"
dsh --profile te --from-default-profile headless --dump-config
```

上述命令仅初始化并显示 profile 配置；还需要向该 profile 安装插件并实际启动，才能验证加载。`DSH_HOME` 的设置作用于当前终端及其后续子进程。

## 快速开始

安装并重启 profile 后，正常在同一项目中工作。没有足够证据前不会注入知识；微技能默认关闭，需要时主动启用。

以下命令输入到支持 slash command 的 DSH 会话：

```text
/tokeneconomizer status
/tokeneconomizer microskills
/tokeneconomizer microskills forget <fact-id>
/tokeneconomizer toolprune
/tokeneconomizer usage
```

按当前项目调整功能：

```text
/tokeneconomizer config set microskills=envfacts
/tokeneconomizer config set toolprune=propose
/tokeneconomizer config set loopguard=on
```

`envfacts` 只使用确定性环境知识；`microskills=on` 还会启用模型辅助提议。

主动应用或还原工具裁剪：

```text
/tokeneconomizer toolprune apply
/tokeneconomizer toolprune restore
```

应用后，相关项目的后续代理／会话会省略被裁剪的工具定义。显式应用也会更新当前代理的限制，但不会改写正在发送的请求。还原的工具不再被自动提议裁剪。

### 在终端查看状态

插件附带 CLI，可在不启动模型调用的情况下查看或修改状态。从插件源码目录运行，并用 `--cwd` 指定要查看的项目：

```sh
node bin/te.js --cwd /absolute/path/to/project status
node bin/te.js --cwd /absolute/path/to/project microskills
node bin/te.js --cwd /absolute/path/to/project toolprune
node bin/te.js --cwd /absolute/path/to/project usage
```

如果不传 `--cwd`，CLI 使用当前目录。CLI 不会自动读取 profile 的 YAML 默认值；需要与会话一致时，应核对项目配置及 `TE_*` 环境变量。

## 设置

设置保存在插件自身的状态目录中，不写入你的项目文件。profile 补丁设置默认值，`/tokeneconomizer config set` 修改当前项目设置，`TE_*` 环境变量可覆盖当前进程的设置。

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 整个插件的开关，也可设置 `TE_DISABLE=1`。 |
| `dataDir` | `""` | 状态目录；空值表示 `<DSH_HOME>/tokeneconomizer`。 |
| `microskills` | `off` | `off`、只使用确定性知识的 `envfacts`，或加入模型辅助提议的 `on`。 |
| `toolprune` | `propose` | `off`、只提案的 `propose`，或允许应用的 `apply`。 |
| `loopguard` | `on` | `off` 或 `on`；只重定向，不停止工作。 |
| `microskillsProposeEvery` | `3` | 模型知识提议之间的会话数。 |
| `microskillsMaxChars` | `600` | 注入提示的字符数上限。 |
| `microskillsMaxFacts` | `4` | 注入知识条数上限。 |
| `toolpruneEvidence` | `10` | 提案前要求工具未使用的提示数。 |
| `toolpruneMinSessions` | `2` | 上述提示至少跨越的会话数。 |
| `toolpruneSessions` | `5` | 单独构成证据的会话数。 |
| `toolpruneQuietMinutes` | `60` | 应用列表变更前要求的空闲分钟数。 |
| `protectedTools` | `[]` | 不允许裁剪的额外工具清单。 |
| `loopguardEnvelopeMinSamples` | `5` | 形成正常回合基线前要求的样本数。 |
| `loopguardJudgeConfidence` | `0.7` | 可选模型判断的置信度阈值。 |
| `loopguardNudges` | `1` | 每个回合最多重定向次数。 |
| `loopguardBackstopMultiplier` | `2.5` | 无模型判断时使用的兜底倍数。 |
| `loopguardJudge` | `true` | 是否允许模型辅助判断；关闭后仅使用规则。 |
| `usageRecord` | `true` | 记录 DSH 实际报告的用量。 |
| `diagnosticsRecord` | `true` | 将错误写入脱敏诊断记录，避免向宿主抛出。 |

常用环境变量：`TE_MICROSKILLS=on`、`TE_TOOLPRUNE=apply`、`TE_LOOPGUARD=off`、`TE_LOOPGUARD_JUDGE=off`、`TE_DISABLE=1`。多词配置使用显式下划线名称，例如 `TE_MICROSKILLS_PROPOSE_EVERY`；完整对应关系见 [lib/config.js](lib/config.js)。

循环守卫默认允许模型判断，触发时可能产生额外模型开销；如不需要，设置 `loopguardJudge=false` 或 `TE_LOOPGUARD_JUDGE=off`。

## 更新

源码路径安装使用 pnpm 本地链接，更新源码并重启 profile：

```sh
git -C /absolute/path/to/dsh-tokeneconomizer pull
dsh --profile my-profile
```

安装包方式则下载新版本，并重新执行 `dsh plugin --profile my-profile add <新安装包路径>`，随后重启 profile。

## 卸载

```sh
dsh plugin --profile my-profile remove dsh-tokeneconomizer
```

重启 profile 后插件停止加载。卸载默认保留学习状态。

如确实需要删除某个项目的学习状态，可在插件源码目录执行：

```sh
node bin/te.js --cwd /absolute/path/to/project reset --yes
```

这会删除该项目的知识、证据及账本。若要清空所有项目的插件数据，可自行删除 `<DSH_HOME>/tokeneconomizer`，操作前请确认目录及需要保留的记录。

## 已知限制

- **工具裁剪主要在代理创建时生效**：显式应用可更新当前代理，但不改写进行中的请求，以避免破坏 DSH 的提示词／工具前缀缓存。
- **裁剪不是权限隔离**：它影响模型可见的工具定义，不改变 DSH 的权限和审批策略。
- **“仍然卡住”通知渠道有限**：headless 或没有命令界面的会话将提示保存在状态和日志中；模型端重定向使用 DSH steering。
- **模型辅助学习是有记录的简化移植**：提议仅从摘要生成，证据至少来自两个被引用的会话；不包含上游完整的 extractor DSL 和逐任务 detector replay。连续三个会话未匹配检查的模型笔记会撤回。
- **用量不是费用**：只记录 DSH 报告的 token 分类；没有内嵌价格，不宣称节省百分比，缺失数据标记为未知。
- **微技能默认关闭**：确定性学习主要适用于反复遇到环境问题的项目，不能保证对所有工作都有收益。
- **循环守卫需要基线样本**：新项目不会立即被干预。
- **交互式 TUI、真实模型质量及实际节省效果尚未验证**：Windows 本地及 Linux CI 的离线结果不能代替这些验证；macOS 也未在本地测试。

## 开发与验证

```sh
npm ci
npm run verify
```

`verify` 包含类型检查、单元测试、离线集成测试、打包检查及打包后 CLI 冒烟测试。

```sh
npm run pack:check
npm run pack:smoke
npm pack
```

真实模型手动验证步骤和验收条件见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。比较用量前后变化时，应保持任务和环境可比，并同时比较完成质量，见 [docs/MEASUREMENT.md](docs/MEASUREMENT.md)。

## 文档

- [架构与数据流](docs/ARCHITECTURE.md)
- [移植范围与上游对照](docs/PORTING.md)
- [验证证据及手动测试](docs/VERIFICATION.md)
- [用量比较方法](docs/MEASUREMENT.md)
- [上游来源](docs/UPSTREAM.md)
- [安全说明](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [更新记录](CHANGELOG.md)

上述深入文档目前以英文为主。

## 来源与许可

本项目基于 [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer) 的提交 `e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9`（Apache-2.0，[论文](https://arxiv.org/abs/2610.22732)）。核心机制以 JavaScript 重新实现，DSH 适配层为新增代码。

项目采用 **Apache License 2.0**。上游许可及必要声明保留在 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目不是 Microsoft 官方产品，也未获其赞助或背书。

## 发布说明（维护者）

1. 从干净 checkout 执行 `npm ci` 和 `npm run verify`。
2. 推送 `main`，等待 GitHub Actions 全部通过。
3. 为验证过的提交创建带注释的版本 tag，使用对应 release notes 创建 GitHub Release。
4. 附上 `npm pack` 生成的安装包；不要直接压缩包含 `node_modules` 或本机状态的工作目录。
5. npm 发布是单独的可选步骤，发布前先执行 `npm run pack:smoke`。

README 翻译和后续文档修改在 `main` 上更新；既有 v0.1.0 tag 及 Release 安装包保持不变。
