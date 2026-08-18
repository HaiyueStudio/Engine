# 0032：动效 text/audio 与引擎原生粒子边界

- 状态：Accepted
- 日期：2026-07-21
- 取代：[0031](./0031-animation-vector-and-compositing-runtime.md)

## 背景

0031 建立了 sprite、path 与 alpha composite 的完整运行链路。text、particle、audio 若全部作为播放器私有扩展，会导致普通场景无法复用粒子能力，也会让来源转换器决定浏览器资源生命周期。反过来，把时间轴、Lottie 语义或音频策略塞入引擎核心，又会扩大基础包并耦合来源格式。

## 决策

0. 继承 0031 的独立 spec、HYA1、AssetManager、专用 Animation2D renderer、路径细分与有预算 alpha composite 决策。
1. 在首次外部格式发布前，将 `text2d`、`particle2d`、`audio` 纳入 `haiyue-animation@1.0` core。parser 在分配前检查文本字符、粒子总容量及 image/audio 强类型引用。
2. 通用粒子能力位于 engine：`ParticleEmitter2D` 使用固定容量 SoA 和可复现 PRNG，`Particle2DSystem` 负责有上限的 delta 仿真，`Particle2DRenderSystem` 使用 WebGPU instancing，并支持 normal/additive、可选纹理、视图状态、设备恢复及 submit 后 buffer 退休。
3. animation runtime 只把 `particle2d` 映射为引擎 emitter，持有纹理 handle，并在 seek/循环回绕时确定性重建状态。它不复制粒子 simulation 或 renderer。
4. `text2d` 首版是静态内容与样式，通过 `CssMaterial` 栅格化，并由 Animation2D renderer 按 texture version 增量上传。尺寸变化的旧 GPU texture 在提交完成后退休。
5. `audio` 首版由 runtime 使用 HTML media 元素与 composition time、playing、speed 和 opacity 同步；销毁时解除 source。autoplay 拒绝作为可重试浏览器状态处理，不能令渲染帧失败。
6. Lottie converter 支持静态 text document 与 audio layer。animated text 产生显式诊断；来源播放器和解析库不进入 runtime bundle。
7. 粒子当前是独立 render pass，不承诺与 Animation2D visual 的逐 item 交错或 mask/matte。未来需要该语义时，应统一 2D render item/graph 协议，而不是把粒子实现复制进动画 renderer。

## 结果

- 游戏、编辑器和动效播放器共享同一粒子 simulation/rendering API；动效包只为实际使用的 text/audio 代码付费。
- 固定容量避免 steady-state 粒子对象分配，seed 与 seek 提供编辑器预览和回归测试需要的可复现结果。
- canvas text 适合 UI 标题和一般动态素材，但复杂字体整形、逐字动画和动态文案 track 仍需后续专门 ABI。
- HTML media 路径依赖浏览器解码和用户手势策略；低延迟音效混音或 sample-accurate 调度应另建 Web Audio contribution。

## 验证

- engine 测试覆盖确定性、容量、死亡槽复用、seek 和 suspended-tab delta clamp；
- spec 测试覆盖 HYA roundtrip、资源类型、字符/容量预算及 Lottie text/audio 转换；
- components 测试覆盖三类 runtime 实例、统计和 play/pause 联动；
- example 覆盖 Lottie → HYA1 → text/audio runtime，并叠加 engine 原生 WebGPU particle。
