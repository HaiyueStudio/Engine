# HYA 0.2.2 公开能力与格式合同

问题：已有 schema、parser、独立 runtime、真实绘制和公开包的覆盖不一致；参数化字形矩形、哈希色及私有测试不能证明生产支持。

方法：[ADR 0134](../../docs/for-ai/adr/0134-hya-production-composition-contract.md) 准入具名格式与 API；[机器合同](../../config/hya-022-contract.json) 是逐能力、路径、版本、配额和责任的执行源，[声明草案](hya-api-draft.d.ts) 给出 G11 的具体输入／输出。这里固定语义，不复制每轮进度。当前实测结论最终写入 review README／g10-checks.json。

## 能力边界

机器矩阵的每行分别记录 schema、parser、codec、runtime、当前公开入口和 0.2.2 正式资格；有源码或旧测试不提升最后一列。当前 40 项均有失败码、path、capability、责任 Goal 与验证入口；源码模块清单和全部 core Component 接口逐项映射到这些行，新增模块不能自动落入“无未分类”结论。

每行的 example 单列现有 manifest 示例及准确覆盖范围；没有该能力专用公开示例时明确记为缺失。evidence 区分现有模块测试与待补生产证据，尚无正式 0.2.2 资格。failure.status 区分原 parser／runtime 诊断与 G11 尚需实现的 preflight；path 模板必须在失败时替换为实际文档／选项位置。待集成的 `/layout` 只列 plannedEntries，不混入 current.publicEntries。

- 保留 core 变换／图形／文本、safe text IR、旧状态机、3D 与 sampled deformable 的既有入口和失败语义。
- core 粒子、时间线音频与合成／效果单列其既有限制；带遮罩的粒子仍明确拒绝。它们不等于新 audio-events 或可混合 state 通道。离线转换、Lottie 与需许可 evaluator 的 clip-baked 也单列为构建期能力；不作为播放时的 source runtime，原 strict 诊断／TypeError、资产哈希与旧 cubism facade 保留。
- G11 必交付文本／布局／数据／交互／语义／音频的统一 owner、真实字形／图像／N-slice，以及机器清单的 paint／text 状态路径；不能仅把旧 evaluator re-export 后称为生产支持。
- 私有 parameterized rig、vector visual 与脚本／WGSL 的历史代码、格式和 M07 记录保留；它们不是当前组合信封的内置可执行 part，不自动进入新生产 profile。core 已支持的 vector／path 能力不因此删除。脚本 VM、自定义 WGSL、来源 runtime 和任意 Rive full-fidelity 不准入。
- `schema:null` 表示该 sidecar 目前以 typed parser 为规范，没有宣称独立 JSON Schema；不以缺失字段隐藏能力。组合 JSON Schema 只提供编辑形状，引用、预算和真实功能检查仍由 parser／G11 preflight 执行。

## 格式、扩展与身份

新信封为 `haiyue-composition@1` 的确定性 UTF-8 JSON。旧 core JSON 1.0、HYA container 1／2、HYLA 1.0、HYRG 2.0 与所有既有 sidecar major 继续分别解码；新信封不改旧 binary header、字节池或 codec。不把 npm 版本当作任何数据版本。

根字段精确为 `format/version/parts/targets`。每个 part 精确为 `id/extension/required/requires/dependencies/document`；文档由原 parser 验证。七个内置格式 ID 见机器合同；`org.haiyue.animation-core@1` 只是组合槽 ID，不写入旧 core 的 extensionsUsed。需要旧 core 扩展时通过 `coreExtensions` 注入原 registry，不能替换原 parser。

part ID 唯一；requires 和 dependencies 无重复，依赖必须存在且无环。数组顺序保留，字典键按 UTF-16 字典序编码。对象共享引用按 JSON 值展开，循环、稀疏数组、隐藏属性、访问器、符号、非有限数、非普通对象及危险原型键拒绝；先检查整棵 JSON 再克隆和调用格式 validator。JSON 数值按标准 JSON 编码，原 binary 的位模式不经信封重写。

`targets` 为稳定别名；每项精确包含 `id/part/kind/address`。address 是独立字符串段，原 ID 中的 `/` 等字符保持原义，不拼接为成员访问路径。

