# Variant、Capability 与 Pipeline Key

## 参数分类

每个可配置值必须属于一种且只能属于一种分类：

| 分类 | 进入 shader key | 运行时更新 | 用途 |
| --- | --- | --- | --- |
| `dynamic` | 否 | uniform/resource/state | 颜色、强度、roughness、时间、纹理内容 |
| `specialization` | 是 | 需要新 shader/pipeline | 会删除大段代码、改变 entry/interface/layout 的静态选择 |
| `capability` | 是 | 由设备/profile/renderer 决定 | derivative、storage、compute、target format 等能力 |

普通布尔开关默认是 dynamic。只有满足下列条件之一才允许 specialization：

- 改变 resource/layout 或 pass requirement；
- 关闭后可删除显著代码或循环；
- 目标语言要求编译期常量；
- 设备 capability 决定合法性。

纹理是否有内容通常通过 fallback texture 和 dynamic flag 表达，不应自动制造 variant。variant planner 必须解释每个 specialization 的来源。

## Capability Profile

阶段 0 固定三个 profile：

- `webgpu-portable`：WebGPU 基础产品路径，WGSL backend 的默认目标。
- `webgpu-enhanced`：显式依赖可选 WebGPU feature/limit；不可静默落回 portable。
- `webgl2-compatible`：GLSL ES 300 可行性子集；不代表 renderer fallback 已实现。

每个 node/module 声明 `requires`、`provides` 和 `conflicts`。capability resolution 产生以下之一：

- `supported`：直接编译；
- `degraded`：使用模块明确声明、像素门禁覆盖的替代实现；
- `unavailable`：精确失败，列出 node、feature、profile 和原因。

编译器不得把 unavailable feature 删除后继续，也不得把 WebGPU-only raw module 当作 portable。

## Canonical Key

shader key 至少包含：

```text
IR schema version
compiler semantic version
canonical module/node graph
specialization values
resolved capability profile
target backend
entry point/pass kind
resource layout
vertex semantics/layout requirements
```

pipeline key 在 shader key 基础上增加 render state、attachment format、sample count、depth mode、primitive topology 和 renderer-defined compatibility state。

以下内容不能进入 shader key：uniform 当前数值、texture 内容、entity id、frame id、GPU object identity。

## Variant 预算

阶段 0 不凭空提高现有预算，pilot 使用以下规则：

1. PBR clearcoat × transmission 在等价输入下最多保留现有 4 个 specialization 组合。
2. normal map、Fog、渐变、噪声强度和普通 texture presence 不得继续乘 variant。
3. 一个 pilot material family 的 compiled variant 数不得超过 8；超过即 no-go，除非用测量和 ADR 提升预算。
4. compiler report 必须输出 theoretical combinations、reachable variants、实际编译数、cache hit/miss 和每个维度来源。
5. 同一 canonical graph 和 profile 必须产生字节稳定 key；node 插入顺序不同但语义规范化相同的 graph 应产生同一 key。

## 编译与缓存策略

- built-in graph：构建期生成，产物进入 engine bundle 和现有 shader pixel gate。
- 用户 graph：运行时或编辑器 Worker 编译，结果按 compiler version + canonical hash 缓存。
- pipeline warmup：只预热场景可达 variant；不能枚举理论笛卡尔积。
- superseded request：编辑器连续修改采用 latest-wins，旧编译结果不能覆盖新 graph。
- device lost：源码/IR cache 可保留，GPU module/pipeline cache 必须按 device owner 重建。

阶段 2 必须记录 IR generation、backend codegen、browser compilation 和 first-use pipeline 的分段耗时，不能把所有时间合并成一个不可归因的 compile 指标。
