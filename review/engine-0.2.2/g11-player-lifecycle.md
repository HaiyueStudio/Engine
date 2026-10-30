# G11 Player 生命周期与资源边界

问题：宿主在 `subscribeActions()` 中同步取消创建，Player 已先清理旧 owner，随后返回的订阅却进入了不会再次执行的清理队列。原公开评审 tarball 能复现：取得 1 个订阅、释放 0 个、残留 1 个。场景实体插入也存在同类登记边界。

方法：所有新清理项统一经过存活检查；存活时登记，已取消时立即释放。实体／管线项先登记清理再插入，宿主订阅返回后立即检查取消。继续使用原 owner、反向清理次序和诊断；不关闭借用宿主，不改变 API、预算或基线。

结论：修复后的隔离公开候选取得 1 个订阅、释放 1 个、残留 0 个。475 份运行时源文件逐项对照，只有 `Player.ts` 改变。生产源码尚未应用；G11 仍待完整整合和验收。

| 验证 | 结果 |
| --- | --- |
| 原正式构建与严格公开类型消费者 | 通过，零 TypeScript 诊断，原 61 项工厂测试通过 |
| 实际离线 npm 安装 | 3 个包、1,002 份 dist 文件逐项与评审 tarball 一致；56 项原公开测试、3 项取消专项及 8 组模块加载检查通过 |
| 取消／重复释放专项 | 3 项通过，原失败保留 |
| 原生矩阵 | 双 DPR 各 195 项通过，包含真实字体释放、场景插入取消、同场景 Player 像素隔离 |
| 渐变与无原生字体服务 | 双 DPR 各 16 项通过 |
| 连续生命周期 | 双 DPR 各 24 轮，混合创建中取消、GPU 提交后取消、首帧前取消；订阅 24／24 释放 |
| 累积资源／像素 | 每轮 GPU 资源数量和字节不增长，存活 Player 的像素哈希一致；最终资源为 0 |
| 独立最终 PNG | 302 对重读通过，原通道容差 2 保持 |

循环使用实际公开包和默认真实 OpenType 路径，无私有运行时导入。像素哈希用于检查实例隔离，独立画质由原参考图另行核对。有限循环不替代 G12 长期性能及物理 Native 资格；后续 GUI 包体候选为 80,006 B／55,000 B，固定 56 文件协调准入仍待答复。

七部分设备恢复已补齐浏览器证据：原子接入数据、状态、核心动画、布局、交互、语义和音频，使用真实 OTF、SHA PNG N-slice 与借用的 AudioContext。双 DPR 各完成三次实际 GPU 替换，分别覆盖暂停、运行中待提交数据、图像 pending 帧。

恢复后，原逻辑帧及像素保持；排队数据只提交一次，同一个 pending 公开请求可重试，图像替换只改变独立指定的颜色区域。六对最终 RGBA PNG 逐字节一致。事件及音频各发布一次；字体和两张图片各获取／释放一次，音频解码和语义订阅各释放一次，最终 GPU 资源及字节为 0。退役纹理的预期取消诊断保留。

主画布使用 Engine 原 RAF／`after-update` 边界采集，每张图检查背景与非空内容。原夹具绕过帧边界得到的空白参考，以及错误调用订阅句柄的失败记录均保留。本轮不改运行时源码或预算；音频使用零增益实节点，验证调度／生命周期，不替代独立音频波形和物理设备资格。[设备恢复证据与原失败](../../artifacts/engine-0.2.2/g11/public-player-device-recovery-record-1792820073245644500/result.json)。

[证据与哈希](../../artifacts/engine-0.2.2/g11/player-reentrant-lifecycle-record-1792819189730786300/result.json) · [实际安装复核](../../artifacts/engine-0.2.2/g11/installed-player-lifecycle-receipt-1792819360953657700/result.json) · [对原候选的修复补丁](../../artifacts/engine-0.2.2/g11/player-reentrant-lifecycle-record-1792819189730786300/player-reentrant-cleanup.patch) · [完整运行时准入清单](../../artifacts/engine-0.2.2/g11/player-reentrant-lifecycle-record-1792819189730786300/runtime-manifest.json)

