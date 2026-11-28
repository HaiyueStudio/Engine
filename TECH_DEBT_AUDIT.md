# Engine 技术债现状

2026-11-28。本轮按 F33 → F36 → F37 → F38 → F39 → F40 → F41 → F42 顺序修复。此前 F01–F32、F34–F35 的修复继续保留。本轮未调整公共 API、依赖、生产着色器族配置、基线或预算，未提交、推送或发布。

## 问题、方法、结论

| 项目 | 原问题 | 修复方法与结论 |
| --- | --- | --- |
| **F33 RESOLVED** | specialization 第三个 formatter 遗漏，合法 `1e21` 默认值／override 仍生成非法 WGSL。 | [specialization](D:/HaiyueStudio/Engine/shader-language/src/specialization.ts:71)复用已有浮点 formatter；普通整数输出保持。5 项新增回归及 10 组原生编译通过，原两后端修复保留。 |
| **F36 RESOLVED** | Spine 分页加载失败、取消或 runtime 初始化失败，纹理／缓冲没有 owner。 | [GPU owner](D:/HaiyueStudio/Engine/extensions/src/spine/Spine2DGpuRenderer.ts:141)在交付前负责 atlas 与缓冲，失败逐项回滚；图片取消会移除监听并结算请求，返回后检查 renderer 身份。11 项回归通过；原生上传后的失败、取消与成功销毁均回到初始资源计数。 |
| **F37 RESOLVED** | 创建 action 中途 binding 冲突，保留前面成功 retain 的引用。 | [Mixer](D:/HaiyueStudio/Engine/extensions/src/animation3d/runtime/mixer/Mixer.ts:90)逆序退还本次成功 retain，失败 action 不进入索引；3 项回归覆盖新 binding、共享引用、合法重试和最后释放。 |
| **F38 RESOLVED** | QR／Notification 同步 invalidation 回调销毁 owner 后，仍发布候选资源。 | [QR](D:/HaiyueStudio/Engine/extensions/src/gui-assets/QRCode.ts:17)在通知前登记候选 lease，保留旧 committed lease，通知后核验请求身份并回滚；[Notification](D:/HaiyueStudio/Engine/extensions/src/gui-overlays/notification.ts:18)在挂树前登记 entry，处理取消、同 key 重入和定时器结算。9 项新增回归与原生生命周期对照通过；租约精确释放，借用内容可再次使用。 |
| **F39 RESOLVED** | 卸载／destroy 抛错，跳过其余 owner，留下无法重试的半销毁状态。 | [Scene](D:/HaiyueStudio/Engine/engine/src/scene/Scene.ts:137)、[Engine](D:/HaiyueStudio/Engine/engine/src/core/Engine.ts:396)、World、PluginHost、SceneAssets、Entity 与 SceneFlow 先失效、逐项清理、完成解绑后报告错误；私有 Cleanup 仅异常时分配错误数组。5 项新增回归覆盖插件、共享 System、层级组件、世界资源和保留场景。单个错误原样保留，多项错误聚合；借用 target 不扩大释放范围。 |
| **F40 RESOLVED** | IR 接受越界 i32／u32／f32；合法 i32 最小值却生成非法 WGSL。 | [共享数值准入](D:/HaiyueStudio/Engine/shader-language/src/numericValue.ts:1)贯穿 IR 标量／向量、外部 IR、Graph 和 specialization；f32 保持既有舍入口径，越界拒绝。WGSL 下界采用等价合法表达式，不拒绝合法值。17 项新增回归和含 F33 的 21 组原生编译通过。 |
| **F41 RESOLVED** | payload 覆盖内部 version／id／type，回包与 pending 身份不一致。 | [WorkerChannel](D:/HaiyueStudio/Engine/engine/src/async/WorkerChannel.ts:136)最后写入协议字段；2 项新增回归证明请求可完成、可取消、可销毁，无 pending 残留，调用方 payload 不变。未知迟到回包继续丢弃。 |
| **F42 RESOLVED** | 在结构、未知字段和聚合限额检查前完整 structuredClone。 | [parser](D:/HaiyueStudio/Engine/animation-spec/src/state-machine-v2/parser.ts:28)先只读准入，之后复制并复核实际快照，复用同一校验器避免两套规则漂移。5 项新增回归证明超额普通 JSON、4,096 channels、16 MiB 未知字段及跨 clip track 超额都在 clone 前拒绝；合法文档复制一次，调用方不被冻结，输出保持隔离并深度冻结。 |

