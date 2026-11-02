# Engine 0.2.2 评审与证据

2026-10-31 发布记录：四个 0.2.2 npm 包从官方仓库下载并核对冻结哈希；[正式 Release](https://github.com/HaiyueStudio/Engine/releases/tag/v0.2.2)附件回读通过，[示例站点](https://haiyuestudio.github.io/Engine/)已部署。签名标签 `v0.2.2` 绑定 `69ad05e`，运行时包构建提交为 `d58835a`。本文汇总已完成的本版结论；后续开发从 [0.2.3](../engine-0.2.3/README.md)读取。

## 问题与结论

本版完成共享布局、GUI 交互／主题／分区、HYA 组合运行时、增量资源和独立包验收。G01–G13 的阶段检查、失败、设备记录和发布输入仍保留原路径与哈希。阶段初期的“待实现”“下一步”和逐命令日志已从入口移至[原文归档](../archive/engine-review-entry-history-20261102.json)，不作为当前待办。

## 解决方法与合同

- [ADR 0132](../../docs/for-ai/adr/0132-gui-layout-interaction-022.md)、[GUI/HYA 合同](layout-contract.md)、[机器合同](../../config/layout-022-contract.json)：布局差异、输入、文字、皮肤、分区和预算的权威入口。
- [HYA 能力审计](hya-capability-audit.json)与[API 草案](api-draft.d.ts)：记录冻结范围；实际公共签名以已发布 exports 和声明为准。
- GUI/HYA 共用布局核心，以显式配置保留旧几何差异；Engine 不依赖 extensions。区域缓存、资源退役、输入域及音频继续复用各自 owner。

## 当前基线

正式候选与发布字节的核验见 [G13](g13-checks.json)。[G01 初始 CPU/结构采样](../../artifacts/engine-0.2.2/g01/baseline-frozen.json)、[几何 oracle](../../artifacts/engine-0.2.2/g01/oracle.json)和[原生侧栏诊断](../../artifacts/engine-0.2.2/g01/region-baseline.json)保留原资格范围；其中带诊断设备的结构计数不是 GPU 时间，10k 场景仍有诊断限定。历史数值不复制成今天的通用性能承诺。

## HYA 完善范围

本版交付公开格式／工厂、组合播放、真实字形／图像／N-slice、数据／状态／输入／语义／音频通道，以及增量、缓存和销毁合同。未准入通道仍按合同具名拒绝；不包含 Rive 转换器、任意自定义脚本／WGSL 或 Editor 导入。

## 验证与证据

各阶段下列检查索引保留原始结果、指纹和失败身份。活动代码可直接读取的机器合同、API、许可、基线和原始捕获未归档或删除。复核入口见 [layout-contracts](../../scripts/fixtures/layout-contracts/README.md)。

## G02 共享核心与 HYA 交接

来源无关的共享布局核心与 HYA 交接归入同一合同，保留旧几何差异和反例。实施与验证见 [G02](g02-checks.json)。

## G03 GUI 接入与增量更新

GUI 接入共享布局与失效路径，处理静态及视觉变化的重复工作；适用范围、几何／性能证据见 [G03](g03-checks.json)。

## G04 分区调度与像素缓存

区域使用自有持久纹理与原资源 owner；裁剪不替代缓存／生命周期。原生像素、DPR／MSAA、退役与预算证据见 [G04](g04-checks.json)。

## G05 输入路由与焦点导航

统一输入域、焦点与导航，保留事件消费和跨域边界。检查及实际设备责任见 [G05](g05-checks.json)。

## G06 Unicode 编辑与跨端文本输入

编辑、组合输入与候选定位使用原输入／文字 owner；自动事件不替代物理 IME。阶段检查见 [G06](g06-checks.json)，最终 Mac／iPhone 资格见 G13。

## G07 主题资源与九宫格皮肤

主题与九宫格资源复用原绘制、布局、输入及资源生命周期；样式与几何边界见 [G07](g07-checks.json)。

## G08 分隔面板与标签页

分隔面板／标签页沿用原布局和焦点／输入 owner，检查与像素证据见 [G08](g08-checks.json)。

## G09 语义拖放

拖放的发起、命中、取消和跨域释放维持原输入边界；完整验证见 [G09](g09-checks.json)。

## G10 HYA 公开能力与格式合同

冻结公开能力、格式／组合协议、符号及容量，保留旧格式和具名拒绝。初始 corpus／缓存／seek 问题与后续阶段责任保留于 [G10](g10-checks.json)；原失败不改写为通过。

## G11 HYA 组合播放与真实绘制

公开工厂、共享布局、数据／状态／输入／语义／音频与真实绘制共用提交及 owner。独立消费者、原闭包容量及所需设备责任见 [G11](g11-checks.json)。

## G12 增量、资源与真实素材

增量求值、真实授权 corpus、生产帧节奏、缓存／退役和销毁证据见 [G12](g12-checks.json)。原素材分母、失败及历史采样保持，不以增大预算代替修复。

## G13 包集成与发布候选

最终四包字节、候选输入、全局门禁、无发布演练与七组 580 次捕获的独立复核见 [G13](g13-checks.json)。Windows 真实 IME／Xbox 360 及 [Mac／iPhone 验收](g13-mac-iphone-20261030.md)补齐本版设备责任；Games／Native 消费者与传输包仍按原清单回读。

保留的边界：动态 sparse-256 tiled CPU 调查按 [ADR 0137](../../docs/for-ai/adr/0137-g05-moving-sparse256-cpu-investigation.md)处理；GUI 有限容量按 [ADR 0138](../../docs/for-ai/adr/0138-selective-gui-bundle-admission.md)处理。其他 GPU 5%、画质、资源及预算不扩大。[标签 CI](https://github.com/HaiyueStudio/Engine/actions/runs/41068966208)中 Ubuntu／SwiftShader 具名 10,000 实体平面反射超时按用户对本版的明确授权保留为调查项，原失败和未执行阶段仍在；该许可不自动沿用到 0.2.3。[后续 Linux Fast 检查](https://github.com/HaiyueStudio/Engine/actions/runs/41085972749)修复测试辅助入口，不改变四包字节。
