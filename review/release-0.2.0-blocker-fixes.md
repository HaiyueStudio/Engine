# 0.2.0 验收阻塞修复

后续进展（2026-09-24）：[正式跨引擎比较、供应链与发布演练](release-0.2.0-formal-readiness.md) 已完成。下文保留本次修复时的原始验收状态与版本边界。

本记录承接 [完整功能与示例验收](release-0.2.0-acceptance.md)，验证范围为 AO、渲染/CPU 基准、像素基线、原生 Mac 性能诊断、Volume 发布接线和 Live2D 资源。日期：2026-09-24。六类功能和接线问题已修复并完成复验；CPU 仍有两项绝对 P95 诊断超标，未执行正式五引擎性能验收，不能据此宣称已满足全部发布条件。

## AO

在本机 Intel Mac / AMD RDNA 1 / Chrome 153 / Metal 上，GTAO 原始纹理几乎全黑；同帧深度、法线和 SSAO/SAO 有效。独立 GPU 纹理读回与 CPU 积分对照表明 GTAO 积分应为正。将有界双层循环的尾部 `continue` 改为等价 `break` 后恢复；方向数、步数、采样、半分辨率及三阶段路径不变。只修改 Shader Language 源码并重新生成产物。

AO-only 示例关闭场景 Reinhard tone mapping，让可见度 1 保持白色；组合模式恢复 Reinhard。原 11 场景验证（算法差异、独立凸体、窄缝、相邻视角、条纹）不调整阈值。修复后 GTAO-only 均值 234.15，独立凸体均值 253.38 / P05 246。

## 渲染与 CPU 基准

- `SceneOutput.renderPass` 独立归入 postprocess，不能计入主场景 draw。每个主视图增加一次 HDR 输出 pass/draw；每个反射视图同样输出到 RTT。反射视图数量和主场景 batching 限制不变。
- Normal 对象记录含 morphWeights/deformationFlags，128 → 160 字节。新增预算单独表示为 `32 * floor((round(entityCount * dynamicRatio) + 2) / 7)`；第 4 材质 lane 的实际变动对象数可由 GPU buffer label 交叉核对。其他 ABI 成本保持原有分项。
- ViewLightUniformBuffer 有三个快照区域，浏览器 steady-state 采样前至少预热三个完整帧。保留冷启动、全部预热耗时及全部测量样本；不删除慢样本。
- 修复灯光缓冲扩容时无条件失效全部缓存的问题：在扩容边界恢复有效记录，旧编码绑定仍持有待退役的旧 buffer，恢复上传完整计入统计。保留原有 3 帧预热，10k / 4 主视图 / 16 反射视图的第 4 帧上传从 217248B 降到 204576B；第 3 帧的恢复成本仍记录为 249984B。测试覆盖扩容后的数据、同次提交变更隔离和资源退役。
- 阴影贴图重绘但采样矩阵/参数不变时不重复上传 PBR shadow uniform。测试同时覆盖实际 bias 改动和已有的阴影缩减清尾行为。
- CPU full-prepare 使用共享 audit GPU 的完整 render 能力、GPU-driven 场景所需 compute 能力及 isolated encoder；没有关闭 HDR 或删掉场景阶段。灯光 CPU 输入改用 Engine 内随仓库分发的 fixture，原 Games 来源路径、字节数和 SHA 保持不变。
- 连续采样还暴露了跨帧复用 encoder 的问题。四种 prepare 基准现在每帧通过 `createRenderFrameContext` 创建上下文、record 并 submit，让计算资源依赖及退役回调归属于正确帧。新增六帧回归检查每帧 encoder/submit 次数和全部结构预算；单帧 lifecycle smoke 仍保留。计时包含正确的逐帧生命周期，不减少采样量或取消资源顺序校验。

## Mac 与像素验收

原生 Mac 符合发布平台条件不代表已经登记固定设备 P95 阈值。未匹配旧设备 profile 的 AMD/Intel Metal 仅可保存 diagnostic 测量，状态为 `not-enrolled`，无伪造的 Apple 设备身份或时间预算。完整案例、样本数和时间通道仍校验。指定 profile、强制预算、candidate/formal、软件 GPU 仍严格拒绝未匹配的配置。正式发布性能门禁仍为同机五引擎比较。

PBR/Fog/Volume 从 PNG 编码哈希改用压缩存储的完整 RGBA 参考：平均通道误差 ≤ 2，偏差 > 8 的通道比例 ≤ 2%。这比现有产品截图的 MAE 14 / 18% 阈值更严格。哈希/PNG 字节数继续留作诊断。缺失/损坏参考、尺寸变化必须失败；测试证明黑屏、局部白块、alpha 丢失不能通过。

已逐图检查 PBR 六种材质模式、Fog 距离/高度/关闭状态、Volume：材质高光、薄膜/透射差异、实例物体及体纹理可见。PBR 控件与中性轮廓断言通过；Fog disabled / maxOpacity=0 仍要求与 noFog 字节完全相同。候选采集、旧基线备份、SHA 和审查记录保存在 `artifacts/release/0.2.0-blocker-fixes/`；审阅后才替换相应参考。仅有哈希的旧基线无法量化历史图像差异，因此不声称已经证明跨驱动逐像素完全一致。

