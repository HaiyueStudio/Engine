# Engine 0.2.2 评审与证据

## 问题与结论

G01 冻结共享布局、GUI 八项与分区合同。基点为干净 `dev/0.2.2@7d0df288285834e2583f563478f322fdf6743c09`；原标签 `v0.2.1` 仍为 `e932ef91df917a2d1856155573743f0528035785`。两者间七个 GUI 缓存源码文件已有变化，因此诊断前重建当前 Engine；重建前数据保留但不用于当前结论。

四个布局差异与 emoji 删除问题已复现，独立 Chrome 几何 oracle 全部通过。捕获到缺陷不等于新功能已经合格。现有静态 GUI 仍绘制、纯视觉变更仍遍历布局；销毁后可显式释放的 buffer/texture 为零。sampler/pipeline 等没有 destroy 的 WebGPU 对象，其 audit 计数不能冒充残留泄漏。

## 解决方法与合同

1. [ADR 0132](../../docs/for-ai/adr/0132-gui-layout-interaction-022.md)：模块、版本与具名符号配额。
2. [冻结支持矩阵](layout-contract.md)：新 GUI 与旧 HYA v1 的明确映射、交互/文本/皮肤/分区语义及验收。
3. [机器合同](../../config/layout-022-contract.json)：场景、预算、枚举、缓存限额、设备和版本责任。
4. [API 草案](api-draft.d.ts)：仅供实现评审，不是已发布声明。
5. [HYA 审计](hya-capability-audit.json)：当前源码/exports 哈希、40 项定向测试与后续责任。

GUI/HYA 共用一个来源无关布局核心，以 `gui-v1/hya-v1` 显式配置保留四项旧几何差异。区域使用自有持久纹理，scissor 仅裁剪绘制。Engine 不依赖 extensions，核心不加载 DOM/GPU/HYA/OpenType。原根30符号、包体、依赖和既有生产门禁保持。

## 当前基线

[冻结 CPU/结构诊断](../../artifacts/engine-0.2.2/g01/baseline-frozen.json) 包含27个 HYA cohort（三轮×三规模×0/1/10%变更），每项12次预热和30个原始样本。GUI结构诊断使用共享版本化audit设备，不能测量真实GPU耗时。主机同时有交互应用，属于诊断采集，不授予独立正式性能资格。

| 节点数 | 完整HYA求值P95范围 ms | 静态GUI audit P95 ms | 视觉变化GUI audit P95 ms |
| --- | --- | --- | --- |
| 128 | 1.818–4.205 | 0.051 | 0.267 |
| 1000 | 14.493–19.632 | 0.104 | 1.219 |
| 10000 | 165.456–337.778 | 0.858 | 11.740 |

完整 HYA 求值包含文本/动画，不可与未来纯布局求解直接对比同名时间。静态 GUI 无额外上传、仍有draw；视觉变化仍遍历布局，为 G03/G04/G12 的明确优化对象。

[原生侧栏诊断](../../artifacts/engine-0.2.2/g01/region-baseline.json) 使用实际Canvas字体与NVIDIA/Pascal WebGPU，在1280×720画面中绘制320×720静态GUI及连续变色背景。MSAA1/4各预热60帧、采集120帧，CPU P95为0.340/0.355ms，rAF P95为16.820/16.850ms；两区像素和validation检查通过。动态背景是附件颜色变化，未模拟复杂3D；rAF并非物理扫描，未测真实GPU duration，不能推导任意游戏帧率。

侧栏RGBA8 resolve需921,600 bytes，DPR2为3,686,400 bytes；4×MSAA颜色另占四倍，深度和安全退役另计。新缓存尚未实现，这些是尺寸成本和当前直接绘制基线；G04必须用真实配对场景证明收益。

HUD预算在优化前按16.67ms帧时间分配：layout/measure各2ms P95，GUI update-to-submit 4ms；1k压力两阶段各8ms，仅本机固定场景；10k只作正确性/有界诊断。原生直接GUI的HUD诊断低于4ms，旧HYA高成本不作为放宽预算的理由。生产全帧仍继承既有P95/P99/长帧、画质、资源、GPU合同及具名调查项。

## HYA 完善范围

| 当前观察 | 0.2.2 责任 |
| --- | --- |
| 参数化文本/布局、data/semantics/audio有模块和测试，部分缺focused公开入口；InteractionRuntime已公开 | G10冻结逐能力、格式/组合协议、公开符号及预算 |
| LayoutGpuRenderer用字形矩形/paint与N-slice哈希色诊断；主Animation2D另有真实文本渲染 | G11接通真实字形/图像/UV及数据/状态/布局/输入/语义/音频owner |
| registry明确拒绝vector-paint/text-animator等，资源/音频有degraded限制 | G11补选定paint/text通道；未准入visual-effect/composite仍具名拒绝 |
| LayoutGpuRenderer.upload每次新建buffer；LayoutEvaluator完整求值成本随节点增长 | G12增量求值、buffer容量复用、安全退役及真实资源验收 |
| 独立逻辑测试不足以证明公开包/组合画质/生产素材 | G12真实授权corpus/产品/Native、冷启动/稳态/资源；G13完整集成 |

