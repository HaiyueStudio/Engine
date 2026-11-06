# Engine 0.2.3 验收入口

G01–G10 已完成，G11 仍在集成／验收。开发候选的 Engine／extensions／shader-language 为 0.2.3，animation-spec 为 0.2.2。整版尚未取得正式平台／性能、真实设备、全局门禁及无发布演练资格，未发布或推广基线。唯一活动检查入口为 [G11 检查索引](g11-checks.json)。

合同：[ADR 0139](../../docs/for-ai/adr/0139-engine-023-gameplay-contracts.md) · [行为](contract.md) · [目标声明](api-contract.d.ts) · [机器合同](../../config/gameplay-023-contract.json)。本页汇总结论和剩余责任，逐次尝试与本次整理前原文见[归档清单](../archive/engine-review-entry-history-20261102.json)。原 checks JSON、原始捕获、合同和源码身份保留。

## 问题、方法与阶段结论

| 问题 | 方法与结论 | 检查索引 |
| --- | --- | --- |
| 发布终端／恢复不可靠 | 真实 TTY、原定位器、原子状态、owner 锁、附件回读及专用 CI 无发布验证 | [G02](g02-checks.json) |
| 场景加载缺少事务边界 | 原资产 owner、有界并发、准备后切换、取消与失败回滚 | [G03](g03-checks.json) |
| 角色／物理重复时钟 | 原 Box2D 形状扫掠、box／circle 子集及共享私有时钟，呈现不回写物理 | [G04](g04-checks.json) |
| 相机跟随需重复实现 | 借用原相机实现平滑、死区、边界、seeded 震屏及 reset | [G05](g05-checks.json) |
| 方向轴／重绑不一致 | 宿主与映射统一方向、不可变快照、冲突处理及保存恢复 | [G06](g06-checks.json) |
| 集合数据与行实例耦合 | 稳定 key、固定行高、有限窗口，回收前取消旧输入域与编辑 | [G07](g07-checks.json) |
| 地图编辑重建整图 | 图集／颜色模式、脏块、离屏延迟上传、有界驻留／工作／退役及恢复 | [G08](g08-checks.json) |
| 音频配置／定位重复开销 | 原 mixer 配置、淡出、2D 声像／衰减；owner 与活声音租约隔离释放 | [G09](g09-checks.json) |
| 复合 GUI 缺少共享合同 | Tabs／图标、Breadcrumb／Badge／Collapse 复用原布局、焦点、输入与资源 | [G10](g10-checks.json) |

G08–G10 的原生像素、独立消费者、包体、资源及整仓检查均按各自阶段索引解释，不授予整版资格。G08 的图集使用预乘 RGBA、nearest、首尾 texel 中心；0 为空、正值从 1 编号。原像素容差 1/255、GPU 5% 与各自预算保持；有限容量及原失败的依据保留在机器合同和检查索引。

## G11 组合正确性与修复

[组合示例](../../examples/gameplay-kit/index.html)复用场景、资产、物理、相机、输入、GUI 和音频 owner。安装包的加载／设置、32 角色、512×512 地图、集合窗口和 32 路音频已有正确性诊断；自动事件、静音音频及活跃桌面诊断不替代正式性能或设备资格。

跨场景 GuiSystem 通过同一 tracker 的注册租约保留至最后一条管线退出；SceneOutputPass 销毁解除私有管线引用并丢弃迟到／重复预热结果。损坏音频配置的输入部分提交由示例借原配置 API 回滚。原失败、资源交接和释放计数保留在 G11 索引。

动态 HUD 的布局／树校验、控件身份、重绘成本已进入 GUI P0／P1／P2 修复；当前检查索引记录脏节点清理、保留文字覆盖及按绘制片段更新，并维持同步公开通知与保守回退。原独立候选 `e752a15a` 的资格已标为 `superseded-by-gui-p2`，短入口有意阻止启动；不能再把旧准备完成解释为新运行时可直接正式采样。

## 干净候选、云端与设备准备

设备包最初绑定候选 `b61b700a`，仅推送独立验收分支 `codex/g11-qualification-023-b61b700a`。3,907 个源文件已绑定；37 处 Windows 换行按仓库规则规范化，仅作用于独立检出。四包确定性检查、51 个独立消费者及 64 项生产依赖审计／SBOM 通过。下文 Windows 复测使用单独冻结的候选。

原候选云端 Engine Fast 通过，完整内容 CI Slow 失败；原始日志、附件哈希及旧失败见 [G11 检查索引](g11-checks.json)。在 10,000 实体／4 镜面／5 次反射／1 视图推进至 20／40 帧后触及 300 秒时限，后续 8 次反射／4 视图及像素检查未执行；31 条进度与五份原始报告保留。

