# 阶段 6：构建期 Shader Artifact 与首个生产迁移

阶段 6 对 Motion Blur production migration 作出 GO 决策，并完成第一个受控迁移切片。PBR 与 deformation 仍是 deferred，不因三个 Pilot 全绿而被批量切换。`@haiyue/shader-language` 保持 private，engine 没有新增对 compiler package 的依赖，也没有公共 API 或 API baseline 变化。

## 生产交付链

内置 Motion Blur 的单一事实来源现在是 [pilot-motion-blur-postprocess.graph.json](./pilot-motion-blur-postprocess.graph.json) 和 Typed IR：

```text
Graph v1 / Typed IR
  -> WGSL + reflection（构建期，logical pass group 3 -> physical group 0）
  -> checked-in precompiled artifact
  -> engine private runtime adapter
  -> MotionBlurPass / RenderGraph
```

运行 `npm run shader-language:generate:motion-blur` 会生成三个完整 WGSL module 和一个 reflection/provenance manifest。`npm run shader-language:check` 只执行确定性重生成比较，不改文件；产物缺失、被手改或 compiler/graph 漂移都会令 fast gate 失败。

group 3→0 是 renderer adapter 的显式 codegen option。生成源码和 reflection 同时使用 physical group 0，canonical graph hash 与 typed module hash保持不变，pass/source hash 则准确反映物理 ABI。整个过程没有 WGSL `replace`。

## Runtime Adapter

engine 内部的 `PrecompiledShaderRuntime` 只消费结构化 manifest：

- 根据 texture sample type、sampler type、uniform min size 和 stage visibility 创建 bind-group layout；
- 根据 reflection byte offset 提供可复用、无稳态分配的 uniform writer；
- 按 `GPUDevice + artifactHash + passHash` 复用 shader module、bind-group layout 和 pipeline layout；
- 不解析 graph、不生成 shader、不创建 render pass 或 sized texture。

同一 device 上创建两个 MotionBlurPass 时仍只创建三个 shader module/layout；每个实例继续独立拥有两个 uniform buffer 和两个中间 texture，并在 destroy 时释放。device cache 使用 WeakMap，不持有 device 生命周期。

## 单一生产实现

`MotionBlurPass` 已改用 `engine/src/shaders/generated/` 下的 artifact。原先三个手写 motion blur fragment 已删除，不保留长期 fallback 分支。现有 `MotionBlurPassOptions`、signed UV velocity ABI、pass 调度、warmup、透明度和资源数量均未改变。

失败语义是显式的：

- build artifact stale：fast gate 阻断；
- manifest format/group/provenance 非法：prepare 显式抛错；
- WebGPU shader compilation/validation 失败：现有 browser gate 阻断；
- 不静默切回已删除的旧 shader。

## 证据与门禁

运行：

```bash
npm run verify:shader-language-stage6
```

该命令串行验证 artifact 未漂移、Stage 5 generated-vs-production reference 像素完全一致，并运行真实生产 Motion Blur 示例。门禁继续覆盖 PBR、19-joint glTF skinning、阴影、motion-vector、centered、tile/neighbor、split 和 velocity heatmap。

结构预算保持：centered 为一个 pass/零活跃中间纹理，tile-neighbor 为三个 pass/两个活跃中间纹理，pipeline 数为三个。浏览器报告四个启用 case 的 pipeline warmup 原始样本、P50 和 P95；阶段 6 不用单台本地设备的一轮结果提前提升正式时序 baseline。

fast gate 覆盖 deterministic artifact、group mapping、reflection ABI、第二实例 cache hit、instance resource destroy 和公共 API 不变；`verify:motion-blur` 已位于 `verify:render`，因此真实生产 WebGPU case 继续进入 slow/full 链路。

## 后续边界

下一次 production migration 必须单独选择 PBR 或 deformation，并分别证明材质 API、变体/pipeline cache、shadow/depth/motion coherence、draw/pass/upload 和真实设备性能。GLSL ES 300 feasibility、WebGL2 fallback、用户 graph runtime cache、可视化编辑器与稳定 shader API 仍未开始。

权威机器范围见 [stage6-contract.json](./stage6-contract.json)，长期决策见 [ADR 0051](../docs/for-ai/adr/0051-build-time-shader-artifacts-and-runtime-adapter.md)。
