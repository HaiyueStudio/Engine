# ADR 0042：Animation3D 候选 facade 采用来源无关契约与封闭运行时

- 状态：Accepted
- 日期：2026-07-25
- 影响：稳定 `@haiyue/extensions/animation3d`、`@haiyue/extensions/gltf-animation3d` 子入口、编辑器动画状态机与 3D 动画运行时

## 背景

glTF loader 内部已经能够解析并播放 translation、rotation、scale 和 morph weights，但其 Clip、Channel、Target 与采样缓存都是 glTF 专用结构。交叉淡化、分层混合、状态机和其他动画来源需要一个不依赖 glTF schema、ECS 具体类或资产加载实现的公共语言。

Animation3D 的 Clip、Pose、Mixer 和状态机运行时现已实现，glTF adapter 也已经通过真实角色 WebGPU fixture 验证根 TRS、skinning joint 与 GPU morph 的 cross-fade。本次评审把此前候选 facade 发布为稳定 package 子路径，并继续用白名单、错误语义和声明边界限制其增长。

## 决策

### 1. 包边界与公开白名单

来源无关 facade 是 `extensions/src/animation3d.ts`，稳定发布为 `@haiyue/extensions/animation3d`。glTF 转换和模型绑定单独发布为 `@haiyue/extensions/gltf-animation3d`，不并入 extensions 根入口，也不扩大基础 `@haiyue/extensions/gltf` 的加载职责。

`@haiyue/extensions` 当前仍沿用仓库既有的 `private: true` 发布策略。本次不擅自改变 workspace 的发布属性；Rollup 产物、package exports、类型测试和 API baseline 仍把两个子路径作为稳定契约管理。一旦 extensions 进入 registry 发布流程，只需由包发布策略单独解除 private，不需要再次设计 Animation3D API。

公开能力只包括：

| 分组 | 公开表面 |
| --- | --- |
| Clip / Track / Binding | 不可变 `Animation3DClip`、`Animation3DTrack`、`Animation3DBinding` 及其必要的描述类型 |
| Pose | `Animation3DPose`、`Animation3DMutablePose`、`Animation3DPoseBuffer`、`Animation3DPoseApplier` |
| Action / Mixer | `Animation3DAction` 契约、`Animation3DMixer` facade 及其必要的选项与状态类型 |
| 状态机定义 | 参数、state、transition、layer、clip motion、1D/2D blend motion 定义 |
| 状态机运行时 | 校验、编译、opaque compiled definition、`Animation3DStateMachineController` |
| 错误 | `Animation3DError`、稳定错误码和结构化 details；状态机校验错误与结构化 issue |

以下内容明确不是公共 API：

- Track sampler、采样 cursor 和插值 scratch；
- compiled layer/state/transition/motion node、lookup map 和 blend weight helper；
- `Animation3DStateMachineMixerPort` 及其 adapter；
- Mixer 同步帧 transaction；
- Mixer-owned action runtime、action handle；
- transition counter、loop-limit debug handle；
- Animation3D 私有 resource loader、cache handle 和 source 描述。

公开 `.d.ts` 必须只引用白名单声明模块。不能通过 re-export、基类、公开成员或类型别名泄漏 `runtime/*`、共享 `animation-state-machine/*` 或未导出类型。内部旧路径可以服务内部测试和迁移，但不能从候选 facade 到达。

### 2. Clip、Track 与 Binding

1. `Animation3DClip` 是不可变、来源格式无关的 CPU 值，格式标识为 `haiyue-animation3d-clip@1`。
2. 时间单位为秒。Clip duration 必须有限且非负；Track key time 必须有限、非负、严格递增并位于 Clip duration 内。
3. Track 通过 Binding 决定值类型和分量数，不保存 glTF accessor、sampler、node index 或 GPU 对象。
4. v1 支持 scalar、vec2、vec3、vec4、quaternion 和可变长度 morph weights。translation/scale 固定为 vec3，rotation 固定为 XYZW quaternion。
5. 插值支持 `step`、`linear`、`cubic-spline`。step/linear values 布局为 `keyCount * valueSize`；cubic-spline 每个 key 使用 `[inTangent, value, outTangent]`。
6. Mixer 接纳 Clip 时一次性校验 Clip 和 Track。空 id、重复 Track id、非法格式/时间/值布局、非有限值和无效 quaternion 均在播放前拒绝。
7. `Animation3DBindingResolver` 把逻辑 Binding 映射为读写端点。Resolver revision 变化后 Mixer 和 PoseApplier 必须重新解析；解析失败不能静默写到其他目标。
8. Binding mask 按 binding id 过滤，不保存运行时对象引用。

### 3. Pose 与稳态内存

1. Mixer 不直接修改 ECS。它写入调用者提供的 `Animation3DMutablePose`，再由独立 `Animation3DPoseApplier` 应用 Binding。
2. `Animation3DPoseBuffer` 同时作为 mutable sink 和只读 pose view。`seal()` 返回自身，而不是创建 snapshot。
3. PoseBuffer 首次扩容后复用 channel record、channel 数组、event 数组和每个 channel 的 `Float32Array`。同一 buffer 的下一次 reset/evaluate 会覆盖上一帧内容。
4. 每个 Track sampler 持有一个可复用输出 scratch；不传显式输出时，重复 `sample()` 返回同一个 `Float32Array`。
5. 稳态 `update()` 不得逐帧创建 Pose、channel 数组或采样数组。需要跨帧保存结果的调用者自行复制。
6. Pose Event 记录 action id、clip id 和原始 Clip Event，只在时间游标跨越对应时刻时产生。

### 4. Action 与 Mixer