[SwiftShader 平面反射复测](../../artifacts/engine-0.2.3/g11/planar-ci-investigation/forward-occlusion/scissor-retest.json)：`45a1a92` 消除了被证明遮挡的重复主视图片元工作。两个原 runner 分别用 192.3 和 258.8 秒完成同一 300 秒门禁，原场景、样本和画质检查保留。早期软件失败保留，完整软件 CI 仍待复跑。

[设备验收包](../../artifacts/engine-0.2.3/g11/frozen-1793807926852-2ce5ae/devices/engine-0.2.3-device-acceptance.tar.gz)约 18.5 MiB，5,315 个文件经完整解压及逐文件 SHA-256 回读；搬迁后的 Engine／Native 预检通过。包含 Windows 独立入口、Mac 输入法／听音入口和物理 iPhone 锁定构建／收集说明。Native 已刷新同字节 Engine／extensions，三包 885 个安装文件及类型检查通过；旧候选完整备份，TankBattle 原修改保留。真实设备操作尚未进行。

固定灯光输入的归档误移已按原 SHA-256 恢复并保护，原失败保留；运行时、原结果和验收预算不变。

## 未完成的资格

- Windows 候选 `45a1a92` 的 27 组 GUI CPU 采样有 8 组超限；1,000 控件动态布局 P95 为 12.29–13.35 ms（预算 8 ms）。[原样本复核](../../artifacts/engine-0.2.3/g11/windows-performance-45a1a92/failed-cpu-independent-audit.json)保留。`38d9f00` 按原口径[通过全部 27 组及原始样本复核](../../artifacts/engine-0.2.3/g11/windows-performance-38d9f00/gui-cpu-formal-report.json)，1,000 控件动态布局 P95 为 5.76–7.82 ms；1×MSAA 组合验收通过，4×MSAA 在 32 次切换后的[存活输出管线检查失败](../../artifacts/engine-0.2.3/g11/windows-performance-38d9f00/combined-msaa4-formal-failure.json)。独立复现保留；24 次生产场景、580 次既有捕获、其余对照、全局门禁和无发布演练未开始。
- 4×MSAA 的区域缓存因旧场景纹理等待回收而短暂回退；恢复 1× 合成后，旧的 4× 混合变体仍在缓存。隔离补丁在合成路径切换时淘汰旧变体，并保留最终 4× 输出。[原门禁诊断复测](../../artifacts/engine-0.2.3/g11/msaa-output-topology-proposal/combined-summary.json)通过 4× 三轮和 1× 一轮，四个检查点均为 6 条管线，销毁后资源归零。补丁已纳入干净候选 `7236b39`，正式包的 4× 复核也通过；[新入口](../../artifacts/engine-0.2.3/g11/windows-performance-7236b39/start-windows-performance-7236b39.cmd)已完成输入校验，正式 1×／4×MSAA 已通过。
- `7236b39` 的 27 组 GUI CPU、24 次组合生产、580 次既有捕获及七份报告的原始复核均通过；HYA 布局和语料通过。[原运行](../../artifacts/engine-0.2.3/g11/windows-performance-7236b39/qualification-result.json)停在 HYA 首次采样前：旧扩展基线是 0.2.2，脚本误用候选 0.2.3 版本校验。保留原错误和所有报告；[同提交续跑入口](../../artifacts/engine-0.2.3/g11/windows-performance-7236b39-resume/resume-windows-performance-7236b39.cmd)在核对原始哈希后从 HYA 生产开始，全局门禁和无发布演练仍待执行。
- [HYA 频率诊断](../../artifacts/engine-0.2.3/g11/windows-performance-7236b39-resume/hya-gpu-clock-diagnosis.json)：候选的小场景两次可见帧节奏检查均通过，P95 约 16.86 ms。Chrome 最高性能设置和双方相同的 GPU 预热都未稳定住相同的核心及显存频率，不能据此判定 GPU 回归原因或通过 5% 门禁。Chrome 原设置已核对恢复；正式入口仅修正包身份校验，保留原预热、样本和预算。
- Windows 真实输入及 Mac／物理 iPhone 流程继续按 G11 验收。Native 所需 Web Audio 节点图能力须真机探测；现有 PCM 声像或类型检查不能替代混音器宿主资格。
- 当前候选仍需完整云端软件检查。历史平面反射的 300 秒失败及原报告保留，0.2.2 的具名许可不自动延续。

运行编号、逐文件哈希、候选输入、未完成设备及正式入口状态只在 [G11 检查索引](g11-checks.json)维护；本页不重复追加执行时间线。

两份失败／被取代的运行副本和五份无现行引用的旧原型安装缓存已[离线归档](../archive/engine-obsolete-runtime-20261102.md)。原检查身份保持；复核旧文件时按索引映射读取或恢复，当前候选仍重新准备。
