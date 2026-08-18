# 阶段 4：自动 Vertex/Varying 与多 Pass Deformation Pilot

阶段 4 实现 Pilot 2，但仍保持 `@haiyue/shader-language` 为 private workspace。它验证的是编译器边界：一份 canonical Typed Shader IR deformation region 能否生成 forward、depth、directional shadow、motion-vector 和 outline/selection，而不是提前替换生产渲染器。

## 单一形变定义

`defineDeformationProgramV1()` 产生 `haiyue-typed-shader-ir / vertex-deformation` aggregate region；它不是第二种 authoring IR。该入口接受结构化数据，不接受 WGSL、binding、GPU handle、pass 名或动画 sampler。v1 固定以下顺序：

1. morph target position/normal blend；
2. four-influence linear blend skinning；
3. 沿 skinned normal 的 object-space sine displacement。

`compileDeformationPassFamilyV1()` 只生成一次共享 deformation WGSL module；五个独立 shader program 都携带相同 `deformationModuleHash` 和 byte-identical `sharedDeformationSource`。独立 GPU shader module 必须包含所需函数体，但 compiler 内没有五份私有形变实现。

## 自动 ABI 与 Pass 派生

compiler 根据 morph 数量分配 POSITION、NORMAL、JOINTS_0、WEIGHTS_0 和 morph position/normal vertex locations。forward 自动产生 world position/normal varying，motion 自动产生 current/previous clip varying，depth/shadow/outline 没有无用 varying。

对象 uniform 和 current/previous joint storage buffer 只存在于 reflection，浏览器证据也直接使用该 reflection 驱动公共 uniform packer，不复制 byte offset。compiler 不创建、缓存或销毁 GPU resource；renderer 仍负责 allocation、upload 和 lifecycle。辅助 pass 不包含 `MaterialSurface`、PBR、Fog 或 texture sample。

motion 的 current/previous 都调用 `hy_deform_vertex()`，仅显式 state 不同。`DeformationHistoryTracker` 以 view/entity 二元 key 隔离历史；first frame、seek 和 teleport 均令 previous=current，scene destroy 可释放 entity/view 或 dispose 全部状态。

## Pilot 2 证据

运行：

```bash
npm run verify:shader-language-stage4
```

浏览器通过 HTTP 加载真实 `animation-characterization.gltf`，并复用 components 的 glTF adapter、`Animation3DMixer` 和 `Animation3DPoseBuffer` 取得 Idle→Run 起点、中间帧和终点的 root TRS、GPU morph 与 joint matrices。相同几何和每阶段一次上传的 object/joint state 被五个派生 pass 复用。

门禁要求：

- 五个 WebGPU shader compilation/validation error 为 0；
- forward/depth/shadow 的 opaque silhouette mismatch 为 0；
- start/mid/end 的 forward、outline、shadow 和 velocity 都有实际像素证据；
- first frame、seek、teleport 的 velocity neutral channel 偏差不超过 1；
- 两个 view 的 previous state 不串扰；
- 每阶段只上传一次共享 object state 和一次 current/previous joint state，不按 pass 重复；
- dispose 后 history entry 和 gate-owned GPU resource residual 均为 0；
- unclassified failure 为 0。

## 边界

本阶段没有修改 engine renderer、production WGSL、glTF loader 或 Animation3D runtime，因此 production first-frame 结构性回归为 0。下一步必须先做 renderer adapter、真实 production pass 对照与性能 evidence，才允许迁移 PBR/depth/shadow/motion 的既有 shader。

权威机器范围见 [stage4-contract.json](./stage4-contract.json)。
