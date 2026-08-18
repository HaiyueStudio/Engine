# ADR 0021：灯光与阴影规模化由真实游戏基准驱动

- 状态：Accepted
- 日期：2026-07-17

> 2026-07-26 修订：固定单方向光阴影上限已由 [ADR 0049](./0049-fixed-capacity-multi-directional-shadows.md) 扩展为 PBR 最多三张；本 ADR 对 Forward+/Clustered、atlas 与 CSM 的规模化约束继续有效。

## 背景

当前 PBR 与 Blinn-Phong 使用相同的 scene render environment，每个相机最多提交 8 盏灯；阴影由场景中第一盏有效的投影方向光生成单张 shadow map。这套 forward 路径适合当前小型场景，但不能自然扩展到大量重叠局部光、宽视野室外场景和多 camera/viewport。

Forward+、clustered light culling、GPU light list、shadow atlas 与 cascaded directional shadow 都会改变资源布局、shader ABI、pipeline key、frame graph、设备恢复和编辑器诊断。仅为技术完整度实现其中任意一项，无法证明复杂度与长期维护成本合理。

## 决策

1. 现阶段保留固定上限的 forward lighting 和单方向光阴影，不立即实现 Forward+、clustered lighting、GPU light list、shadow atlas 或 cascaded shadow。
2. `SCENE_RENDER_MAX_LIGHTS`、`PBR_MAX_LIGHTS` 和 `BLINN_PHONG_MAX_LIGHTS` 是当前 renderer 实现参数，不是 stable 场景或材质 API 契约。普通用户不能依赖它们表达内容正确性。
3. 规模化工作只能由真实 game benchmark 启动。微基准和只构造灯光数组的测试可以用于定位，不能单独形成 go 决策。基准协议见 [`lighting-shadow-scaling.md`](../lighting-shadow-scaling.md)。
4. 算法选择保持开放：先采集灯光空间分布、每物体/cluster 重叠数、CPU/GPU frame、上传量和显存，再比较现有 forward、CPU tiled/clustered 与 GPU clustered 原型。结果不能预设为 GPU 方案胜出。
5. 多 camera/viewport 使用以下所有权边界：
   - World/frame 级灯光源数据可以共享，且在该 frame 内不可变；
   - 可见性、cluster/tile 列表和曝光结果按 camera + viewport + layer mask 隔离；
   - shadow atlas 由 frame graph 统一拥有，只有完整 shadow-view key 相同的结果才允许跨 camera 复用；
   - camera 销毁、viewport resize 和 device lost 必须只失效自己的 view 数据，并正确释放共享引用。
6. Cascaded directional shadow 单独决策。它必须先证明单张方向光阴影在真实室外游戏中的覆盖或稳定性不足，并同时具备 cascade split、texel stabilization、atlas ownership、多 camera 复用和 recovery 证据。
7. 新路径先进入 experimental renderer capability。达到受支持设备矩阵、稳定预算、像素一致性和资源零残留门禁后，才能考虑进入 stable RenderProfile；不增加多个相互耦合的公开布尔开关。

## 后果

- 当前小场景不会为未被产品需要证明的能力承担额外 buffer、pass、pipeline 和调试复杂度。
- 后续原型必须能与当前 forward 路径在同一游戏、相机轨迹和固定设备上 A/B，而不是各自使用不同 demo。
- SceneRenderEnvironment 可以继续作为 frame-local 环境入口，但未来 master light data 与 per-view light list 必须分层，不能把 camera-specific 结果缓存回 World snapshot。
- 任何超过当前灯光或阴影能力的内容需求，在新路径通过门禁前都应被诊断为能力上限，不能静默承诺完整渲染。
