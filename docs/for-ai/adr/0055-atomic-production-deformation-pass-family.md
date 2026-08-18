# ADR 0055：Production Deformation 必须作为完整 Pass Family 原子迁移

## 状态

Accepted

## 决策

1. forward、depth、directional shadow、motion-vector、outline/selection 从同一个 compiler-owned deformation module 生成，禁止逐文件维护 morph/skinning 分支。
2. 顶点变形顺序固定为 morph 后 skin；所有 pass artifact 记录相同 deformation module hash。
3. 当前态对象 ABI 前缀固定为 `model + morphWeights + deformationFlags`（96 bytes）；current skin group 固定为 joint matrices、joints、weights。
4. motion history 显式携带 current/previous model、view-projection、morph weights 和 joint matrices；历史失效时 previous 必须等于 current，不能保留不完整的局部历史。
5. renderer 继续拥有 bind-group layout、GPU resource 和 history lifecycle。Shader Language compiler 不创建 buffer、不调度 pass。
6. Outline 必须执行实际 morph/skinning，不能再对变形角色绘制原始网格 mask。
7. PBR lighting 延后到独立阶段，但 PBR deformation feature 立即消费本阶段生成模块，避免第二套函数 ABI。

## 结果

- Basic forward 从 Stage 9 simple-3D artifact 移入 deformation artifact，旧重复生成物删除。
- depth、shadow、motion、outline 的九个手写 WGSL/feature source 被生成物替代。
- Motion history、outline deformation 和九个 pass 的 WebGPU 编译进入阶段 10 独立门禁。
- 本决策不扩大 engine 公共 API，也不提前承诺 GLSL/WebGL2 backend。
