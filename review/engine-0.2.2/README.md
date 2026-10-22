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

## G03 GUI 接入与增量更新

问题：旧根节点因任何脏标记递归布局，文字/图片尺寸变化又缺少统一测量失效入口。

方法：Engine增加算法无关的测量与事务式排列接入，校验成员、节点代次和完整矩形后提交，卸载恢复原坐标布局。extensions通过现有公开GUI入口调用G02核心，容器预设映射为同一输入；固定尺寸子树成为独立求解边界，静态和纯视觉变更跳过求解。字体测量复用实际绘制的字形/kerning/换行阶段，手动Label默认语义保留。

结果：自动滚动范围、嵌套偏移、隐藏/锚点、内容最小尺寸、复合控件所有权、暂停与异步资源失效均已接入。GUI适配器16项逻辑测试通过；DPR1/2各16项原生WebGPU实绘验证已采集。playground完成Flex/Grid/原坐标切换、容器与窗口缩放的5项实绘交互；实际Billiards HUD以隔离tarball候选完成状态文字、长文本、窄屏、点击与重挂载6项验证，GPU buffer/texture残留为0。游戏继续保留原坐标默认路径，布局宿主通过可卸载工厂接入，不升级Games全局依赖。原计划的`led-sudoku`目录不存在，实际游戏目标已对齐为现有Billiards。

结论：G03完成。Engine808项、extensions522项完整测试及17项工作区/全仓检查通过；最终构建后的DPR1/2各16项、playground5项与实际HUD6项原生验证通过。浏览器实际加载文件、候选安装字节、当前构建及G02共享核心已逐项核对；逐条审计与证据见[G03记录](g03-checks.json)。静态帧零求解/测量/buffer上传，纯视觉变更零求解/测量，两代设备的buffer/texture残留为0；GPU耗时未采集，CPU与queue/readback等待独立记录，不能据此宣称正式生产性能资格。

边界：Games28目标完整构建成功但仍有既有声明警告；全仓类型检查缺少`extensions/controls`及`canvasFactory`声明，测试另有MUGEN夹具哈希及Valley地图直接存储检查失败。原始失败与日志保留，不能据本次HUD验证声称Games全仓通过。四个新增GUI具名类型和`/gui-layout`包入口仍由G13统一注册，当前通过已有GuiRoot公开方法装配，不更新API基线或发布配置；完整游戏、物理设备及最终生产性能资格仍由G13汇总。

## G04 分区调度与像素缓存

问题：固定 GUI 的重复绘制与连续 3D 耦合；待提交命令曾被后续缓冲、资源销毁和阴影图集改写影响。

方法：由 View／RTT 管理整区域缓存、失效和完整画面合成；静态 GUI 跳过控件录制、布局与上传，全静止时停止呈现获取、编码和提交。按提交／取消边界保留资源版本；阴影图集只在实际冲突时分离，初始化全部有效灯层，保留已提交缓存命中与同编码器复用。

结论：G04 封存源码完整门禁通过，32 组原生 WebGPU 对照共 3440 项全部通过，原始 G04 的 22 项要求逐项复核通过。新增阴影／辅助渲染 144 项像素差异均为 0；各具名生命周期检查的 buffer／texture 残留为 0。证据和逐文件哈希见 [G04 验收记录](g04-checks.json)，原始失败保留。

边界：仍为 experimental 接入，先交付整区域缓存；8 区域／64 MiB、像素容差及 Shader 预算不变，工作／深度资源另计。超设备尺寸且含任意用户后处理的组合明确拒绝。G04 实现与正确性完成；G05 继续负责物理输入／焦点，G13 负责正式设备流畅度、合成成本、包与发布候选，当前结果不授予整版发布资格。

## G05 输入路由与焦点导航

问题：GUI 与场景可能重复响应输入；手柄死区差异泄漏动作，区域卸载残留命中入口，真实按钮的原型访问器又被对象展开丢失，导致按住时逐帧重复触发。

方法：共享输入／焦点域、稳定指针归属和未处理通道；控件优先导航、模态捕获与恢复；活动 GUI 在归一化前捕获映射控件，释放区域时暂停输入。手柄复用宿主采样，显式读取 pressed/value 保存上一帧；原始按键与场景动作分开。

结论：G05 完成。139 项定向、1944 项全仓测试、12 项全局门禁及 194 项原生对照通过，原始 Goal 的 19 项要求逐项复核。真实 Xbox 十字键／确认键分别连续保持 7／10 个采样，未重复触发；两次合法焦点准备后完成八步操作，音量 6、保存／取消各 1 次、场景输入 0，用户确认正常。1242 个文件已压缩归档、解压回读并逐项核验 SHA-256，原件保留。详见 [G05 验收记录](g05-checks.json)。

边界：原手柄脚本因额外的“10 帧等于半秒”及固定总步数限制而失败，原判定保留；本次按原始 Goal 单独审计，不把采样帧数冒充时长。失败包装器没有输出手柄 HTTP／成功清理字段，未重构或伪称存在；源／构建指纹与原生实际加载字节一致，生命周期资格来自具名原生检查。正式入口、跨平台与性能由 G13 集成，Unicode／IME 由 G06 负责；本结果不授予整版发布资格。

## G06 Unicode 编辑与跨端文本输入

问题：按 UTF-16 单元退格会拆坏 emoji；预编辑与提交混用，DOM 对 CRLF 的规范化又使原生选区偏离存储索引。

方法：固定 Unicode 15.1 扩展字素，保留 UTF-16 索引并做边界映射；提交值、预编辑和历史分离，以会话代次拒绝迟到回调。绘制、命中与候选共享光标几何，滚动容器处理遮挡，500 毫秒光标相位才触发绘制失效。UIKit 留在 Native；浏览器使用显式 textInputHost 适配。

当前结论：三击全选已接入单行／多行、只读及密码正文，保留单击定位、拖选和眼睛按钮行为；不修改文本或撤销历史。当前源码通过 187 项定向、1992 项全仓测试、12 项全局门禁及 223 项浏览器／WebGPU 对照；Native 逻辑测试 166 项通过、2 项跳过，iOS SDK 静态检查通过。Windows 真实中文 IME 已在保留的前一候选通过；用户确认 iPhone 横竖屏、键盘遮挡、后台恢复与眼睛居中正常。Mac 原始报告和候选关联尚未同步，G06 保持进行中。详见 [G06 验收记录](g06-checks.json)。

边界：逻辑 RTL 不等于新增完整双向排版或 shaping；固定布局仍需响应遮挡通知。正式入口、性能和发布资格由 G13 汇总，正式 npm 包须包含 [Unicode 完整许可通知](UNICODE-LICENSE.txt)。自动化、合成 IME 和静态声明检查均不替代设备证据。
