# ADR 0077：Versioned WorkerChannel 与统一 Async Ownership

- 状态：Accepted
- 日期：2026-08-16

## 决策

1. engine private async substrate 提供共享 `WorkerChannel`：versioned plain-data envelope、unknown validation、transferables、AbortSignal、latest-wins generation、bounded queue、`error`/`messageerror` fault retirement 和幂等 dispose。
2. abort error、priority normalization 与 monotonic clock 由同一 private helper 拥有；consumer 继续附加自己的 EngineError domain、path、hint 和 context。
3. Worker source/URL 属于具体 capability；channel 不 import glTF、Spine、KTX2 或 engine facade。extensions 通过 focused experimental engine export 消费 plain contract，不相对导入 engine private source。
4. Owner dispose、abort、worker fault 或 device loss 后，迟到 fetch/decode/reply/upload 不得写回或创建新资源。主线程 fallback 只有在 capability contract 明确允许时使用，并产生结构化 diagnostic。
5. AssetJob 是 phase/progress 的唯一状态 owner；AssetManager、scheduler 与 parser 不直接写 job 内部字段。
6. KTX2/gltf/Spine 至少各迁移一个真实路径；无消费者 helper、循环 self-import 和重复状态机在迁移后删除。

## 验收

- failure injection 覆盖 abort-before-send、abort-in-flight、late reply、worker error、messageerror、queue overflow、dispose 与 base-path/packed consumer。
- owner residual、listener 和 Worker 数量回到零。
