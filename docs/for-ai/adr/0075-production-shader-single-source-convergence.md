# ADR 0075：Production Shader 收敛为单一生成事实源

- 状态：Accepted
- 日期：2026-08-16
- 修订：ADR 0051、0052、0059 的收敛执行边界

## 决策

1. 每个 production family 只能有一个可修改的 source owner；WGSL、reflection、binding/layout、varying 与 artifact metadata 必须由同一次确定性生成派生。
2. 受信任 WGSL source module 可以继续作为 authoring input，但其结构化 reflection 必须由 compiler 解析/验证后生成，不能作为独立手写副本。禁止对 source 或生成 WGSL 做 binding、类型或函数体字符串替换。
3. Production writer 统一输出 Artifact V2。Runtime 在迁移期可读取 V1，但 Motion Blur 完成迁移后删除 V1 writer 与无消费者 reader。
4. Artifact schema/type 的权威声明归 `shader-language`；engine runtime 使用由该 schema 生成的 private runtime declaration，不独立维护一套可漂移类型。
5. GLSL ES 300 保留为 private、可选的 canonical IR portability verifier：不进入 production generation、engine bundle 或 `check:fast` 的重复全量编译；Stage 14 的真实双后端验证和精确 unsupported diagnostics 保留。
6. Shader cost gate 自动报告相对冻结 baseline 的 bytes、files、variant、pipeline 和 generation time diff。不得通过放宽预算完成收敛。
7. Compute IR 继续作为带显式副作用/dispatch 的专门化 typed program；G02 只消除重复 schema/owner，不为追求“一个接口”抹平 compute 与 render stage 差异。

## 验收

- migration manifest 对每个 production source 给出 owner/generator/artifact/target。
- runtime 不解析 WGSL/Graph，compiler 不进入 engine/player bundle。
- stale、cost、Stage 2–14、真实 WebGPU 与 packed consumer 门禁通过。