| kind | 所属 part | address |
| --- | --- | --- |
| animation-node | core | `[nodeId]` |
| layout-node | layout | `[artboardId,nodeId]` |
| text-block | layout | `[blockId]` |
| asset | core／layout | `[resourceId]`／`[assetId]` |
| state-input | state-machine@2 | `[machineId,inputId]` |
| interaction-target | interaction | `[targetId]` |
| semantic-node | semantics | `[nodeId]` |
| audio-cue | audio-events | `[cueId]` |

已知格式的别名必须指向真实对象。数据 binding.target 必须是已声明别名，跨 part 时必须显式依赖目标 part；可选目标被跳过后，依赖闭包一并失效。其他交互动作、语义 target、状态 path、宿主 converter／URL／geometry 等交叉端口在 G11 创建 owner 前逐项 preflight，不能仅凭格式通过创建半个场景。

## strict 与能力协商

默认 `strict:true`。未知必需 part 无条件失败；未知可选 part 仅在显式 `strict:false` 时跳过。原文留在 document，返回 `W_HYA_COMPOSITION_OPTIONAL_SKIPPED`，plan.complete 为 false；任何 skipped part 不创建 owner、目标或资源，且不得声明完整／full-fidelity 资格。已知 part 的非法 payload 即使 optional 也失败。

协商同时检查 part.extension 与 requires 中每个 capability。格式验证与宿主能力分别检查；validator 存在不代表可画 glyph、可调度音频或有 Native 输入。自定义 validator 是调用方显式注册的可信纯函数，收到冻结副本；不覆盖内置 parser，不从数据执行代码。

plan.complete 只表示声明协商没有跳过项，不证明实际 feature 可执行。G11 必须按矩阵提取文档所用 feature，并检查真实端口、通道和资源；宿主提供一个 capability 字符串不能覆盖 reject 项。缺少条件、converter、custom action／geometry／URL 端口在 owner 创建前失败，不运行来源脚本补齐。

默认 hard ceilings 来自机器合同，调用方只可收紧。既有 sidecar 自有预算继续生效，新信封不放宽它们。总 JSON、深度、节点、字符串、part、target、依赖和能力数量在资源 materialization 前检查。

## 执行阶段

同一 `advance(sequence)` 按下列顺序，所有 part 的每个阶段完成后才进入下一阶段；各阶段内部采用稳定依赖顺序和原数组顺序。

1. **input-queue**：只接收 G05 GUI 已路由到本实例的逻辑输入／UI action；GUI 已消费的事件不再派发场景。文本预编辑由 G06 拥有，只在提交时进入数据值。应用、键盘、手柄、语义动作不增加第二个设备采样器。
2. **atomic-data**：提交输入与调用方排队事务；set／trigger／list／group 按事务序执行，失败整笔回滚，转换端口也完成 begin／commit／rollback。双向回写带事务／来源代次，不能递归重入；列表和组件重绑定按稳定实例 ID。
3. **state-timeline**：把已提交数据传给既有状态机／sampler／mixer，先处理触发再求值；连续值复用既有 override／additive／mask 规则。v1 在新组合 owner 中只做一次适配，不再实现一个 sampler；旧独立 API 保留。
4. **text-layout**：用同一帧的字符串／语言／字体／列表／组件代次整形，复用 G02 核心及显式 hya-v1 映射；修改文字度量或资源固有尺寸才重排。输入命中、caret、语义 bounds 与绘制来自同一份几何。
5. **geometry-draw**：构建真实 glyph outline／bitmap、图片及 N-slice UV，保持裁剪／顺序／未预乘 sRGB 颜色与透明度。renderer 边界才预乘。资源未就绪不伪造哈希色；必需资源阻止首个合格帧，可选失败明确报 degraded。
6. **observable-commit**：提交数据 observer batch、事件、语义 snapshot、音频命令及区域失效。用户 callback 触发的写入只排队给下一 advance。阶段失败不发布半帧观察结果；已提交后的用户 callback 异常有诊断且不能重发本帧副作用。

sequence 是递增安全整数；重复同一 sequence／相同输入返回同一帧，不重复观察或 side effect；同序列不同输入失败。数据、语义、布局的公开快照不可变。Player 只暴露其 data 的排队／读取接口，不允许调用方推进或销毁其子 owner。

## 时间、seek、loop 与事件

