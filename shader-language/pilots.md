# 阶段 0 迁移试点

三个 pilot 用于验证 IR 是否真正解决组合、pass 一致性和非材质 shader，而不是展示语法。正式实现前不得调整验收口径来迁就 compiler。

## 当前执行状态

- Pilot 1 已在[阶段 3](./stage3.md)通过：Graph v1、MaterialSurface、PBR/Fog 与手写参考像素/gzip 门禁。
- Pilot 2 已在[阶段 4](./stage4.md)通过：单一 deformation region 派生五个 pass，并使用真实 glTF Animation3D 输入。
- Pilot 3 已在[阶段 5](./stage5.md)通过：postprocess region 派生 tile/neighbor/resolve，RenderGraph 调度保持外置。

三个试点全绿表示可以进入 production migration 的 go/no-go 评审，不表示生产 renderer 已迁移；三个阶段的 `productionMigrations` 均为空。

[阶段 6](./stage6.md) 已完成第一次 go/no-go：Motion Blur 因 generated/production exact pixel parity 获得 GO，并通过构建期 artifact 迁移；PBR 与 deformation 继续 deferred。

## Pilot 1：PBR + normal + UV noise + gradient + Fog

### 输入

- metallic-roughness PBR；
- base color texture；
- tangent-space normal texture；
- UV noise distortion；
- world-height color gradient；
- scene Fog。

规范 graph fixture：[pilot-pbr-composition.graph.json](./pilot-pbr-composition.graph.json)。Fog 作为 `sceneFeatures`，不写进 material surface 节点。

### 必须证明

- graph 不出现 binding 数字或 shader 源码；
- compiler 自动收集 UV、normal/TBN、world position、frame/object/material/pass resource；
- `normalTS` 空间检查有效；
- Fog 在 lighting 后应用；
- normal/noise/gradient/Fog 不增加 static variant 维度；
- reflection 能生成 material uniform packer 和完整 layout；
- node diagnostic 能定位到 node/port。

### 验收

- 与手写参考 shader 的固定 WebGPU 像素差在现有 PBR gate 容差内；
- WebGPU validation error 为 0；
- 相同语义 graph 的 canonical hash 稳定；
- clearcoat × transmission 最多保留 4 个 specialization，pilot family 总 variant 不超过 8；
- built-in 预生成路径的 first-frame P95 不回退超过 5%；
- generated WGSL gzip 不比等价手写组合大 15% 以上；
- 任何 binding、space、缺失 semantic 错误都必须 classified，unclassified 为 0。

若无法在不暴露 binding/字符串 hook 的前提下完成组合，则 IR/resource ABI no-go，不能进入 PBR 全量迁移。

## Pilot 2：Morph + skinning + displacement 的多 Pass 一致性

### 输入

- 真实 glTF 角色；
- 至少一个 morph target；
- 真实 skinning joints/weights；
- object-space 程序化 displacement；
- Idle → Run cross-fade；
- directional shadow、depth、motion-vector、outline/selection。

### 必须证明

- morph → skin → displacement 的顺序只定义一次；
- forward、depth、shadow、motion-vector、outline 从同一 deformation IR 派生；
- motion-vector current/previous 使用相同图结构和显式历史语义；
- history reset 时 previous 回退 current；
- 无关 PBR surface 逻辑从辅助 pass 中被 DCE；
- joint/morph/object resource ownership 继续遵守当前 renderer lifecycle。

### 验收

- 起点、中间帧、终点的角色颜色、轮廓、shadow 和 velocity 像素门禁通过；
- depth/shadow silhouette 与 forward alpha coverage 一致；
- 首帧、seek、teleport、scene destroy 不出现 motion spike 或资源 residual；
- 多 view 不共享错误的 previous state；
- 不复制第二套 sampler/mixer/deformation WGSL；
- draw/pass/upload 不因 graph 接入产生无解释增长；
- WebGPU validation error、owner residual、unclassified failure 均为 0。

任一辅助 pass 需要私有变形实现，视为 material/pass IR 边界 no-go。

## Pilot 3：Motion blur resolve/postprocess

### 输入

- full-screen fragment graph；
- color、depth、velocity、tile-max/neighbor-max 输入；
- shutter angle、intensity、max blur pixels；
- raw、split、velocity heatmap 和稳定 reconstruction 模式。

### 必须证明

- IR 不只服务材质 surface，也能表达 postprocess entry point；
- texture/sample/derivative/stage 检查有效；
- pass 依赖由 RenderGraph 提供，shader graph 不创建 pass；
- split/heatmap 等诊断模式具有可解释 variant/dynamic 分类；
- 多 pass tile/neighbor pipeline 由外部 pass graph 编排，各 shader 共享 typed module。

### 验收

- 复用现有 motion-blur 像素 gate 的 raw/centered/tile-neighbor/heatmap 指标；
- 开启/关闭具有实际像素差，速度越高模糊越明显；
- 固定角度不出现此前的逐像素最大速度跳变；
- WebGPU validation error 为 0；
- 与现有实现相比 pass 数和 texture 分配不增加；
- shader generation + reflection 不进入逐帧热路径；
- 不把 render pass scheduler 塞进 shader compiler。

如果 postprocess 需要污染 `MaterialSurface` 或 shader node 直接调度 RenderGraph，则 graph kind/renderer 边界 no-go。

## 实施顺序

1. Pilot 1 验证基础 IR、resource ABI、WGSL backend 和 material surface。
2. Pilot 2 在 Pilot 1 的 contract 稳定后验证多 pass 派生。
3. Pilot 3 可与 Pilot 2 的 renderer 集成并行，但共用的 IR/type/resource contract 只能由一个串行集成点更新。
4. 三个 pilot 全绿后，才决定是否启动完整 PBR 迁移、GLSL ES 300 feasibility 和 Shader Graph UI。