平面反射四幅候选图也已逐一审阅，递归反射、正反面和裁剪行为正确，mirror planner 统计与原基线完全相同。HDR SceneOutput 在输出边界执行 tone mapping / display transfer，中心灰色从旧参考的 20/25 变为 77/78；更新对应参考，保留非黑像素 2%、亮度 ±1、采样通道 ±2 和精确 mirrorStats 的原门禁。原产品四张截图参考未变，AO 截图 MAE 8.365、变化比例 1.09%，在现有阈值内通过。

## Volume 与 Live2D

Volume 从 manual 提升为 full；render target 选择器显式包含 `ktx2-volume`，在干净环境先构建再执行原有像素验证。独立 `verify:volume-example` 同样自行构建。manifest 自动集合现在为 55 个示例（46 smoke / 9 full），其余 manual 不自动执行。

使用现有确定性 capture 和当前 animation-spec 转换器重新生成 Live2D offline 资源。旧 HYDM 为 39260 字节，新版含当前 drawable/mask 表示的 HYDM 为 39276 字节，与 comparison 资源相同；PNG 相同、HYA 仅相对资源目录允许不同。浏览器运行和设备恢复验证通过。

## 复验记录

验证主机为 Intel Mac / AMD Radeon Pro 5300M / Chrome 153 / 原生 Metal；未使用软件 GPU。库与策略测试在工作目录运行，独立源码快照用于清空构建产物后的构建与浏览器验证。

| 检查 | 结果 |
| --- | --- |
| 四库 typecheck / test | 1,278 项库测试通过；示例目录 7 项测试通过 |
| Engine fast 门禁 | 分段完成：首次在两项 localhost HTTP 测试处被沙箱拒绝监听；相同 122 项性能策略测试在允许 localhost 的环境全部通过，随后架构、同步 prepare、能力、文档、API、包范围、Shader 与发布策略全部通过 |
| 补充策略与回归 | 发布策略 65 项、fast 路由 14 项、benchmark 策略 30 项通过；最终 renderer/CPU 专项 11 项通过，包含新增跨帧回归 |
| Shader Stage 14 | 25/25 节点通过；生成 WGSL 356,777 / 360,000 bytes，阈值未改 |
| 渲染基准 | smoke 8 案例、full 8 案例完成独立 cohort 采样，结构和资源门禁通过；P95 为未登记设备的诊断值 |
| 平面反射 | full 48 案例、4 个像素门禁通过；保留原 3 帧预热及预热上传成本 |
| AO | 11 个画面案例、18 个 full GPU 成本案例通过 |
| 像素与截图 | PBR 六模式、Fog、Volume、原始产品像素通过；四张产品截图通过且原截图参考未改 |
| Volume / 示例构建 | 55 个自动示例全部完成构建；含 shared Engine/source viewer 的 57 个目标源码指纹与 bundle 哈希通过 |
| Live2D | 离线/对比同源资源、运行与设备恢复通过；动画对比的 6 个浏览器案例通过 |
| Engine CPU | CI profile 全部 49 案例完成；3 次预热、12 个样本、默认 5 次迭代（保留各案例覆盖），无 case filter；结构预算违规为 0，绝对时间预算有下述两项诊断超标 |

CPU 诊断保留原始样本及预算：

| 案例 | P95 | 原预算 |
| --- | --- | --- |
| `render-product.pbr-material-frame.1000` | 0.953 ms | 0.500 ms |
| `render-product.capability-negotiation.1000` | 2.730 ms | 1.500 ms |

CPU 报告为 `report-only / budget-exceeded`，相对比较为 `ineligible: baseline-missing`，不将命令退出 0 等同于时间预算通过。GPU 三套报告为 `not-enrolled / diagnostic-only`，完整案例和结构检查通过，不声称固定设备 P95 已达标。后续正式发布仍需在最终冻结版本完成同机五引擎性能门禁及发布演练。

### 构建与版本追溯

- 构建、Shader、GPU、像素、Live2D 证据绑定 `7dfdb8ed3ac633079cd8b88a7eb7990494509ed7`。
- CPU 连续采样修复后的独立快照为 `108fab83074ade07a77541e317ca12fd2518df9a`，仅增加 CPU suite 与对应回归测试的变更，Engine/Shader/示例源码未变。最终 49 案例报告记录 `dirty=false`。不将两次快照包装成同一份正式发布证明。
- 示例源码指纹为 `fc136d3ae4cc6ae638e6639d9fed855781877c6dab3d17a9b5c554e5b12b959c`。
- 首轮完整构建在第 20 个示例 `gpu-driven-megabatch` 触发原 60 秒超时，保留前 19 项产物及失败日志。相同输入、构建器和超时下重试该项用时 14.5 秒，剩余 36 项续建完成；最终统一验证 57 项新鲜度。首轮命令仍记录失败，不称为一次全绿构建。
- 原分支与暂存区未改；验证快照只存在于临时 detached worktree。依赖使用本机已安装依赖的独立副本，本轮不声称重新完成 `npm ci` 供应链演练。

原始日志与结果归档在 `artifacts/release/0.2.0-blocker-fixes/clean/`，摘要为 `verification-summary.json`，文件校验清单为 `clean-SHA256SUMS`。首轮失败的 CPU/构建日志与最终修复日志同时保留；旧像素参考及人工审查记录保留在同级目录。