1. `Animation3DAction` 是一个 Clip 的可变播放实例，Clip 本身保持不可变。Action 的时间、timeScale、weight、loop、repetitions、mask、blend mode 和 fade 状态相互独立。
2. loop 支持 once、repeat、ping-pong；blend mode 支持 override、additive。
3. Action 只能由 Mixer 创建和拥有。相同 Clip 可创建多个 Action，但 action id 在同一 Mixer 内必须唯一。
4. `Animation3DMixer` 公开 create/get/remove action、stop all、update/evaluate/setTime 和 destroy。状态机需要的同步帧 transaction 只存在于内部 runtime。
5. Mixer 借用 Clip 值，不持有或释放外部 AssetHandle。
6. Mixer destroy 幂等，并使其 Action、时钟控制和 resolved binding cache 失效。

### 5. 统一错误语义

Animation3D 运行时使用 `Animation3DError`。调用者以 `code` 分支，`message` 用于诊断，`details` 提供稳定上下文：

| code | 语义 |
| --- | --- |
| `mixer-destroyed` | 对已销毁 Mixer 或其 Action 执行控制/求值 |
| `invalid-clip` | Clip 格式、id、duration、events 或组合结构无效 |
| `invalid-track` | Track、Binding、key time、values 或插值结构无效 |
| `invalid-action` | Action id 为空或已从活动 Mixer 移除 |
| `duplicate-action-id` | 同一 Mixer 中重复创建 action id |
| `resolver-miss` | Binding resolver 或状态机 Clip resolver 未解析到目标 |

Binding 和 Clip resolver miss 都采用 fail-fast，不降级为默认值或空动作；`details.resolver` 区分 `binding` 与 `clip`。状态机 definition 的结构错误使用 `Animation3DStateMachineValidationError`，其中每个 issue 都包含稳定 `code`、结构化 `path` 和诊断 message。

### 6. 状态机定义、编译与 controller

1. `Animation3DStateMachineDefinition` 是纯可序列化定义，格式标识为 `haiyue-animation3d-state-machine@1`。运行时状态不写回 definition。
2. 参数支持 float、integer、boolean、trigger。Trigger 只在成功选择并提交 transition 后消费。
3. Motion 支持 Clip、1D blend tree、2D cartesian 和 directional blend tree。2D 输入落在边界外时必须确定性 clamp。
4. Layer 明确 initial state、weight、override/additive mode 和可选 mask。Transition 以声明顺序决定优先级，支持具体 source、any-state `*`、AND conditions、exitTime、duration、destinationOffset 和五种 interruption 策略。
5. 编译前完成重复 id、引用、参数/operator 类型、数值范围、blend threshold、空 tree 和递归 motion cycle 校验。编译结果解析所有热路径引用，`update()` 不按字符串重复查找。
6. 公开 compiled definition 是 opaque handle，只暴露 format、id、name；compiled node 和 lookup table 不进入 `.d.ts`。
7. `Animation3DStateMachineController` 接收 compiled definition、公开 Mixer 和最小 Clip resolver。它内部通过最小 Mixer port 驱动 action，但不公开 port、adapter、同步 transaction 或调试计数。
8. Controller 支持参数读写、update/evaluate、layer snapshot、reset 和幂等 destroy。大 delta 的多次迁移必须确定且有 cycle 上限，不能形成无限 transition loop。

### 7. 生命周期与后续集成

Clip、Track、Binding 和状态机 definition 是调用者拥有的值，不公开 destroy/release。PoseBuffer 是调用者拥有的 transient scratch；Action 由 Mixer 拥有；Controller 借用 Mixer；Mixer 和 Controller 的 destroy 均幂等。

资产 acquire/cache/owner scope、root motion、IK、retargeting 和 compression 不属于本 facade 收口。glTF adapter 使用公开 `Animation3DMixer` 与调用方可见的 `Animation3DPoseBuffer`，没有第二套 sampler 或 mixer。adapter 拥有的 resolver 与 pose-applier 不是公共 handle；稳定 runtime 只公开 mixer、pose、clips、时间控制、只读统计与幂等 destroy。

## 结果

- glTF、编辑器原生动画和其他来源可以转换为同一 Clip/Track/Binding 契约。
- Mixer 与 ECS 写回、资产加载、状态机编译和来源格式解耦。
- 状态机通过最小集成驱动真实 Action，同时隐藏 transaction 和 compiled graph。
- 公共声明可独立评审，不会因内部 runtime 重构意外扩大 API。
- 错误处理可按稳定 code 自动化测试，且 resolver miss 不再静默产生错误姿态。
- PoseBuffer 与 Track scratch 的复用要求由运行时测试锁定。

## 明确不进入本次稳定表面

- components 根入口 re-export；
- glTF resolver、pose-applier 或内部 binding endpoint handle；
- 用 Animation3D 替换 `applyGltfAnimationClip()`；
- 修改 components 的 `private` 发布策略；
- glTF 现有公共播放 API 替换；
- 正式性能 baseline。

## 验证

- `npm run typecheck -w ./extensions`
- `npm test -w ./extensions`
- `npx tsc -p extensions/tsconfig.animation3d-type-tests.json`
- `npm run api:check`
- `npm run verify:gltf-asset`
- `git diff --check`

类型和运行时测试必须覆盖：

- facade runtime value 白名单与非公开类型的编译失败；
- 从 facade 可达 `.d.ts` 不含私有路径或实现 handle；
- Clip/Track/Binding 的组合约束和结构化错误；
- destroyed Mixer、removed Action、重复 action id 与 resolver miss 的稳定错误码；
- PoseBuffer、channel、channel value 和 Track sampler scratch 的稳态身份复用；
- 状态机校验路径、opaque compiler output、参数/trigger、priority、any-state、exitTime、interruption、1D/2D blend、layer mask/weight、大 delta cycle 防护和幂等生命周期。
