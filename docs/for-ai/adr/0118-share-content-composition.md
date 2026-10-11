# ADR 0118：分享内容生成与平台分享分层

- 状态：Accepted
- 日期：2026-10-08
- 入口：`@haiyue/extensions/share-content`

## 决策

分享内容归属 extensions 的可选子入口，提供一次性战绩卡合成、画布截图编码、i18n 文案与版本化挑战链接。
不加入 Engine 根入口，不引入 Native、社交平台 SDK、浏览器分享弹窗或自动上传。
输出是普通文字、URL 与 PNG/JPEG 字节，结构兼容平台层 `shareContent` 的输入。

战绩卡使用 Canvas2D 独立画布，避免修改活动场景 GUI、字体图集或 GPU 渲染计划。
浏览器默认创建 DOM canvas；其他宿主注入最小 `ShareCardSurface` 工厂。
截图只编码宿主给出的画布，不擅自读取全局屏幕或另建 GPU 截图渲染器。
WebGPU 提交后的有效帧由宿主在呈现/释放前交给 `captureShareImage`。

## 不变量

- i18n 文案在编码前同步解析；一次结果不能混合两种语言。字体加载由宿主在生成前完成。
- 一次操作拥有其输出画布，返回/失败后重置尺寸。输入插图借用，模块不关闭外部 ImageBitmap。
- 截图编码在第一次 await 前调用；toBlob 优先，Native 可使用同步 toDataURL。
- AbortSignal 阻止过期结果发布；浏览器已经开始的编码不承诺能在底层中断。
- 画布每边最多 4096、最多 8 Mi 像素，编码结果最多 10 MiB；PNG/JPEG 不静默降级。
- 战绩卡最多四项统计，中英文按测量宽度换行/缩小；最小字号仍放不下时显式拒绝，不截断成绩。
- 挑战链接包含 schema v1、gameId、rulesVersion、mode、seed；解析要求指定 origin/game/rules。
- 链接只解码数据，不导航或启动游戏；链接不含签名，不能作为可信战绩或奖励依据。

## API 审阅

5 个值：captureShareImage、renderShareCard、prepareShareContent、createChallengeLink、parseChallengeLink。
11 个类型，共 16 个符号，归属新的 share-content 能力预算；不增加既有入口预算或运行时依赖。
公开 API、示例及验证见 [审阅记录](../../../review/api/share-content-validation.md)。

## 边界

本轮不提供 QR 编码、视频录制、任意版式编辑器、完整游戏重放、短链服务或服务端战绩签名。
seed 的复现性取决于游戏相同版本生成器；mode/seed 的业务约束由游戏校验。
Native canvas 工厂和帧呈现顺序仍需各宿主集成、真机验证，Web 测试不能代替这些验收。