## 验证

- 完整类型检查、**3,067 项测试（新增 57）**、全量构建通过；116 个示例目标已重建。Spine 最后职责调整另经 Extensions 完整类型检查复核。
- 原 Shader Language 静态／生成检查与 **Stage 14 全部 25 节点**通过，双后端像素差 **0,0,0,0**；另补 21 组原生 WGSL、8 组原生 GLSL 边界编译。
- 原生生命周期 8 项通过；GUI 的深色、浅色、日历和 Tour 四组原有像素／交互门禁通过，像素预算保持。
- 正式四包重复打包 SHA-256、实际安装消费者、类型／Node／CLI／浏览器 bundle 与原包体预算通过，共 68 个消费者。开发目录原始 pack 的 sourcemap 诊断失败单独保留，不替代正式 staging 结果。
- 公共 API、602 模块依赖、职责边界和同步 prepare 检查通过；93 份生成文件逐项哈希不变。


本轮共新增 **57 项回归**。原生资源对照使用实际 Chrome WebGPU 和 HTMLImageElement，故障只在图片完成／错误与取消时机注入；共享审计 GPU 的单元计数仍与原生证据分别保存。Shader 原生验证是编译正确性，不是新性能基线。

F42 使用同一只读校验器在复制前准入、复制后验证快照，以防宿主／可执行输入在两次读取之间改变。没有据此宣称合法文档解析更快、峰值堆内存下降或常态 FPS 提升。

完整命令、输入哈希、原失败与限制见 [修复证据](artifacts/tech-debt-audit/20261128/f33-f42/completion.json)。修复前的独立复现见 [复审证据](artifacts/tech-debt-audit/20261128/re-audit-02/completion.json)；其中探针 exit 0 代表成功复现原缺陷，不能解释为修复通过。

## 保留的设计与开放问题

- List 呈现／绑定分离、布局与交互可见性分工、GPU 录制快照、latest-wins 的取消与身份检查均保持。
- 满额 Worker 队列仍先执行背压，不改成优先替换旧请求；这一优先级尚无明确合同，继续作为开放问题，不并入 F41 修复。
- 历史发布记录保留当时的版本和身份。Mac／iPhone、正式压力测试与发布资格不在本次修复验证范围。

## 历史资料

- [F33 残留及 F36–F42 修复前审计原文](review/archive/tech-debt-audit-findings-f36-f42-20261128.zip)／[逐文件 SHA-256](review/archive/tech-debt-audit-findings-f36-f42-20261128.json)：20,315 B 原字节已压缩并回读验证。
- [F01–F35 修复至本轮复审前的完整原文](review/archive/tech-debt-audit-through-f35-20261128.zip)／[校验清单](review/archive/tech-debt-audit-through-f35-20261128.json)。F33 的旧完成判定以后续残留及本轮补修结论为准，不删除旧记录。
- [更早 F01–F26 原文及清单](review/archive/tech-debt-audit-through-20261126.json)；[F27–F29](artifacts/tech-debt-audit/20261128/f27-f29/completion.json)、[F30–F32](artifacts/tech-debt-audit/20261128/f30-f32/completion.json)、[F33 两后端及 F34–F35](artifacts/tech-debt-audit/20261128/f33-f35/completion.json)的原修复证据保持原路径。
