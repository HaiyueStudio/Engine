# G11 共享文本基础与生产整形

问题：旧 HYA 的字素、样式 run 和简化 RTL 翻转与 G06 边界不一致；备用字体连字会抢占首选字体，跨字体 kerning 及编译 glyph 的浏览器绘制身份也有误。多 run 输入还有整值错误：原文 `A`、`B` 收到 `AB` 后绘成 `ABB`，无绑定的 G06 缓冲则只初始化首个 run。默认轮廓端口还会忽略不支持的轴、字重或斜体请求，真实变体字体省略轴元数据时也可能被当作静态字体。

方法：通过纯入口 `@haiyue/engine/text` 复用 G06 固定 Unicode 字素算法。全块字素采用起始字符的样式，段落统一解析 bidi levels，逻辑 shaping／换行后逐行执行 L1／L2。保留原逻辑文本，用私有映射记录镜像和实际 glyph；按字体优先级选连字，kerning 限于同字体。浏览器惰性核对实际 glyph 的原生字符地址，无地址时绘制已验证轮廓；原生 FontFace 保留既有径向遮罩，未编码轮廓采用单次渐变覆盖，两画布峰值保持。

生产输入端口替换整个值，文本校验、整形、编辑几何和原 G06 缓冲消费同一逻辑文本；首 run 的既有 reader 别名在组合层归一。未改动的字素前后缀保留原样式；替换继承首个被替换字素的样式，插入继承前一字素，段首取首字素。这是无状态的作者样式投影，不增加编辑器或可变富文本样式 API。旧默认参数化 evaluator 的 `textRunValue` 字节保持，普通非编辑 run 的独立端口保持。此前隔离首 run／尾部断言及报告保留，新生产语义仍待准入。

