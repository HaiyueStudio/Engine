# 架构与所有权

## 目标

Haiyue Shader Language 把 shader 的“意图”与目标语言源码分开。系统必须解决五类问题：

1. 模块、符号和依赖可以组合，而不是通过字符串片段约定顺序。
2. 材质节点使用明确的 stage、数值类型和坐标空间。
3. 资源布局、CPU packing、pipeline layout 与 shader 声明来自同一份 schema。
4. 主渲染、depth、shadow、motion-vector 等 pass 复用同一份顶点变形事实来源。
5. 同一个 IR 可以产生确定性的代码、reflection、diagnostic 和 pipeline key。

## 分层

```text
TypeScript DSL ─┐
Shader Graph ───┼─> Frontend normalization ─> Typed Shader IR
Future text DSL ┘                                  │
                                                   ├─> validation
                                                   ├─> resource/varying allocation
                                                   ├─> constant fold + DCE + CSE
                                                   ├─> variant planning
                                                   ├─> WGSL backend
                                                   ├─> GLSL ES 300 backend (portable subset)
                                                   └─> target reflection + source map
```

`Typed Shader IR` 是唯一规范表示。任何 frontend 都不能直接生成 renderer-specific WGSL，也不能拥有独立的类型、资源或 variant 规则。

## 模块职责

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| Frontend | 把 TS DSL 或 graph JSON 规范化为 IR | binding 分配、目标源码生成 |
| IR | 类型、表达式、函数、stage、space、资源请求和源位置 | GPU 对象、渲染调度 |
| Validator | 类型、stage、space、capability、循环和资源限制 | 浏览器 shader 编译 |
| Composer | 解析 requires/provides/conflicts，合并模块和语义槽位 | 任意字符串插入 |
| Allocator | varying、attribute、logical resource space 和 uniform layout | 资源生命周期 |
| Optimizer | 常量折叠、dead-code elimination、公共表达式复用 | 改变可观察的数值语义 |
| Backend | 从合法 IR 生成目标源码与 source map | 猜测 renderer fallback |
| Reflection | 描述 entry point、资源、layout、语义、capability 和 variant | 创建 GPU 资源 |
| Runtime adapter | 根据 reflection 创建 layout、packer、pipeline key | 修改 graph/IR |
| Render graph | 安排 transmission、blur 等额外 pass | 编译 shader 表达式 |

## 编译顺序

规范编译顺序固定为：

1. 解析并校验 frontend 格式。
2. 展开模块依赖，检测 cycle、重复 id 和冲突 capability。
3. 类型推导并插入显式允许的 scalar splat；禁止隐式数值种类转换。
4. 验证 stage、坐标空间、derivative、控制流和资源访问。
5. 解析材质语义槽位与 pass requirements。
6. 生成跨 stage varying，分配 attribute/resource/uniform layout。
7. 执行保持语义的优化。
8. 计算 canonical IR hash 和 variant key。
9. 生成目标源码、reflection 和 node-to-source-map。
10. Runtime 使用 reflection 创建或复用 pipeline；GPU 编译信息映射回 node/module。

任何会影响输出源码、资源布局或 pipeline compatibility 的输入必须进入 canonical hash。普通 uniform 数值不得进入 shader/pipeline key。

## 与当前引擎的关系

现有 `engine/src/shader/WgslFeatureComposer.ts` 继续服务明确保留的 raw WGSL 逃生口。阶段 1 的 private Composer 2.0 提供模块/资源基础；阶段 2 的 Typed Expression IR 和 WGSL backend 是唯一 authoring 规范；阶段 3 Graph v1 也只能降到该 IR，再经 MaterialSurface/PBR lowering。阶段 6 起，已通过全部门禁的内置 shader 可以生成 checked-in precompiled artifact，由 engine 私有 reflection adapter 消费；阶段 7 的 Artifact V2 支持多个 physical group，并显式区分 artifact-owned 与 renderer-owned layout。阶段 8–13 的 production family 是 compiler-owned 标准库登记表，不是第二套通用 IR，也不接受源码字段。阶段 14 的 GLSL ES 300 backend 直接消费 Typed IR，但只验证 portable vertex/fragment subset；compiler 仍不进入 runtime。source factory 只作为 WGSL backend 到 Composer 的内部适配层，不能向 graph/用户暴露或继续扩张成字符串宏系统。

迁移遵守以下规则：

- 新系统先从 private/experimental 边界接入，不进入根黄金路径。
- 同一 renderer 在一个 pilot 内只有一个 shader 事实来源；不长期维护新旧两套功能分支。
- 每个迁移必须保留现有 Material API，除非另有 breaking-change ADR。
- 内置 shader 优先构建期编译；用户 graph 才需要运行时编译和缓存。
- 构建期产物必须由 deterministic stale gate 管理；完成迁移后删除对应手写 WGSL，不保留双实现。
- 失败必须保留旧生产路径，不能静默生成不完整 shader。

## 多后端边界

WGSL 是生产 backend。GLSL ES 300 backend 已完成受限 vertex/fragment 可行性验证：它直接消费 IR，拥有独立 std140 reflection，并对 compute/storage 等能力精确拒绝；这不代表 WebGL2 renderer 已存在。

IR capability profile 负责拒绝目标无法表达的 shader；renderer 负责 storage buffer、compute、indirect draw、texture format、pass 和资源生命周期的降级。shader backend 不得伪造 renderer capability。

## 阶段 0 完成条件

- 类型、stage、坐标空间、材质 surface、资源 ABI、variant 和 escape hatch 均有单一规范。
- graph v1 和 reflection v1 有机器可读 schema。
- 三个 pilot 的输入、pass、指标和 no-go 条件明确。
- WebGPU-only 现状与 GLSL 可行性目标没有语义冲突。
- `npm run shader-language:check` 接入 fast gate。