时间为有限秒数，viewport 为逻辑像素，DPR 只用于采样／呈现。新 Player 以非负有限 delta、rate 和内部 composition clock 推进；每帧保存有界事件 token，不新增来源时间分支。

- play 从初始姿态开启新 epoch；pause／resume 保留姿态、数据与 token，不补发暂停期间墙钟事件。stop 释放活动声音／捕获、回初始姿态，保持停止；下一 play 才重新开始。
- seek 是**静默重定位**：保留当前已提交数据／输入值，丢弃待消费 trigger，从初始状态以固定种子和当前输入重建到目标时间。它不是历史用户输入录像回放。即使 paused／stopped，也必须更新到指定姿态并恢复原播放状态；不提交经过区间的 entry／exit／report／audio 一次性事件。
- seek 开启新 epoch 并重新锚定活动的持续声音；后续正常正向跨越时才发出该 epoch 的事件。禁止直接透传现有 runtime.seek 的 effects 列表。旧独立 runtime 的行为保留并在 G11 adapter 中修正组合语义。
- 正向事件区间为 `(previous,current]`；新 play 的 t=0 事件只发送一次。loop 分段：duration 事件属于旧圈，0 事件属于新圈；同时间按 part／instance／layer／source sequence／declaration order 排序。
- token 至少包含 player generation、epoch、part、instance、layer/action、loop 和 event ID。seek／设备恢复不补发一次性副作用；单次跨度触及事件预算时失败，不删事件或截断分母。正 rate 变更不重置 token。
- 无音频的反向播放用既有 sampler 静默重采样，不发一次性事件；方向切换建立新 epoch。当前音频后端仅接受原速率范围，反向或不支持的 rate 在变更前以 `E_AUDIO_RUNTIME_PROFILE` 拒绝，不能静默静音后称为完整支持；可选 audio 被显式排除的 plan 已失去完整资格。

## 状态通道准入

只新增机器合同列出的九种 path 模板，`{index}` 为非负组件索引；先验证目标组件类型和宽度，再进 mixer。core transform、opacity、visibility、sprite UV 和 path／vector morph 继续走既有路径。

paint 的 fill／stroke RGBA 与 opacity 使用原连续混合和 clamp；stroke width 非负。text.value 采用 dominant weight、再 action order 的离散选择；fontSize 正数，tracking 有限，color／opacity 走连续混合。文字内容、字体度量变化使布局失效，纯色／透明变化不强制重排。颜色插值保持未预乘 sRGB，与既有 contract 一致。

这不是把旧 registry 的 vector-paint／text-animator 整类改成 full。未列路径和 visual-effect／composite-expansion 继续保留 `E_STATE_MACHINE_CHANNEL_ADVANCED_INLINE_UNSUPPORTED`；资源 overlap、音频不可混合范围的具名失败保留。G11 必须同时保留旧负例并增加九个准入路径的像素／trace 正例。

## 宿主与资源代次

格式库始终可在无 Engine／DOM／GPU 环境解析、编码、协商。纯求值也不创建 canvas／audio；资源或真实字体所需端口缺失时，G11 用 `E_HYA_RUNTIME_HOST_PORT`、准确 path 与 capability 拒绝。render mode 使用已有 Scene／GUI／区域 owner；不以创建第二 GUI 或独立原生监听实现交互。

宿主分别提供资源 acquire、真实字体／glyph、音频、语义和 invalidate。scene、AudioContext、宿主服务、调用方原纹理均借用；只释放 acquire 返回的 handle、订阅与本实例创建的子树／GPU 对象，不关闭共享宿主。Browser audio factory 必须显式接收 AudioContext，实际解锁由用户手势调用；不在 import 时创建音频或加载重型字体后端。

每个异步结果携带 `(playerGeneration,slotGeneration,deviceGeneration)`。替换／取消／销毁先递增代次并 abort；迟到结果仅 release，不能写回旧 scene。借用 handle 按成功 acquire 次数恰好 release 一次；仍在录制或已提交的 GPU 资源沿用现有提交／取消与 queue fence 退役，不能因旧 owner 结束立即破坏在途绘制。

