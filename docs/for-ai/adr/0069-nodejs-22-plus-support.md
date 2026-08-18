# ADR 0069：Node.js 支持范围为 22 及以上

- 状态：Accepted
- 日期：2026-08-07
- 影响：公共 package metadata、仓库工具、CI 与 CPU evidence

## 背景

首发候选曾把公共 package `engines` 和正式 CPU evidence runner 限制为 Node.js 22 主版本。这个上限会让 Node.js 23、24 及后续版本在 API、构建和发布工具本身仍兼容时被无条件拒绝，也与公共 consumer 只需要明确最低版本的目标不符。

CPU benchmark 的可比性不依赖“永远使用 Node 22”，而依赖 artifact 记录精确 Node/V8、平台、CPU、runner、采样配置和 revision，并且只在这些身份一致时执行相对比较。

## 决策

1. HaiYue 仓库工具、CLI 和两个首发公共 npm package 的最低 Node.js 版本为 22，不设置最高主版本；根目录与公共 package 的 `package.json#engines.node` 统一为 `>=22`。
2. `.node-version` 保留 `22`，表示仓库默认和最低开发版本，不表示禁止更高版本。CI 可以继续用该默认版本执行主门禁。
3. Release manifest、README、Guide、贡献文档和 active milestone contract 统一使用 Node.js 22+ / `>=22` 表述。
4. CPU baseline promotion 与 candidate validator 接受所有 Node.js 主版本 >=22。Artifact 继续绑定精确 Node/V8 身份；Node/V8 不一致时相对比较必须为 `ineligible`，绝对和结构预算仍照常执行。
5. 固定 Apple runner、clean revision、full workload、至少三轮独立 cohort 和 artifact validator 要求保持不变。扩大 Node 支持范围不降低 evidence 质量。

## 后果

- Node.js 24 等更高版本可以运行构建、CLI、package consumer 和候选验证，不再触发人为的 `<23` 或主版本等于 22 限制。
- 不同 Node/V8 版本的性能结果不会被直接当作同身份回归证据；需要在目标版本上重新生成同身份 baseline 才能启用相对比较。
- 默认 CI 只选择一个受控版本不等于公共 `engines` 存在上限。

## 验证

- `npm run release:scope:check`
- `npm run docs:check`
- `npm run api:check`
- `node --test scripts/performance-candidate-policy.test.mjs scripts/benchmark/cpu-benchmark-policy.test.mjs`
- `npm run verify:engine-package`
