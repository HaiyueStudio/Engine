# 0028：最多四个独立纹理层的 Toon 材质

- 状态：Accepted
- 日期：2026-07-20

## 背景

引擎已有统一 SceneFrame、场景级光照、方向光阴影、GPU-driven object/material table、异步纹理资产和材质注册表。风格化渲染的第一阶段需要验证一条完整的新 shading model 扩展链，同时避免过早引入材质图、通用 shader IR 或强制纹理打包。

## 决策

1. `ToonMaterial` 支持 1–4 个有序层。第一层 `minLight` 必须为 0，其余阈值严格递增；选择规则是取 `minLight <= lightLevel` 的最高层。
2. 每层拥有独立 color、2D texture、sampler、UV0/UV1 选择和仿射 UV transform。首版不使用 `texture_2d_array`，因此各层可以来自不同尺寸、格式来源和 mip 生命周期；未来 packer 可在不改变公开材质 API 的前提下合并资源。
3. `bandSoftness` 为 0 时使用硬分层；非零时只在相邻阈值附近混合两层。纹理采样使用显式梯度，避免 fragment-varying 分支中的隐式导数问题，并保留 mip 选择。
4. Toon 复用 SceneFrame、雾、场景 PBR light snapshot、方向光 shadow map、共享 Geometry GPU cache、持久 object table 和 GPU-driven indirect 协议。它不创建独立场景遍历或渲染旁路。
5. 材质注册增加 `receivesDirectionalShadow` capability。阴影 receiver planning 由注册身份决定，不再通过 `instanceof PbrMaterial` 硬编码 shading model。
6. 纹理加载沿用 AssetManager handle。材质替换、cache sweep、system destroy 和 device recovery 都必须释放 handle；迟到的异步结果不得回写已销毁或已换源的材质数据。
7. 编辑器场景保存、加载、clone、资源依赖裁剪、runtime export、编辑器 viewport 与 Play 模式必须保留完整四层数据并安装 `ToonRenderSystem`。

## 公开 API

Toon 稳定入口只增加黄金路径所需的 8 个根符号：`ToonMaterial`、`ToonMaterialOptions`、`ToonLayerOptions`、`ToonTextureMappingOptions`、`ToonAlphaMode`、`TOON_MAX_LAYERS`、`ToonRenderSystem` 和 `ToonRenderSystemOptions`。`ToonRenderer`、GPU uniform ABI 和资源 cache 保持实现细节。

本次同时冻结此前已完成但尚未写回基线的帧环、World journal、PlanarMirror 与实验入口迁移结果。稳定预算按当前受审表面更新为：根入口 403、`/components` 88、`/ecs` 22、`/material` 66、`/systems` 31；其他稳定入口不扩张。

## 范围外

- 描边 pass、面线反转描边和屏幕空间轮廓；
- ramp texture、材质图和任意数量动态层；
- 自动 texture-array/atlas 打包；
- specular、rim light 与 matcap 风格化模块。

这些能力必须基于独立 benchmark 和视觉回归分别进入后续决策，不能扩大首版 shader permutation。

## 验证

- 材质验证、revision、clone 和 descriptor 构造测试；
- registration-level shadow receiver capability 测试；
- 编辑器四层纹理往返、runtime dependency 与生成模板测试；
- 四个独立 canvas 纹理的 `toon-layers` 最小示例；
- engine/editor/examples typecheck、engine/editor tests、模块边界、API surface 与示例 catalog/build 门禁。