含资源替换的事务先形成有界 intent；全部必需 handle 就绪后，才在下一 advance 一起提交关联的数据 ID、度量和呈现代次，等待期间保留上一份有效快照，frame.ready 为 false 并报告 pending。失败或被更新代次取代时回滚整笔，不发布半笔 observer 通知。replaceResource 的 Promise 表示候选已验证就绪，实际提交仍由 advance 完成；Player 就绪回调必须 invalidate，独立 data 调用方在 Promise 完成后推进自身 advance。

设备恢复只重建物理资源和布局／像素 generation，保留逻辑数据与 epoch，不重放事件／音频。暂停仍允许处理宿主 resize／资源就绪并按需失效；静止时不重复求值／布局／上传。dispose 幂等：清理捕获、observer、语义 actions、音频 voices、异步 jobs、字体／图像 handles、自有 GPU 资源与区域引用。

## 公开与真实素材验收

### 2026-10-23 文字约束与宿主位图视图

G11 补齐发布前 `HyaTextRequest` 的逻辑像素约束与 raster DPR；不增加原定七个符号。未提供约束的旧 TextEvaluator/HYLA 调用保留 authored width/height；exact、at-most、unbounded 显式进入同一换行／对齐／修饰器求值器。生产字体基线与编辑控制使用真实字体 ascent 和 advance cell，不能把字形墨迹左边界当成 caret 位置；公开偏移为 UTF-16，适配到原有 grapheme 索引，不能另建文本编辑器。

Glyph outline 的 commands/values 为字体逻辑像素，transform 把它映射到文字块局部坐标；bitmap 的 transform 映射归一化 quad 到相同局部坐标，UV 决定采样区。rect 是最终轴对齐绘制范围，位图含 antialias/stroke padding。位图已经包含 run 的 fill/stroke，renderer 只额外施加 glyph/node opacity，不能重复乘 paint alpha。DPR 只改变位图采样密度，不能倍增布局、caret 或命中坐标。

2026-10-23 补充：HyaTextRequest 的可选 rasterOrigin 是节点在绘制平面的逻辑原点，只供宿主选择实际物理像素栅格相位；省略时为 [0,0]，返回字形／行／编辑几何仍为块局部坐标。参数必须为两个有限坐标。组合布局把最终安排位置传给字体端口，不能仅按 glyph 自身的小数 advance 栅格化；已保留节点位于 (20.25,12.5) 时原差异为 20 的反例。此成员属于尚未正式集成的七符号草案，不新增符号，也不改变原像素容差。

bitmap.source 改为 value/generation/bytes 的只读借用视图，不再暴露资源 release。唯一 prepared-font owner 释放它 acquire 的资源；调用方不得从一份字形快照销毁共享字体／位图。该结构内联，文字入口不再依赖 hya-player 的类型，纯字体宿主消费不必加载 GUI／GPU／DOM。原 G10 冻结记录保持。

既有 LayoutAssetOwner 完成字节完整性与资产引用，既有 AnimationOpenType 仍按需准备，原 TextEvaluator 提供生产布局。显式 browser font port 仅创建自身 FontFace 和有上限的原生字形位图，固定 CPU raster 避免 Canvas 后端切换改变字体 AA；销毁不清空全局字体集。该内置端口当前明确拒绝 variation、synthetic variant 或不匹配的 missing glyph；通用 HyaFontPort 的准入能力与原负例不因此缩减，完整 G11 仍须补齐相应生产证据。

轴对齐字形的位图缓存键包含 DPR 与平移的小数像素位置；栅格化保留该相位、呈现 quad 对齐对应像素网格，避免 24 px 等常用字号的 fractional advance 被整数原点位图加最近邻平移破坏。原失败及隔离补丁证据保留，不通过选择只含整数网格的字号获得完整资格。

字体像素对照使用自制 MIT OTF/CFF 与独立 browser FontFace 字符串绘制。完整场景在固定不透明背景比较全部 RGBA，通道容差仍为 2；原始透明中间图的 RGB 差异及轮廓／原生栅格差异保留，不能据此宣称透明中间图或最终 Engine WebGPU 合成已合格。

### 2026-10-23 真实文字与组合布局接入

五符号 hya-layout 草案保持原名称；HyaLayoutRequest 补充 selections／cursors／styles，直接转交同一文字 owner，不建立第二套编辑器。布局 owner 借用已准备的 HyaTextShaper；没有必需端口时明确失败，销毁布局不销毁字体或平台宿主。独立布局 frame 的 part 为空字符串，组合播放器再绑定所属 part。

