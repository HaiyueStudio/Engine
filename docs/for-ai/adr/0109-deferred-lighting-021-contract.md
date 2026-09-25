# ADR 0109：0.2.1 Deferred 与 Tiled 光照合同

- 日期：2026-09-25
- 状态：Contract candidate；设备基线与格式探测验收后冻结。不是已实现能力，也不是 stable/product 准入。
- 范围：M18 G01；接续 [ADR 0021](0021-benchmark-driven-lighting-shadow-scale.md)、[ADR 0099](0099-view-light-selection-before-clustering.md)、[ADR 0097](0097-auxiliary-mrt-and-frame-resource-dependencies.md)。
- 权威配置：[lighting-performance-021.json](../../../config/lighting-performance-021.json)；当前证据：[G01 交接](../../../review/engine-0.2.1/README.md)。

## 需求与取舍

用户要求 0.2.1 完整渲染上百盏动态局部灯，显式包含 Deferred。现有 Forward 每视图最多 8 灯；已验证真实 billiards 场景的源数据/容量诊断不能证明 128 灯都产生贡献。G01 采集当前 Forward 与已有 GPU 实例基线，G02 提供全灯参考，G03 再优化剔除。禁止把灯数截断后的更快结果作为同工作量比较。

本 ADR 为该用户需求明确新的 Deferred 合同，保留旧 Forward 默认、Forward+/3D Clustered 和 CSM 的独立 hold。两类设备基线、固定案例、容量缺口证据与预算就绪后，G02 可以按本合同实现实验路径；旧 Forward+ 的 product evidence 不能据此伪造为已通过。多灯完整画面、最终性能与发布资格仍由 G02–G07 提供。

使用 Tiled Deferred，不在首版实现 Z slices。首版采用保守的屏幕 tile 光球/视锥相交，不使用 opaque min/max 深度缩短 tile，因而透明前景不被 opaque 深度错误剔除；透明 PBR 首版仍使用全灯表作为明确的正确性路径。低收益场景保留全灯 resolve 回退，自动切换算法只允许在同一 profile 内、结果等价且代价经过实测时启用。

## 冻结的数据 ABI v1

所有字段以 Shader Language 描述符生成 host packer/反射/WGSL；下列偏移是设计合同，G01 不生成生产实现。

### 源灯记录

一个 World/frame 一份 immutable point/directional source，版本、帧号、长度独立保存在 16 B header；每灯 64 B、16 B 对齐：

| 字节偏移 | 类型 | 含义 |
| --- | --- | --- |
| 0 | vec4f | 世界 position.xyz，非负 range.w；非局部灯置零 |
| 16 | vec4f | 线性 color.rgb × intensity，w 保留为零 |
| 32 | vec4f | 归一化方向 xyz，w 保留为零 |
| 48 | vec4u | type（1 directional / 2 point，0 保留）、stable ID、shadow slot、flags |

无 shadow slot 使用 `0xffffffff`。容量为局部 1024、方向 8；ambient 保留 CPU 源记录，在每视图确定有效源后按既有线性加和语义聚合到该视图 uniform，分别统计原始/聚合数量；环境贴图 IBL 继续由原 environment owner 管理。stable ID 为 owner 分配的 GPU u32 标识，不能把任意 JS entity ID 直接截成 u32；复用/环绕必须换 generation。1024 只是本版有界容量，不代表该数量有统一帧率保证。每类超限都返回结构化能力错误或显式受限 Forward 回退，不能截断后声明完整覆盖。

全局方向记录与局部记录分段保存（同一帧 owner、同一 storage buffer）；局部配额不被方向光和 ambient 占用。World source 不含相机选择结果；frame ring 至少覆盖实际在途提交，扩容不能覆盖已编码数据。静态源不重复上传，相机变更只影响 view index。

### View / tile 索引

