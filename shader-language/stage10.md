# 阶段 10：Production Deformation Pass Family

阶段 10 将 forward、depth、directional shadow、motion-vector 和 outline/selection 作为一个不可拆分的 production family 迁移。输入是 [builtin-deformation-family.json](./builtin-deformation-family.json)，构建期编译为 Artifact V2；engine runtime 只物化生成代码和 reflection，不运行 compiler，也不解析 WGSL 来猜 binding。

## 单一 deformation 事实来源

`morph.wgsl` 与 `skinning.wgsl` 位于 compiler-owned deformation standard library。九个生产变体都记录同一个 `deformationModuleHash`，固定 `morph → skin` 顺序。Basic forward 从 Stage 9 simple-3D artifact 移入本 family；PBR lighting 本身仍等待阶段 11，但 PBR 的 morph/skinning feature 已改为消费同一份生成模块，因此不再保留第二套手写形变函数。

当前态对象前缀冻结为 96 bytes：`model`、`morphWeights`、`deformationFlags`。forward、depth、shadow 和 outline 通过 group 1 binding 1 读取按相同 object slot 索引、独立上传的 144-byte 8-plane world-space clipping companion table；未启用时 `meta.x=0`。current skin ABI 固定在 physical group 3，依次为 joint matrices、joint attributes、weight attributes。vertex location 可随 pass 所需的 normal/UV 变化，但 reflection semantic 必须保持 `POSITION` 与 `MORPH_POSITION_0..3`。

## History ABI

motion-vector 保持 240-byte history object：current/previous model、previous view-projection、current/previous morph weights和 deformation flags；裁剪块位于独立 storage buffer，仅在 clipping revision 变化时上传。current/previous joint matrices 使用同一组 skin attributes，并执行相同的 morph-then-skin 图。first frame、frame discontinuity、camera replacement、scene history revision、geometry replacement都令 previous=current；view/entity history 隔离，stale view、entity release 和 renderer destroy 都显式退休 GPU buffer。

## Outline 闭环

此前 outline mask 只读取原始 position，因此选择态会与 morph/skinned 角色轮廓错位。现在 OutlineMaskRenderer 使用共享对象表、generated outline pass 与 `CurrentDeformationGpuCache`，真正绑定四个 morph position buffer 和 current skin group。浏览器门禁同时验证 outline 的 morph+skin 白色像素以及 motion history 的 `(0.25, 0)` UV velocity。

## 边界

本阶段不迁移 PBR lighting/BRDF、Blinn/Toon、specialized renderer 或 compute shader；不改变 renderer 调度、公开 package export、API baseline 和 WebGPU-only 产品契约。PBR 的完整 material surface 与 lighting 迁移必须在 deformation ABI 稳定之后单独完成。