原 LayoutEvaluator 接受可选的实例／节点／measure-arrange 上下文。新生产 owner 通过原 HYA v1 适配与 G02 核心进行有界反馈：先求自然度量，按实际安排宽度重测自动高度，收敛后才递增 revision 和发布不可变 frame；每轮计入原 64 次布局 pass 上限，失败保留上一帧。旧默认 provider 与 HYA v1 的 fill／fraction／Grid 映射不改作完整 CSS。重复请求复用同一帧，只有时钟变化时可复用已确认尺寸和字形；完整组合的增量失效仍需 G11／G12 继续验收。

生产实例／节点 ID 是有长度边界的稳定不透明字符串；调用方使用 frame 中的 ID，不能拼接斜线、@ 或方括号。列表显式字符串 id 在整个输入内唯一，包含暂未进入虚拟窗口的项；未给 id 时保持原位置索引语义，重排保留身份须由应用给出 id。组件替换、输入／事件暴露、原时钟与滚动继续使用旧 adapter。隐藏分支不占流式间距、不测字形。原 250000 节点限额也限制展开帧；glyph／line／instance／虚拟窗口与 N-slice 原限额保持，不以每个模板分别计数绕开总量。

frame 的文本保持节点局部坐标；rect／clip 是布局平面坐标。祖先裁剪取交集，节点 opacity 乘祖先 opacity。N-slice uv 使用 [u,v,du,dv]，负 du／dv 表示镜像，包括末尾部分 tile；旧诊断输出保持。生产 frame 另以可选 clipShapes 保留有序的祖先裁剪矩形及各角半径，clip 继续表示布局平面的轴对齐交集；绘制不得用该交集矩形替代圆角形状。文字 controls 的可选 radius 保留原 input.selectionRadius，省略或零值沿用矩形；字段属于原五／七符号的内联元数据，不增加名称配额。真实绘制桥复用原 Animation2DRenderSystem／路径 tessellator，并按提交、取消和 queue fence 持有旧帧资源；具名像素与生命周期范围见 G11 记录，不据纯 frame 求值授予绘制或正式包资格。非单位根 affine 当前仍明确报 E_HYA_RUNTIME_CAPABILITY，不能静默丢弃 transform；根 affine、完整状态绘制通道、长期缓存退役及 GUI／G06 的统一提交仍是 G11 必交付项。

## 2026-10-23 音频宿主成员补齐

G11 对接原音频调度器时确认 G10 草案缺少动态宿主状态、结束回调、带采样帧的控制和解码元数据。现补齐 `HyaAudioHost` 成员，七个原定音频符号及全部数量、性能和资源预算不变；G10 冻结归档保留。此处仍是发布前草案，实际 exports 与打包准入由 G13 完成。

资源仍由已有 AudioAssetOwner 解析交付与校验 SHA-256，再把原始 encoded bytes 交给 host.decode；引用或 hosted 资源需显式 resolver。decode 返回实际源采样率、声道、帧数与 PCM 字节，不能用宿主重采样后的长度冒充源帧。schedule 使用宿主采样帧的 start/stop/duration、源采样帧的 offset/loop；有限循环次数仍由原调度器计算停止帧。host token 带本实例 owner 代次，不能因两个实例都有 audio-voice-1 而相互覆盖。onEnded 恰好一次，release 幂等；同步结束通知在原调度器登记 voice 后发布。gain 已包含原 bus 链，宿主不能再乘一次。

新 audio owner 准备资源但不因共享 AudioContext 已运行而自动发声，调用方须在实际手势中调用 unlock。该调用立即进入宿主，不排入微任务；暂停、恢复和销毁不 suspend/close 借用的全局 context。宿主再次 suspended 后要求重新显式解锁。命令按序执行，排队数量沿用文档 event-token 上限；同步 setBusGain 与未完成命令冲突时明确拒绝。advance/seek 使用所选 domain 的 time；pause/resume/stop 不推进文档时间。静默 seek 仅重建持续 loop，不回放一次性 cue；暂停中重定位只更新待恢复位置。组合 rate 与 cue rate 相乘，在改变状态前验证原音频 profile；通过原 voice 生命周期重新锚定活动及尚未开始的声音，不新增时间线采样器。旧独立 API 保留其默认传输语义。