音频前置检查问题：异步音频队列尚未执行 pause／stop 时，下一帧从物理 runtime 读取到旧“运行”状态，可先提交数据／事件，再异步拒绝 cue；resume 后则可能反向误拒绝。方法：将本帧已有 transport 状态传给原 batch preflight，保留暂停 cue 的拒绝、实际手势解锁、原队列／时钟及独立 API 默认值。结论：确定性对照复现的四种错误全部修正，六项时序／默认行为、原 23 项音频、61 项公开检查通过；双 DPR 各 8 项实际七部分检查及各 195 项原播放器回归通过，284 对 PNG 符合原容差，其中八对设备恢复／音频重试图完全一致。暂停拒绝保持原帧，显式 resume 后排队动作只提交一次。两份候选源码和五个不变公开声明均已核对，生产尚未应用。

持续更新问题：原 2048 次计划在第 257 次停止，同阶段相隔 128 次更新的 bind group 从 2,049 增至 4,065，增加 2,016；其余资源类型数量和估算字节不变。旧 Animation2D 绘制代次清理缓冲／缓存时没有解除其绑定组登记，tracker 的 Map／owner Set 会继续强引用这些无 `destroy()` 的对象，直到 Engine 整体销毁。这证明登记／原生对象保留，不等同于已证明显存字节增长。

方法：通过现有公开 `@haiyue/engine/experimental` 的 GPU tracker／scope 管理每个 renderer 的绑定组，原提交／取消回调和队列 fence 负责退役；缓存淘汰必须等待其他尚未提交或尚未完成的编码器。临时 mipmap 绑定组随自己的提交完成退役，纹理缓存保留当前／前一帧，详细对象诊断关闭时不登记 scope 或额外队列回调。共享设备 shader／pipeline／sampler 不变，未新增 Engine API 或提交协议。

结论：隔离候选双 DPR 各完整通过 2,048 次更新，每个 DPR 的 1,792 次同阶段资源比较均一致；包含三次实际 GPU 替换、18 次实际音频调度／完成和 2,067 次原子数据通知。28 项 CPU 生命周期检查（八项新增、20 项原掩码）及 61 项公开检查通过；原播放器双 DPR 各 195 项通过。282 对 PNG 符合原容差，其中六对恢复图完全一致，原 276 张播放器图与修复前逐像素一致；最终资源为 0。原失败保留。这是固定有限资产集的更新压力资格，不能代替任意生产场景、G12 时间预算或物理 Native；生产尚未应用。

[前序音频补丁、284 对图像、原失败与资源增长证据](../../artifacts/engine-0.2.2/g11/audio-transport-admission-record-1792833589569632400/result.json)

[绑定组修复、282 对图像与完整更新压力证据](../../artifacts/engine-0.2.2/g11/animation-bind-group-ownership-record-1792834611604392500/result.json) · [当前 22 份 G11 自有运行时覆盖](../../artifacts/engine-0.2.2/g11/animation-bind-group-ownership-record-1792834611604392500/runtime-manifest.json)


图像平台边界：公开 Player 候选现可将宿主 `images.decode/snapshot` 转发到原 core 与 layout 纹理 owner。两种 DPR 下，core PNG、N-slice 与真实字体位图均在禁用全局 `createImageBitmap` 后通过注入入口绘制；各解码四次、快照两次，六份租约全部释放，三次 GPU 替换后画面及副作用次数保持，最终 GPU 资源／字节为 0。额外迟到解码在 Player 取消后返回一份、释放一份，未改变同场景另一 Player。

Native 示例通用适配器复用该端口，复制指定字节视图并管理返回位图的幂等释放；取消前不分配，取消后才返回的位图立即关闭，快照输入仍归调用方。十项严格公开类型／CPU 生命周期检查及双 DPR 各八项真实浏览器 GPU 检查通过；后者使用浏览器位图工厂，不代表 iOS 解码器通过。Canvas 2.1.18 适配源已准备，尚需 Native SDK 构建、SHA 已知向量、音频宿主和物理设备整场景验收。共享准入、包体和完整 G11 门禁仍未完成。[当前 22 份覆盖、288 对像素与适配证据](../../artifacts/engine-0.2.2/g11/public-image-port-record-1792835893379863100/result.json)。


Native 音频问题：现有音效池使用立即播放及秒数估算，不能直接承担 HYA 的采样帧合同。进一步按 npm 实际发布提交核查 `@nativescript/audio-context@1.3.3`：iOS 包装层丢弃 start／stop 的时间和偏移参数，未暴露循环区间；底层未来速率自动化按主队列 60 Hz 更新。因此不能仅凭 Web Audio 风格声明把它转换为完整 `sample-accurate` 宿主。

