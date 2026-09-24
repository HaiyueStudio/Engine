# Engine 0.2.0 功能与示例验收

日期：2026-09-23。结论：**未通过发布验收**。本记录区分库测试、示例构建、浏览器行为和发布阻塞，不能把构建成功等同于所有功能通过。

## 范围与证据

- 自动示例范围来自 `examples/manifest.json`：46 个 smoke + 8 个 full，共 54 个；另有 38 个 manual，不纳入自动构建。
- 四个包均为 0.2.0：Engine、animation-spec、extensions、shader-language。
- 实机：macOS 26.6.2 / Intel Mac / AMD Radeon Pro 5300M，Chrome 153，原生 Metal WebGPU。
- 初轮干净快照：`fbc7149ba844e167514b730157c8d79b18fe2654`。
- 架构检查与 Mac 光追验证器修复后快照：`7427f44e9f56321e1509b48e4d84f920bbc41528`。
- PDF 示例构建指纹修复后快照：`8618d3ee4fe1e70dffad69d91344d5045ceb3668`。

原始日志、机器结果、截图和执行脚本归档在 `artifacts/release/0.2.0-full-acceptance/`。各次检查保留自己的 revision，不把不同快照合并为同一份正式发布证明。原工作分支与暂存区未更改。

快照使用本机已安装依赖的独立副本，工作区链接解析到快照内部；本轮未重做整个仓库的 `npm ci` 供应链演练。四个发布包的消费端安装则由正式打包验证器实际执行。

## 通过项

| 检查 | 结果 |
| --- | --- |
| 完整 fast 门禁 | 修复架构误报后，在 `7427f44` 完整重跑通过 |
| 四库测试 | Shader 113、Engine 666、animation-spec 107、extensions 392，共 1,278 项通过 |
| 灯光及性能相关策略 | 119 项通过；发布策略 65 项通过 |
| Shader Stage 14 | 25/25 DAG 节点通过，包含真实 GPU 执行与双后端像素一致性 |
| 四包消费与预算 | 确定性 tarball、真实 npm 安装、28 个消费端、Node/TypeScript/exports/CLI 与入口预算通过 |
| 54 个自动示例 | PDF 指纹修复后的干净整批重建通过；加 shared Engine/source viewer 共 56 个目标，源码指纹与产物哈希全部通过 |
| GPU 读回与资源切换 | 120 帧和 1,800 帧通过；长测 450 轮切换、4,220 个资源，残留 0 |
| glTF 资产加载 | 三档生产资产测试通过，资源残留 0 |
| 代表性灯光场景 | 128 authored local lights、四视图、720p 通过；当前 forward 容量仍为 8，不能解释为同时渲染 128 灯 |
| 运动模糊、裁剪、第一人称导航 | 现有浏览器行为与画面验证通过 |
| 动画、阴影截图 | character-animation、多方向阴影、Spine 通过；后两项在 AO 中断后独立补跑 |
| 虚拟摇杆 | 横竖屏固定/浮动模式、移动/转向、多指、松手/取消、GUI 资源释放通过 |
| 动画与音频补测 | 动画对比、切换、遮罩/混合与恢复测试通过；动画音频 OfflineAudioContext 测试通过 |
| 光追示例 | 修复平台选择后，两个示例在 Mac 原生 Metal 上通过，包括交互式 orbit 验证 |

混音、多人输入、字体和动画交互的基础逻辑已包含在上述库测试中。多人输入结果属于自动化输入/快照测试，不代表真实多手柄硬件实测。

## 仍然阻塞发布的结果

以下为本轮验收时发现的历史阻塞；后续修复及复验状态见 [0.2.0 验收阻塞修复](release-0.2.0-blocker-fixes.md)。

| 问题 | 实测与处理要求 |
| --- | --- |
| AO 画面异常 | GTAO-only 亮度均值约 0.584，低于现有有效画面下限 5；截图 MAE 81.408（上限 14），暗区比例差 0.7529（上限 0.15）。截图可见场景大面积变黑，需排查运行时输出链路。 |
| 渲染基准与实际路径不一致 | 单视图主场景 breakdown=77、审计计数=78；SceneOutput 被归入 mainScene。四视图动态场景实际 13 passes、旧预算 9；另有上传调用/字节超限。保留原阈值，需明确输出阶段与上传开销的归属后修正契约。 |
| 平面反射结构预算 | `1000e.1m.1b.1v` 实际 6 passes、预算 4；目前未通过，不能仅扩大上限。 |
| CPU 基准输入/上下文 | Engine 范围基准在 `render3d.full-prepare.1000e.1v` 失败：HDR 路径要求 isolated pass，而 fixture 仍提供旧共享 pass 上下文。独立 renderer policy 测试还保留拆库前 Games 场景路径。 |
| Mac 性能配置未接通 | AO full GPU cost 完成采集后，profile 选择拒绝 `darwin/amd rdna-1`。发布资格已经允许 AMD Mac，但固定设备诊断配置没有匹配项；不能冒用 Apple GPU profile。 |
| PBR / Fog / 产品像素基线 | 当前像素哈希与既有基线不同。需区分渲染变化与跨平台基线差异，再审查画面；本轮没有重置基线。 |
| Volume 清单与门禁冲突 | `ktx2-volume` 标为 manual，自动构建不包含它，`verify:engine-render` 却直接运行依赖其 bundle 的验证器，干净环境报缺少构建产物。需统一清单与门禁范围。 |
| Live2D 离线资源不一致 | 离线示例与 compare 示例的 HYDM 分别为 39,260 / 39,276 bytes，现有同源资源断言失败；资源需要从明确的同源输入重新核对/生成。 |

关键证据：`base/render-regression/ambient-occlusion.png`、`base/release/full-acceptance/` 下各项日志，以及 `base/release/remaining-screenshots/result.json`。

## 本轮修复

1. 光追单元测试从兄弟 milestone 仓库迁回 Engine 内部契约，并补齐原有 BVH ownership 条款。
2. 渲染回归目标选择遵守 smoke/full 清单，排除两个 manual corpus 仪表板；保留全部符合条件的自动目标。
3. 架构检查同时接受共享 fog 的变量与内联表达式，仍拒绝私有帧输入；正反例测试通过。
4. 两个光追示例验证器支持 Mac Chrome/Metal，保留 Windows Chrome/Edge 分支；平台策略测试和实机验证通过。
5. PDF worker 的生成输出不再反向进入源码指纹；改为记录真实依赖 worker 文件。测试证明生成输出不导致误失效，而真实 worker 或示例源码变化仍改变指纹。

## 构建复验说明

最初全量构建在 shared Engine 的 60 秒构建超时处失败。随后按同源码指纹保留有效产物、逐项补建，54 个示例均成功构建，但整批新鲜度检查发现 PDF worker 生成输出被误算为新增源码。该失败与修复过程均保留，不能把这次续跑记为全绿。

PDF 修复后的最终完整重建使用空示例产物目录，保留原构建器和原超时，构建 54 个示例、shared Engine 与 source viewer。完整构建用时 1,061.8 秒，全部 56 个目标的新鲜度检查通过，source fingerprint 为 `dadde067f75992c12f2d0994ad308939fe61b728154f6a26ccde916f3c94d04f`，结束后 Git 工作树仍干净。PDF worker 生成文件与依赖源文件逐字节一致（1,262,398 bytes）。

本轮不构成正式发布授权或五引擎性能排名证明；未执行发布、tag 或 push。