默认轮廓端口现在复用原惰性解析结果检查实际 `fvar` 轴，并复用浏览器端已有的字重／样式匹配规则；不支持的请求通过准确 path 报 `E_HYA_RUNTIME_HOST_PORT`，不再画默认字形充当成功。[OpenType 规范](https://learn.microsoft.com/en-us/typography/opentype/spec/fvar) 规定有效变体轴由字体本身的 `fvar` 定义；测试使用固定提交、OFL 许可和 SHA-256 的实际字体，不依赖手工省略元数据的自证。通用 `HyaFontPort` 不收窄，实际变体宿主另作正例。

结论：当前为**隔离打包候选，生产源码尚未应用或准入**。最新字距修复相对已验证的公开字体编辑候选只改两份文本实现，其余 384 份扩展源码及五个公开声明入口字节一致。

| 验证 | 结果与范围 |
| --- | --- |
| 字素／样式基础 | 1,187 项固定 Unicode 语料、8,646 种切分、1,187 项逐 UTF-16 单元样式及 11 项端口／编辑投影规则通过 |
| 当前公开包 | 正式构建、严格公开类型及 61 项工厂、26 项原文本通过；前序跨样式真实 OTF 6 项及字体优先级 8 项资格保留 |
| 当前多 run 值 | 5 个公开场景的 20 帧通过；完整输入、空值、首 run reader 别名及非编辑绑定正确，无旧尾部追加 |
| 前序多 run 浏览器输入 | 双 DPR 各 12 项 G06 检查通过：预编辑零写入、提交一次、取消、删除到空串、外部同步与无绑定初值；双 DPR 各 8 项原 RTL 编辑通过 |
| 前序字体 profile 绘制／生命周期 | 双 DPR 各 195 项原生组合及 16 项原渐变通过；308 对 PNG 独立重读最大通道差异 2；六张新增原生变体对照完全一致，原生回归 GPU 残留 0 |
| 当前字体 profile | 默认公开端口 7 项、精确浏览器宿主的缓存／清理 7 项通过；失败不销毁上一有效位图，变体准备失败无句柄／FontFace 残留 |
| 当前显式变体宿主 | 双 DPR 各 5 项通过，实际 wght 38／88／250 的 advance 为 14.290／15.060／15.580；其余全部轴显式固定到字体默认值，字体租约只释放一次。仅为单 glyph 显式宿主对照，不代表通用生产变体整形或 GPU／Native 变体验收 |
| 当前惰性加载 | 9 项通过；无 DOM 纯求值保持，OpenType 按需加载，导入／纯求值不加载浏览器字体宿主 |
| 前序字体资格 | 双 DPR 各 8 项实际字形身份、位图预算／缓存保留及 GPU 对照通过；316 对 PNG 最大差异 2；有界原生 glyph 识别 7 项通过 |
| 当前实际 GPOS／字距 | 7 个公开位置／开关／换行错误已复现并修正；3,279 组生产序列对照及 3,279 组旧 evaluator 完整输出差分通过；原 26 项文本及 61 项公开检查通过 |
| 当前双后端绘制／G06 | 双 DPR 各 24 项 Latin／Hebrew 字距、逻辑对齐、样式边界与换行检查，以及各 195 项原播放器检查通过；每个 DPR 的 30 次原 G06 光标投影均正确，原生 responder 始终只有一个；324 对 PNG 独立重读符合原容差 2，其中新增轮廓 24 对完全一致；GPU 残留 0 |
| bidi 基础 | 同一 Unicode 15.1 私有 kernel 通过 91,707 条字符、770,241 组方向测试及全部 1,114,112 个码位属性；许可完整保留 |

字距问题与修正：原实现把字对调整加到后字形的 advance，总宽度可能正确，但实际字形和 caret 错位；软换行后也会残留上一行字距。生产路径保留自然 advance，在同一整形 run 的行内把调整计入前字形，软换行和 bidi 排列后重算；`kern:false/0`、`liga:0` 正确生效。旧默认 evaluator 分支保持。旧字体优先级断言 `[16,8]` 固定了错误分配，只更正该项为 `[12,12]`，总宽度仍为 24；其他七项、原失败和独立 GPOS 字体证据保留。[OpenType kern 说明](https://learn.microsoft.com/en-us/typography/opentype/spec/features_ko#tag-kern)建议以首字形 advance 调整字对，实际自制 CFF／GPOS 字体的独立读取、原生宽度与像素同时验证该结果。

新增实际绘制按后端匹配参考：纯色默认轮廓使用独立作者矩形与 GPOS 位置，平坦渐变触发真实浏览器位图并使用独立 FontFace。初次混用栅格器差异 73、误把带 padding 位图矩阵原点当逻辑 pen 的夹具失败均保留，像素容差未变。这仍只验证已声明编译字对及这些真实资产，不代表任意 GPOS 查找、复杂整形或物理 Native 已获资格。

RTL／换行补充：原实现在视觉重排后反查字对，导致 Hebrew 字距归属错误、可容纳的字对提前换行，RTL 的 `end` 也错误靠右；高行高单词移到下一行后，上一行仍保留其高度。现在在原 glyph 上限检查后按逻辑索引暂存非零字对，逻辑换行与视觉 advance 使用同一归属；移词后重算原行高度，生产 RTL `end` 靠左，旧 evaluator 行为保持。相对上次字距候选仅改变 `TextEvaluator.ts`，其他 385 份源码及五个公开声明入口不变。最终同一夹具在旧候选复现 12 项失败，新候选双 DPR 各 24 项全过；3,279 组实际 GPOS 序列与 3,279 组旧输出差分仍通过。实际字体显式登记 `hebr` 脚本，原生宽度与像素采用同一字体字节；原 DFLT-only 字体不能充当 Hebrew 字距参考，失败保留。G06 检查分别比较已滚动的绘制坐标与未滚动的字距坐标，复用原输入框及滚动；原坐标断言错误和夹具语法错误保留，不充当运行时失败或放宽容差的理由。

参考按后端区分：默认轮廓用独立作者几何，浏览器位图用独立原生 FontFace；不以同一占位绘制器自比。[CSS 对跨元素字素格式没有规定唯一结果](https://www.w3.org/TR/css-text-3/#characters)，不把该未定义情况用作像素 oracle。旧错误 glyph 差异 240、不同栅格策略差异 73、直接视口裁剪观察差异 8、旧轮廓径向精度 3 和原生径向边缘 50 的原图与失败保留。完整缓存字形后裁剪另行验证，原容差 2 未调整。CDP 原生输入检查不代表物理 IME／iPhone 资格。

当前公开类型补齐 `HyaTextRequest.editingViewport` 与 `HyaTextResult.editing` 两个既有可选成员，文本入口仍为 7 项；58 份扩展 JS 与类型补齐前完全一致。严格公开字体宿主使用真实 wght 38／88／250、固定其余轴，双 DPR 各 25 项通过：同一 G06 光标、真实原生插入、外部同步、错误几何拒绝及同序列重试；12 对实际 GPU／独立原生 PNG 最大差异 1，字体租约各释放一次，最终 GPU 为 0。仅为 A／B／空格的三个固定拉丁配置，仍不代表通用复杂整形或物理 Native。首次参考漏掉作者矩形裁剪而差异 69，原失败保留；补齐参考裁剪后通过，运行时与容差未改。

准入改由 [56 文件统一提案](g11-public-api-admission.md)集中协调，替代此前未答复的 22 文件请求。包含 GUI 依赖边界与随包完整许可，HYA 原 55／9／7／5／9／7 项及 Engine 根 API 保持；额外纯文本符号仍仅为 `textGraphemeBoundaries`。生产源码尚未应用，预算未改。

尚未完成：完整字体 shaping／variation profile、精确生产集成、性能、物理 Native 和最终全局门禁。[GUI／共享文本组合候选](g11-gui-capability-boundary.md)按原脚本裁剪声明后，许可补全后的总字节为 2,015,937／8,395,693，进入原 packed／unpacked 上限；公开类型与运行时字节复核通过，正式全局包准入尚未授予。GUI/font 为 84,532 B／55,000 B，仍失败；原未裁剪诊断失败保留。许可完整的 bidi kernel 单独 gzip 17,075 B 不代表包体门禁通过。全部预算保持。

[当前字体 profile、许可、哈希与 308 对 PNG](../../artifacts/engine-0.2.2/g11/font-profile-record-1792826732098370700/result.json) · [字体端口补丁](../../artifacts/engine-0.2.2/g11/font-profile-v2-proposal/font-profile.patch) · [前序多 run 值资格](../../artifacts/engine-0.2.2/g11/editable-block-record-1792826134623969900/result.json) · [两文件补丁](../../artifacts/engine-0.2.2/g11/editable-block-v1-proposal/editable-block.patch) · [字体资格](../../artifacts/engine-0.2.2/g11/font-priority-record-1792825594110354500/result.json) · [跨样式基础](../../artifacts/engine-0.2.2/g11/cross-style-grapheme-record-1792823677523583800/result.json) · [bidi 资格](../../artifacts/engine-0.2.2/g11/bidi-production-record-1792823060401881200/result.json) · [统一协调证据](../../artifacts/engine-0.2.2/g11/coordinated-admission-record-1792829000912821600/result.json) · [公开字体编辑证据](../../artifacts/engine-0.2.2/g11/public-font-editing-record-1792828947922418100/result.json)

[前序字距修复、两文件补丁、304 对图像与全部原失败](../../artifacts/engine-0.2.2/g11/production-kerning-record-1792831203735909600/result.json)

[当前 RTL／换行修复、324 对图像与 G06 投影证据](../../artifacts/engine-0.2.2/g11/production-bidi-spacing-record-1792832530982623900/result.json) · [当前 G11 自有范围运行时覆盖](../../artifacts/engine-0.2.2/g11/production-bidi-spacing-record-1792832530982623900/runtime-manifest.json)