可见局部 ID 数组为 u32，索引进入当前 source generation；view header 32 B：前 16 B 保存 source generation、局部数、方向数、flags，后 16 B 为 ambient linear radiance.xyz 与保留零。view key 包含 camera ID、viewport、World/视图可见性 revision、projection revision、device generation。现有 RenderView/Light 没有公开 per-light layer-mask API，本版不新增该 API；计划中的 layer 用例验证现有渲染层/视图所有权隔离，不假装已有逐灯 layer 过滤。当前 ambient 有效源遵守 World、disabled/hierarchy 规则，未来新增过滤也必须先过滤再聚合。

tile 采用 16×16 pixels，compute workgroup 64 invocation；每 tile header 为 16 B（offset、accepted count、overflow flag、reserved），与索引同存一个 storage buffer；每 tile stride 528 B。每 tile 固定保留 128 个 u32 槽；只有完整接纳的 tile 才使用这些索引。超过 128 时设 overflow，本帧 resolve 遍历该 view 的全部局部 ID，已写入前缀不再重复计算；方向光独立全量计算。这样避免固定原子分配池溢出后等待 CPU 下一帧修复。

正确性界限：所有有效相交灯必须纳入或触发完整回退；容许保守 false positive，不容许 false negative。GPU 只产统计候选，正式 readback 在诊断时异步执行；正常渲染不得等待 GPU 计数。

### G-buffer 与精度

使用 sampleCount=1，三个 `rgba16float` color attachment（24 B/pixel），一个 `depth32float`（4 B/pixel）：

| Attachment | RGB | A |
| --- | --- | --- |
| G0 | 线性 baseColor | metallic |
| G1 | 世界空间、归一化 normal | perceptual roughness；`-1` 为 Forward-only surface 标记 |
| G2 | 线性 emissive | 计算过 texture strength 的 material occlusion |

背景以 depth clear 判断，Forward-only opaque 的 G1.a=-1 防止 resolve 再次照亮。alpha-mask 在几何 pass 丢弃；alpha blend 不进入上述 opaque G-buffer。normal 读取后重新归一化。保留 RGB 半浮点以免错误夹断现有 HDR 颜色；不在本版压缩法线或 emissive。HDR scene color 为既有 `rgba16float`，另计 8 B/pixel，不把它藏在 G-buffer 成本中。

深度重建统一 WebGPU z∈[0,1]，逆当前 jittered view-projection、viewport origin、投影类型与 reverse-Z 模式都属于 view input；forward Z 清 1、比较 less，reverse Z 清 0、比较 greater。motion 使用现有 current/previous 非抖动坐标合同，不能复用混有 jitter 的矩阵计算速度。正交相机按同一 homogeneous inverse 解算。

配对验证阈值：G-buffer 存储值相对误差 ≤0.001、接近零绝对误差 ≤0.0005；normal 归一化后角误差 ≤0.1°。Reference/Tiled 同 G-buffer 的 HDR 每通道误差 ≤max(0.002, |reference|×0.002)，禁止 NaN/Infinity；有效几何内部 LDR 最大差 ≤2/255，边缘另用冻结 mask，不动态删除失败像素。Forward/PBR parity 允许半浮点量化误差，HDR 相对误差 ≤0.005、绝对 ≤0.003，LDR 内部最大差 ≤3/255；透明累积及 tone mapping 仍要求按同一语义对比。

## 材质与 pass 图

每视图固定以下顺序，具体节点仅在消费方需要时创建：

1. 更新源灯/变形/实例，执行已有方向光 shadow；shadow slots 继续最多 3。
2. Opaque surface MRT：标准 PBR 输出 G0/G1/G2/depth；Forward-only PBR 扩展使用相同几何/覆盖的代理输出 normal/depth 与 G1.a=-1。后者只保存辅助表面，光照另做，不隐瞒额外 draw。
3. 必要的辅助 surface 与 motion 节点：复用语义相同的 G-buffer depth/normal；透明深度写入者、不同排序/覆盖的辅助表面仍独立。motion 有需求时按现有 MRT/历史方案执行，不强制增加第四个 G-buffer。
4. 根据已有 AO 输入语义产生 AO；tile culling 只依赖 view/source，可早于 AO，但必须晚于灯更新。
5. Deferred resolve：标准 metallic-roughness BRDF + 三方向阴影 + IBL/material occlusion/AO + emissive + fog，输出 scene-linear HDR。保留原 BRDF 中直接/间接光遮蔽语义。
6. Forward-only opaque PBR：共享 surface depth，用 equal-compatible 深度测试与原排序规则处理同深度，完整 storage 灯表；不会再由 resolve 处理。
7. 如有 transmission，冻结当前 opaque HDR 的采样副本，再执行现有透射/透明排序，禁止同 attachment 同时读写；透明 PBR 读取完整 view light list。
8. 现有 TAA、motion blur、outline 等后处理按声明依赖执行；曝光、色调映射、输出编码仅由既有 output owner 执行一次。

