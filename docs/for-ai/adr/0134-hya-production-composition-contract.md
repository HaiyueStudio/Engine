# ADR 0134：0.2.2 HYA 公开能力与组合合同

- 状态：接受，2026-10-22；依据用户执行 G10 的授权，承接 ADR 0132 的具名 HYA 合同责任。
- 范围：格式和公开设计准入。格式实现归 G10，生产装配归 G11，素材与增量资格归 G12，真实 exports／预算／tarball 与跨端候选归 G13；不表示这些阶段已经通过。

## 问题

HYA core、HYLA 文本／布局、数据、交互、语义、音频和状态机都有格式或模块，但部分只能经私有源码测试。格式可表达、局部求值可执行、公共包可消费与真实产品合格不是同一结论。当前布局诊断绘制的字形矩形和哈希色不能成为生产图像；既有状态通道的 full／degraded／unsupported 也不能因增加 exports 自动升级。

## 决定

1. 新组合信封为 `haiyue-composition@1`，采用确定性 UTF-8 JSON，独立于 HYA core 1.0、HYA container 1／2、HYLA 1.0、参数化 rig 2 和所有既有 sidecar major。不修改旧解码、旧诊断码或旧必需扩展语义。信封组合原有文档，不复制其数据模型／采样器。
2. 信封只保存带稳定 ID 的 parts、显式 required、requires、dependencies，以及跨文档目标别名。别名以分段 address 指向既有节点／文本／资源／状态输入／交互／语义／音频 ID，不通过拼接路径改变原 ID。原 sidecar 的绑定、转换和状态数据仍由原 parser／runtime 解释。
3. 默认 strict。未知必需格式或能力始终失败；未知可选 part 也仅在调用方显式 `strict:false` 时允许跳过，必须保留原文和具名诊断，失去完整资格。已知 part 的非法数据即使 optional 也失败。依赖、重复 ID、引用、未知字段、UTF-8、深度、数量和字节限额在创建 runtime／GPU／宿主资源前检查。宿主能力声明不等于实际文档 feature preflight；G11 必须逐项检查机器矩阵，禁止用 parser 存在证明可绘制。
4. 时间顺序固定为输入入队 → 原子数据事务 → 状态／时间线求值 → 文本与共享布局 → 几何／绘制 → 事件／语义／音频提交。观察者不能重入当前阶段，产生的事务进入下一次 advance。seek／loop／暂停、事件 token、宿主端口和资源代次详见 [执行合同](../../../review/engine-0.2.2/hya-contract.md)。
5. 拟新增 animation-spec `/hya-production`，55 个具名符号（含现有 HYLA 编解码、各 sidecar parser 与 v1 状态迁移）；extensions `/hya-player`、`/hya-text`、`/hya-layout`、`/hya-data`、`/hya-audio` 分别为 9／7／5／9／7 个。精确名称由 [机器合同](../../../config/hya-022-contract.json) 冻结。只准入这些名字，不批量导出私有 evaluator、GPU renderer、sampler、cache 或 source adapter。既有 `/animation` 与 `/hya-state-machine` 名单不复制，纯 `/layout` 不新增 HYA 职责。
6. 新 stable 增量仅按本 ADR 的具名清单进入 0.2.2，不扩大 ADR 0132／Toast 的例外。本阶段不修改真实 package manifests、API 基线或既有包体预算；G13 在声明、真实最小 packed consumer、示例、按需加载和门禁齐备后原子集成。新的源码入口和隔离合同包不是已发布入口。
7. 复用已存在的主动画、v1 适配和 v2 状态／时间线模块，禁止新建第二套 mixer／sampler。G11 补齐机器合同指定的 paint／text 路径；visual-effect、composite-expansion 和未准入路径继续按原码拒绝。资源切换和音频的 degraded 限制保持显式，不能升级整类 registry 为 full。
8. 格式库不依赖 Engine、DOM、GPU 或来源 runtime；OpenType／音频后端按需加载。字体、图片、解码、语义、时钟、资源和平台输入由具名宿主端口接入；不引入 UIKit、来源播放器、任意脚本 VM、自定义 WGSL 或新平台 SDK。
9. animation-spec 因新增格式入口进入 0.2.2 发布清单；Engine／extensions 按 ADR 0132 为 0.2.2；shader-language 字节未变则保持 0.2.1。格式版本不随 npm 版本变更。所有高级能力必须在机器矩阵拥有现状、失败码、path、责任 Goal 和验收入口；不合并 Rive 开发分支、不改写 M07 完成记录或 corpus latest。

## 验证

G10 验证旧 HYA／HYLA 往返、旧版 container、未知版本／必需扩展、不可信输入和核心独立性，并检查逐符号草案及隔离格式 consumer。G11 验证组合执行与真实字形／图像／N-slice；G12 固定实际授权素材、大小分组、像素和 trace、首载／稳态／资源；G13 验证实际包、浏览器／Native、游戏与最终候选。原失败、原预算、原样本分母和原发布资格保持。