不合并Rive研发分支，不将converter、任意full-fidelity、通用脚本VM/自定义WGSL或Editor导入纳入本版。G10准入后才实现HYA新入口；animation-spec实际变更时发布0.2.2，格式版本独立。

## 验证与证据

- [几何oracle](../../artifacts/engine-0.2.2/g01/oracle.json)：4项独立参考，含浏览器版本、配置快照和HTTP字节哈希。
- [HYA定向测试](../../artifacts/engine-0.2.2/g01/hya-focused-tests.tap)：40/40，布局、文字、数据、输入、语义与状态通道；不授予组合运行时资格。
- [验证汇总](g01-checks.json)：配置/证据负向测试、文档/API、依赖图、源码不变与哈希审计，完成状态以最终结果为准。
- `baseline.json`为重建前，`baseline-current.json`为合同冻结前；均不推广。原始夹具/启动失败仅保存在artifacts，成功重跑不抹除原失败。

复现入口在[诊断目录](../../scripts/fixtures/layout-contracts/README.md)：

```text
node scripts/fixtures/layout-contracts/diagnose.mjs artifacts/engine-0.2.2/g01/new-baseline.json <verified-current-40-char-revision>
node scripts/fixtures/layout-contracts/browser.mjs oracle
node scripts/fixtures/layout-contracts/browser.mjs region-baseline
node --test scripts/fixtures/layout-contracts/policy.test.mjs
npm run docs:check
npm run api:check
```

G01不开始算法/GUI迁移，不更新真实exports/发布预算或推广正式基线。G02–G09实施冻结GUI合同；用户新增HYA范围由G10先冻结逐符号与组合协议，再由G11/G12实现验收。真实桌面IME、物理iPhone与手柄由G06/G05采集、G13汇总；缺设备证据保持待验收。

M23对M18的发布依赖保持：G01收口时协调状态仍为active，未据旧publisher状态文件推定四包发布完成。正式完成仍需M18 release owner按[发布流程](../../docs/for-ai/release-process.md)核对四包注册表字节/版本、签名标签、GitHub附件和Pages部署对应提交。用户随后明确启动G02；本轮已直接核对注册表和GitHub，extensions/animation-spec的0.2.1未返回可用版本，Release仍为草稿。此事实保留为发布前置事项，不把G02实现验收当作M18或0.2.2发布资格。

## G02 共享核心与 HYA 交接

问题：原HYA求解器耦合格式、文字和实例，无法由GUI独立复用；提取时还必须保留旧文档几何。

方法：来源无关实现位于[布局入口](../../extensions/src/layout.ts)和`extensions/src/layout/`，按盒模型、内在测量、Flex、Grid、输入校验及会话生命周期组织；核心没有Engine/DOM/GPU/HYA/字体依赖。HYA通过[格式适配器](../../extensions/src/animation/layout/parameterized/SharedLayoutAdapter.ts)消费同一算法，原LayoutEvaluator内的Flex/Grid求解已移除，实例、字体、资产、动画、滚动及两阶段输出继续由HYA拥有。旧单位的字段存在性、边距顺序和fraction权重由适配器处理，四个冻结差异由显式`hya-v1`阶段保留；普通会话固定使用`gui-v1`。

结论：共享核心与HYA复用已完成，G03可接入。最终版本通过47项定向测试、506项扩展包测试及9项工作区/全仓检查；DPR1/2各110项原生浏览器几何差分、64组旧HYA几何、7组完整求值、7组配对像素和独立无DOM/GPU消费均通过。兼容配置仅保留四个具名算法阶段，其余旧单位、边距、零inset、默认绝对尺寸、RTL遍历与Grid单元在适配层解码。当前源码、浏览器实际加载字节、独立消费编译字节及检查日志已逐项核对哈希，证据与完成审计见[G02验证记录](g02-checks.json)。像素比较使用既有诊断绘制器；真实字体/图像生产资格仍由G11验收。

G03接入约定：

- 用稳定ID和`contentVersion`提交新树，字体/图像度量代次写入`metricsVersion`；测量器变化也会产生新缓存身份。不要在测量回调内修改树或重入会话。
- 样式尺寸为border-box；回调收到扣除padding/border后的内容区约束，返回内容尺寸及内在最小尺寸。复合节点的自身测量与流式子节点内容共同决定auto尺寸。exact根约束拥有最终视口尺寸；at-most约束收紧主轴后会重测换行高度/宽度。
- 返回只读的根坐标矩形与内容边界；GUI提交、滚动、输入命中和字体异步加载仍由适配器负责。失效后用新版本重算，失败或中止不提交半结果；旧结果保持有效，dispose幂等并清空测量缓存。
- 缓存仅复用度量，未承诺自动跳过每次update的全部求解；静态/纯视觉零求解由G03的失效装配完成，生产性能由后续Goal验收。上限仍为10k节点、128深度、每节点8条缓存和4个约束阶段，没有放宽预算。
- `/layout`的package exports、正式API/包体预算和tarball消费由G13原子集成；当前源入口和独立编译验证不等于npm已有该子路径。GUI装配属于G03，HYA生产绘制/增量属于G11/G12。