显式 Browser host 的默认 resolver 仅接受同源 HTTP(S) 且 encoded bytes 不超过 64 MiB；跨域、hosted 与未规定声道排列的裸 PCM 需要应用显式端口，不能假称通用支持。原生 Web Audio playbackRate 是 k-rate 控制，沿用其 render-quantum 精度；调度起止及 gain 的采样帧语义单独验证，不能把量子对齐的 rate 实验宣称为任意帧精度。源采样率不同于输出时使用只做 decode 的 OfflineAudioContext 保留源帧单位，不创建另一调度器。

精确符号预算为 55／9／7／5／9／7，无未具名增长额度。新 API 进入 focused 入口，不复制既有 root／animation／hya-state-machine 名称；源码 facade／草案／隔离格式包不等于官方 tarball。G13 原子修改真实 exports、declarations、预算和 consumers。

| 验收组 | 必须覆盖 | 权威证据与 owner |
| --- | --- | --- |
| 格式和旧版本 | HYA 1／2、HYLA 1、HYRG 2、七种 part、未知 major／required、JSON 与引用预算 | G10 旧测试＋新组合 parser；原 codec／负例保持 |
| 小型交互产品 | 数据→状态→可编辑长文本／RTL／列表→真实图像／N-slice→语义／音频；G08／G09 组合 | G11 固定自有 MIT composition 及每个外部素材的许可／SHA；G12 产品／tarball；G13 Native |
| 真实小／大动效 | 固定 manifest 全部 23 项及原分组／支持／degraded／失败；重点 ID 见机器合同 | G12 核对来源 revision、许可文本、原 bytes／assets／独立 reference SHA；不可只跑重点项 |
| 首载／按需 | download／parse／prepare／font-ready／first-usable-frame 分开；不用文本／布局的页面不加载其 parser／OpenType | G12 从实际 tarball 记录网络与模块图，G13 汇总 |
| 稳态／增量 | small／1k／10k diagnostic／多实例三轮；static 零求解／上传，视觉变化零布局，动态区配对 | G12 保留 CPU／GPU／queue wait／draw／upload／allocations 和全部原始样本 |
| 资源／恢复 | 反复加载／重绑定／替换／销毁、pause／resume、pending frame、device loss | G11／G12 零残留与完整峰值；G13 实际宿主 |

字体参考必须使用真实字形及固定字体版本／fallback／shaping tuple，图像和 N-slice 用真实像素与 UV；不能跟同一个占位绘制器自比。主 manifest 中 `large/footage-images-text` 的 degraded 标签和已有失败分母保留，不因 parser 可读而升格。现有字幕字体许可按 manifest 的 OFL 项分别核对，其他资源继承各自 source license，不混同为工具代码许可。

G01 布局预算、8 区域／64 MiB 缓存口径、总 GPU 资源与原生产流畅度／画质／GPU 门禁不变。新的 entry 字节限额由 G12 在候选优化前测量，G13 准入，不在超限后放宽。微基准、10k 或本机 audit 结果不替代真实设备与正式资格。

## 交付责任

G10：冻结本页、机器矩阵、ADR、具名声明与 consumer 草案；验证格式机制／旧版本／限额／独立性。G11：实现所有 deliver 项、逐文档 feature／port preflight、阶段 owner、真实绘制及同步反例。G12：正式增量、资源、许可素材、按需与真实产品／tarball 证据。G13：实际公开准入、跨平台／物理 Native、完整全局门禁与可恢复候选。格式可读、source-only 类型检查或旧 M07 通过均不能提前完成后续 Goal。

### 2026-10-23 数据作用域与排队事务澄清

组合允许多个数据 part 使用相同的本地 ID。拟议 data 入口的实例、binding、group 与 component 引用保留字符串简写；只有唯一匹配时才能使用简写，重名时使用 `{part,id}`，不通过拼接路径改写原 ID。change 增加所属 part，transaction 标识原调用方收集的整笔事务。standalone data 的 part 为空；Player 的 data 仍不暴露 advance/dispose。

原 group(id) 草案遗漏了模型实例，而原 property group 格式仅包含相对属性路径，无法推导其作用域。现修正为 group(id, instance)，明确选择模型；跨数据 part 的一笔事务先全部准备，任何目标失败则全部回滚。这里修正未发布的声明，不改变旧独立 DataBindingRuntime API，也不增加原九个 data 符号。正式包准入仍由 G13 负责。