| 功能 | 承诺 / owner / 验证 case |
| --- | --- |
| metallic-roughness 默认 PBR、UV0/1、sampler、vertex color、double sided、normal map、mask、clipping | G02 Deferred geometry；`material-standard`、`material-mask-uv` |
| specular/IOR 非默认、clearcoat/clearcoat-normal、sheen | G04 Forward-only PBR 完整灯表；`material-extensions`，不简化为默认金属粗糙度 |
| transmission/thickness/volume attenuation、PBR blend | G04 Forward 全灯 + opaque color copy；`material-transmission`、`material-transparent` |
| skin/morph/CPU instance/external GPU instance PBR | G04 同源 deformation/instance ABI；`material-deformed`、`material-instanced`；已有 Toon instance 不新增阴影承诺 |
| Blinn/Toon、Basic、线、Volume、自定义 shader | G04 现有 Forward；默认渲染语义保持，受限灯数/缺少 surface adapter 时报告原因；`material-special-forward` |
| 无法产生兼容 opaque surface 的 renderer | 整个 view 显式降级 Forward 或 strict 模式报错，不能让 AO/depth 错位；不计入完整多灯通过项 |
| 方向阴影/IBL/AO/雾/HDR | G04 既有 owner；`effects-environment`、`effects-output` |
| TAA/运动/outline、反射/RTT | G04 per-view history；`effects-temporal`、`view-reflection`，子视图自行选择 profile，报告 Forward 容量 |

## Profile、资源与失败行为

新增能力的设计入口固定在现有 `@haiyue/engine/experimental/renderer`，以 Deferred profile 工厂表示；普通 root/profile 不静态导入新 shader。工厂接受 baseline profile（batched/gpu-driven）、算法（reference/tiled）、失败策略（strict/forward）；返回 Engine 可消费的 immutable profile，几何提交仍使用原 batched/gpu-driven name，新增 lighting strategy 的 experimental brand/描述独立于 stable RenderProfileName 联合；诊断分别报告实际几何 profile 和 lighting path，不把名称扩张伪装为无 API 变化。G02 创建内部接口，G07 才集成公开导出与 API 评审，当前并无可调用新 API。

只支持 sampleCount=1；MSAA 不会静默改成 1。strict 返回 capability error；forward 保持原 MSAA，并报告请求/生效路径、材质/limits 原因和完整灯光覆盖状态。fallback 不代表 full coverage。每视图若请求条件变化，先失效自己的 G-buffer/tile/history，再恢复，不污染其他视图。

工厂采用异步按需加载新 renderer/shader family，再通过内部 backend port 接入现有 Render3D owner；基础 Render3D 不静态 import Deferred shader。由 packed consumer 实际模块图验证隔离，不凭 tree-shaking 推测。原 simple/batched/gpu-driven profile 无该 provider 时走原 Forward。工厂失败、设备不满足 limits、初始化后立即 destroy 的路径由 G02/G04 验证。

准入要求由实际 device 检查：至少 3 color attachments、24 attachment B/sample、fragment stage 至少 3 storage buffers、compute stage 至少 3 storage buffers、64 workgroup invocations、足够纹理尺寸与各 buffer binding。默认 WebGPU limits 足以承载上述基础布局，但超过默认的设备可用 limit 必须在 requestDevice 时显式请求；adapter limits 不能充当 device limits。timestamp 仅测试/诊断可选。半浮点三目标格式实机探测是 G01 验收项。

