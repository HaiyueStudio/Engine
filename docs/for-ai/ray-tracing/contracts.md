# WebGPU compute ray tracing contracts

## Capability and package boundary

- 候选入口为 experimental `@haiyue/extensions/ray-tracing`，仅在准入后由 M04 的共享 contract owner
  添加 export、Rollup input、类型测试和 packed consumer。未获准时 package manifest 不发布空入口。
- 依赖方向固定为 `engine <- extensions`。Extension 只消费 Engine 已公开的 scene/geometry/material、
  RenderPlan、ComputeResourceAccess、WorkerChannel 和 diagnostics 协议；不得相对导入 Engine `src/`。
- Raster 是默认输出。关闭或卸载 extension 后不得保留 pass、listener、Worker、GPU resource 或静态 bundle closure。

## Identity and CPU oracle

- Primitive identity 为 `{ geometryId, geometryRevision, primitiveIndex, instanceId, entityId }`；packed index
  只在一个 snapshot revision 内有效，不能持久化或写回场景。
- Ray 使用 world-space origin/direction、闭区间 `tMin/tMax` 和 normalized finite direction。Invalid/NaN/Inf
  输入产生 diagnostic，不进入 acceleration build。
- Triangle hit 冻结 Möller–Trumbore 语义：barycentric 为 `(u,v,w=1-u-v)`；front face 由 world-space
  geometric normal 与 ray direction 的负点积决定；normal 使用 inverse-transpose 并在 negative/non-uniform
  scale 后重新归一化。
- 相等 `t` 的 tie-break 顺序为 instance identity、geometry identity、primitive index。Degenerate triangle
  明确 invalid；inside、backface 和 large-coordinate case 不得靠扩大 epsilon 静默消失。

## Snapshot, BLAS and TLAS

- Immutable snapshot 记录 source revision/fingerprint 以及 geometry、transform、material、light、camera revision；
  removal 和 replacement 生成新 membership revision。
- BLAS 仅拥有 geometry-derived bounds/nodes/primitive order；geometry revision 改变时 rebuild。TLAS 仅拥有
  instance bounds、transform 和 indirection；transform-only change 允许 refit，membership/topology change rebuild。
- Packed ABI 在 G03 结束前由单一 shared owner 冻结；所有结构声明 byte size、alignment、endianness、index
  width、sentinel、stack upper bound 和 overflow behavior。CPU serializer 与 Artifact V2 reflection 必须共享
  生成事实，不维护第二份手写 binding 表。

## Render and accumulation ordering

- RenderPlan 顺序为 `extract/build -> upload -> traversal -> shading -> optional denoise -> composite`，每个 pass
  声明精确 resource read/write/indirect access。Extension 不拥有 raster scene textures 或 frame submission。
- Accumulation key 至少包含 camera、viewport、geometry membership/revision、instance transform、material、light、
  sampling 和 denoise revision。任一字段变化只产生一次带 reason 的 reset；history 不跨 device 或 owner。
- Unsupported material/light/texture feature 返回结构化列表，不静默近似成另一个材质。Packed material 是只读缓存。

## Ownership and diagnostics

- Owner 层级为 extension -> project/scene -> device resources/task/history。Dispose 逆序、幂等并 abort 所有 pending work。
- Worker 使用 versioned plain-data channel、bounded queue、latest-wins generation、AbortSignal 和 source fingerprint。
  Stale、late、crash、messageerror、queue overflow 和 recovery failure 分别分类。
- Diagnostics 分阶段记录 extraction、build/refit、upload、traversal、shading、denoise、composite；至少包含
  rays/hits/misses/node tests/primitive tests/stack overflow、GPU validation、memory/live resource 和 stale work。

## Admission evidence schema

登记文件使用 `haiyue-ray-tracing-product-decision@1`：

```json
{
  "format": "haiyue-ray-tracing-product-decision@1",
  "productRequirementId": "product-requirement-id",
  "contentManifestSha256": "sha256:<64 hex>",
  "cases": [
    {
      "effectId": "path-tracing | hybrid-shadow | hybrid-reflection | hybrid-ao",
      "sourceProduct": "repository/product@clean-revision",
      "sourceRevision": { "commitSha": "<40 hex>", "dirty": false },
      "fixedSceneId": "stable-scene-id",
      "fixedCameraReplayId": "stable-camera-replay-id",
      "sceneSha256": "sha256:<64 hex>",
      "baselineImageSha256": "sha256:<64 hex>",
      "referenceImageSha256": "sha256:<64 hex>",
      "referenceKind": "offline-path-traced | measured-ground-truth | product-art-direction-approved",
      "baselineDeficit": {
        "currentPathFailed": true,
        "kind": "effect-specific accepted deficit"
      },
      "deviceClasses": ["real-hardware-device-class"],
      "capture": {
        "browser": "browser name",
        "browserVersion": "exact version",
        "backend": "native backend",
        "adapterName": "adapter name",
        "softwareAdapter": false
      }
    }
  ],
  "unclassifiedFailureCount": 0
}
```

四个 effect case 都必须存在且 reference 与 baseline 不同。Artifact provenance 还需绑定 clean revision、
browser/backend/adapter、runner/config hash 和采集时间；这些字段由后续 artifact validator 冻结，不能用
placeholder hash 或 software adapter 满足人工评审。