run 的用户 callback 在收集时仅执行一次；纯数据命令进入有界队列，prepare 失败重试命令而不重跑 callback。observer 回写只排入下一帧，异常独立诊断。prepared 转换结果按 binding 与实际解析的模型实例缓存；组合插值先读取本帧目标，再用当前 delta 推进原有插值算法一次，旧独立调用默认语义保持。作用域文字／列表／组件输入仍复用原布局和 G06 编辑接口，不增加设备采样器或编辑器。

### G13 准入提案：独立工厂和显式资源目录

问题：独立 data 文档没有资产目录，原资源端口需要的 SHA 无法从模型 ID 推导。此前仅有类型草案的五个子路径也需要真实工厂及生命周期归属。

方法：五个原定入口复用原文本、布局、数据、语义与音频 owner；不增加公开符号。为 createHyaData 的 options 增加可选 resourceCatalogue（kind／id／SHA-256）；本地根使用空 part 命名空间。资源准备 Promise 仅表示就绪，advance 才与排队数据提交。取消／替换释放迟到租约；缺目录／资源身份明确失败。布局 node／instance 的可选 transform 暴露已验证的根仿射变换，局部 rect／glyph／clip 口径保持。

结论：这是待协调准入的设计提案。公开符号仍为格式 55 个、运行时 9／7／5／9／7 个；原预算、失败、冻结证据和发布资格不变。独立 data 的提交后观察者或被拒 intent 错误明确带 committed 与 changes，不能据异常重放已发布事务。

### G11 原生字形渐变与上传精度

现有 browser font port 支持与原轮廓桥一致的字形边界归一化线性／径向渐变，保留完整有序色标、重复色标硬边、透明度与描边。径向工作位图计入同一 maxBitmapBytes 上限并立即退役。原 Canvas 字形快照保留预乘数据，避免转换为 straight 后再上传 premultiplied 导致边缘量化；编码 Blob 仍沿用原 straight 解码口径。渲染 layout 渐变、宿主具备原生字体服务且调用方未显式提供 fonts 时，公开 Player 按需加载原生字体端口；纯求值及普通轮廓保留原路径。无原生字体服务时保留原轮廓路径与未支持绘制的具名拒绝，调用方端口保持优先。此接入不增加公开符号、放宽预算或授予完整 variation／物理 Native 资格。

### G11 生产文本与公开字体宿主

输入 valuePort 表示整个逻辑值，原始样式 run 不作为固定后缀再追加。未改动字素前后缀保留作者样式，替换继承首个被替换字素的样式；纯插入继承前一字素，段首使用首字素。旧默认参数化求值路径及普通非编辑 run 端口保持，原冻结记录保留。

共享边界来自纯 `@haiyue/engine/text::textGraphemeBoundaries`；按全块字素确定样式归属，再进行固定 Unicode 15.1 段落 bidi 与行重排。原文、逻辑 UTF-16 身份和镜像／实际 glyph 的绘制地址分开，不引入第二编辑器或布局求值器。

HyaTextRequest.editingViewport 是可选的编辑视口请求，返回几何仍为块局部逻辑像素，不乘 DPR。可编辑 GUI 要求同一 prepared-font owner 在 HyaTextResult.editing 中提供相同 text、按 UTF-16 字素边界有序的 carets，以及选区 cells；line 指向返回 lines 的索引。carets／cells 的 rect 均为四元组。字段保持只读、普通数据，无 owner、监听器、GPU 或释放入口；不从 glyph 墨迹猜测编辑几何。无编辑几何的旧宿主仍可用于非编辑文本，接入 G06 时明确失败。错误几何在发布前拒绝，保留上一帧、数据与原输入缓冲；同序列重试只提交一次。

默认轮廓／浏览器端口会核对实际字体资源与样式；不支持的变体轴、合成字重／斜体和省略轴目录的变体字节使用准确 host-port 诊断，不静默画默认字形。通用 HyaFontPort 可以提供真实变体或其他平台整形，须同时承担实际 glyph、度量、编辑几何与租约清理；单个宿主 profile 的资格不代表通用复杂文字或物理 Native 资格。
