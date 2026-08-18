# Deferred capability registry

下列能力均为 `hold`。入口是 [capability admission](../capability-admission.md) 与 ADR 0066；旧 todo、评审建议、synthetic benchmark 或架构 seam 都不是实现授权。

| 能力 | 当前 deficit | 解锁前最低真实证据 | 排除的 M2.5 Goal |
| --- | --- | --- | --- |
| Markdown/MSDF/dynamic glyph atlas | 无产品场景证明现有 Bitmap/GUI text 阻塞 | 真实文档产品、字符集/排版/长文档指标、包与 Worker 预算 | 全部 |
| 完整 shaping/i18n | RTL/Indic/emoji/fallback 尚无已承诺内容 | 真实语言 corpus 与错误 reference | 全部 |
| 空间音频/混音 | 仅 AnimationAudioClip | 真实游戏声场与浏览器策略需求 | 全部 |
| PointLight shadow | 当前只有方向光 shadow | 真实场景画面与性能 deficit | G04 |
| 透明 PBR/Toon/BlinnPhong 实例合批 | 当前按深度正确排序但 draw 较多 | 同画面真实透明 draw bottleneck 与 parity | G04 |
| 透明 motion vector/多层 transmission | opaque-first / 单层 scene color | 真实内容伪影 reference 与设备预算 | G04 |
| Geometry LOD streaming/内存分级 | 有 BVH LOD/KTX2/Draco，无流式预算 | 大场景内存/网络 replay 与 deficit | G05 |
| Renderer/simulation threads | 主线程架构但无产品阻塞证据 | 主线程 long-task replay、COOP/COEP 部署约束与收益 | G07 |
| Archetype ECS 替换 | 对象 ECS 仍是稳定语义 | 真实 10k+ simulation deficit；只允许独立提案 | G07 |
| BVH/instance WASM 扩张 | 旧 todo 只有候选数值 | SceneBatch 保留后仍存在独立产品瓶颈 | G07 |
| WebGL2 renderer fallback | GLSL 仅 IR portability | policy 所需覆盖/设备/功能降级证据 | G02 |

GPU cull readback 当前明确是 telemetry；在有遮挡反馈产品需求前不扩成闭环。README 编码和 Windows/browser/release evidence 属于 M02，不重复建立 M2.5 能力。