方法与结论：已新增可带到 iOS 的离线 PCM 探针，检查开始／偏移、时长、停止、定时增益、固定／定时速率及循环区间。真实浏览器七项正例全部逐样本一致，七项丢参负例全部被识别；独立 Python 重算 7,168 个原始样本。精确 SDK TS 类体的桩边界执行另证实参数丢失，二者均不代表 iOS PCM 已通过。iOS 入口仅语法检查，尚需完整原生后端、解码／租约、真实时钟与设备中断验收。两个示例平台模块已改用不同文件名，避免 iOS 解析通用 import 回到自身；原字节有保留，图像十项检查重跑通过。[当前 Native 音频缺口、PCM 样本与源文件迁名证据](../../artifacts/engine-0.2.2/g11/native-audio-preparation-record-1792836537055488800/result.json)。


Native 后端实现已推进到可移植混音内核：固定容量的单渲染线程 C++ 负责采样帧开始／停止、源偏移、区间循环、源采样率转换及定时增益／速率，完成 slot 在调用方领取前保留，避免提前释放借用 PCM。18 项 Windows 原生检查通过，含非 128 帧对齐参数、回调分块不变性、实例隔离、容量拒绝及 10,000 次完整循环；3,584 个样本与独立公式和真实浏览器参考一致。C++ `operator new` 观察为 0，未宣称拦截完整系统分配器。控制／渲染线程桥、AVAudioSourceNode、解码／公开宿主与物理 iOS 验收尚未实现或通过；不改变生产扩展、共享候选及预算。[内核、原始 PCM、编译制品与验证](../../artifacts/engine-0.2.2/g11/native-pcm-kernel-record-1792837070216342400/result.json)。


Native 线程交接问题已补实现：有界 SPSC 将控制指令送到原混音内核，PCM 强引用只留在控制线程；队列／内核共同预留未来参数容量，取消不依赖空队列槽位，完成记录被领取后才释放 PCM。原子渲染门禁隔离关闭时的最后一个回调，后续回调只输出静音，静止后才允许控制线程清理内核。当前 32 项原生 C++ 检查通过（18 项原内核、14 项桥接）；双线程完成 20,000 个声音实例，全部 PCM owner 在控制线程销毁，渲染段 C++ `operator new/delete` 观察为 0。3,584 个 PCM 样本与前内核及真实浏览器参考保持一致。平台 AVAudioSourceNode、暂停／恢复、解码／公开宿主及物理设备仍待接入或验收，未授予 iOS 资格。[线程桥、源码快照、原始 PCM 与验证](../../artifacts/engine-0.2.2/g11/native-pcm-bridge-record-1792837728067642000/result.json)。


Native 公开音频适配已实现：只消费公开 HyaAudioHost 类型，沿用原音频运行时；借用端口按域分发完成记录，解码取消／元数据错配会释放迟到租约，总线增益不重复相乘。平台 TypeScript 转发显式解锁、原生输出／解码、暂停和关闭，待完成声音为空时停止完成轮询。Objective-C++ 已准备 AVAudioSourceNode、SHA 检查、Float32 解码、临时文件清理、离线引擎采样与中断入口；硬件暂停桥能冻结时钟、在控制线程完成取消并保留其他声音相位。33 项实际 C++ 检查和另 27 项类型／模拟边界检查通过，后者不代表真实 Apple API 或 PCM。[音频源码快照与原验证](../../artifacts/engine-0.2.2/g11/native-audio-adapter-record-1792838957086253500/result.json)。

Native 七部分应用已装配：固定三个公开评审包及依赖锁，使用真实中英文字体轮廓、PNG、WAV 和原 G06 编辑器；复用 Engine update 与原输入宿主。字节预检只补缺少的 SHA-256／base64，保留运行时已有提供方，取消／销毁后等待准备与探针退出再恢复。真实 NativeScript SDK 类型、14 项公开包／CPU／模拟文件边界检查及 iOS JavaScript 打包通过；Native 根测试 172 通过、2 项原跳过。原负速率测试误用已改为检查音频拒绝且状态不变，原失败仍保留。应用已准备七项原生离线 PCM 探针与 Mac 构建入口；Apple SDK 编译、真实模块元数据、设备 PCM／像素／输入及 OS 无障碍仍未通过，不能授予 Native 或完整 G11 资格。当前证据与包体／共享准入边界见 [g11-checks.json](g11-checks.json) 的 nativeStandaloneAppPreparation。