G-buffer/source/view list/history 由既有 Render3D frame/resource owner 管理；transient pool 只复用 descriptor 与生命周期兼容纹理。输出/history 不能 alias 成 transient。resize、profile 切换、device lost、异步 pipeline 取消均按 generation 与 submission-safe retirement 回收。测试注入 device replacement 不等于移动端恢复资格。

## 预算与后续准入

### 固定的新内容夹具

`deferred-room-021-v1` 的房间范围为 x/z∈[-12,12]、y∈[0,8]，16×16 个 unit box 放在等距网格，中心为 `(-11.25+1.5*(i%16), 0.5, -11.25+1.5*floor(i/16))`。8 个材料按 i%8 选择，baseColor 线性值依次采用固定调色板 `[(.8,.2,.1),(.1,.5,.8),(.2,.8,.3),(.8,.6,.1),(.5,.2,.8),(.1,.7,.7),(.6,.6,.6),(.9,.9,.9)]`，metallic 为偶数材质 0、奇数 1；roughness 为 `0.1+0.1*materialIndex`。性能基础 case 无透明、无自发光/贴图/阴影/IBL，以隔离多灯基础成本；它不代替 C 组带实际材质贴图/透明的验收。

灯数据 PRNG 为 xorshift32，seed=21128（无符号位运算 x^=x<<13、x^=x>>>17、x^=x<<5，输出 u32/2^32），每灯依序取五个值决定 x=-10+20u、y=1+6u、z=-10+20u、palette index=floor(8u)、phase=2πu；颜色取上述 palette，intensity=2。稀疏 range=2m，高重叠 range=40m。运动灯 x/z 叠加 `(sin(t+phase), cos(t+phase))` 米，t=frame/60；静态和动态 case 使用相同初始源数据。ambient 强度 .1，方向光强度 .5、方向 normalize(-1,-1,-1)，分别单独计数。此夹具由 G02 实现；G01 不把未实现夹具的预测计为实测。

相机 perspective FOV=60°、near=.1、far=100，观察点 (0,2,0)，位置 `(18*cos(a),6,18*sin(a))`，a=2π*(frame%240)/240；四视图分别加 `[0, π/2, π, 3π/2]` 方位偏移，各自完整 720p 目标（并非把总像素数四等分）。测试矩阵中的 small-8 明确是 8 个局部灯加独立全局项；旧 Forward `forward-cap-8` 会 overflow，仅用于未来默认路径回归而非完整多灯速度比较。

### 独立增量预算

新功能保持独立增量预算，详见机器配置；既有 Forward、包体、Shader、设备 gate 不改变。128/256 灯要求完整参与；512/1024 是诊断档。发布必须同一 clean revision + 两类设备 + 全材质/生命周期/包消费与示例证据，不以本 ADR 代替实现验收。

当前布局的每视图增量下界为 28×W×H + ceil(W/16)×ceil(H/16)×528 + 4×1024 + 32 bytes；它不包含原 HDR、历史、shadow、pipeline/driver 隐藏开销和 frame-ring 多代。按实际存活代数乘算。所谓带宽估算是 attachment 写/读 payload，不是实测 DRAM 流量或驱动驻留显存。

按该模型，720p 每视图约 26.43 MiB，1080p 约 59.48 MiB，均纳入 64 MiB/view/generation 上限。只按一次完整 G-buffer 写入与一次完整读取估算，60 Hz 下单视图 720p/1080p 的 payload 分别约 3.10/6.97 GB/s，四个完整 1080p 视图约 27.87 GB/s；这不含 HDR 写入、材质采样、额外 pass 和 overdraw，也不能预测硬件缓存/压缩后的总线流量。集显与独显共享这一有界布局，分别接受实际 GPU 时延门禁；格式支持不代表集显在多视图下满足性能要求。不得根据理论带宽数字宣称性能通过，G05 必须实测。
