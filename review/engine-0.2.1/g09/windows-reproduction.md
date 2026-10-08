# G09 Windows 对照与集显测试准备

日期：2026-10-06。本轮只验证当前 B4 的正确性和测试工具可移植性，不授予 A0/B4、集显、持续稳定性、性能或发布资格。

## 设备与可回答的问题

Windows 10 Pro 22H2（19045）、Intel Core i7-7700、Gigabyte Z270-HD3-CF。系统的显卡清单及 Display PnP 清单均只列出 NVIDIA GeForce GTX 1070 Ti，驱动 32.0.15.6094（2024-08-14）。Chrome 153.0.8010.50，Edge 154.0.4258.53。没有安装驱动、改 BIOS、电源设置或重启系统。

Chrome 原生探针的 `high-performance` 和 `low-power` 都返回 `nvidia/pascal`，不能把低功耗请求算作 Intel 样本。WebGPU 的 `powerPreference` 是选择提示，不保证设备类别，见 [WebGPU 定义](https://gpuweb.github.io/types/interfaces/GPURequestAdapterOptions.html)。报告中的 ANGLE `d3d11` 是共享浏览器 runner 的配置，不冒充独立观测到的 WebGPU 后端。

[Intel 的处理器规格](https://www.intel.com/content/www/us/en/products/sku/97128/intel-core-i77700-processor-8m-cache-up-to-4-20-ghz/specifications.html)确认 i7-7700 带 HD Graphics 630，但本轮没有在 Windows 枚举到这块 GPU；无法仅凭此确定是 BIOS、驱动或其他配置造成。本机有补做 Intel 对照的硬件条件，尚无 Intel Windows 原生样本。

## 测试与原始证据

**Windows NVIDIA 最终 Chrome 32/32、Edge 32/32 全部通过；未复现黑帧、单像素覆盖、同提交读回异常或非预期设备丢失。** 原始证据和工程检查哈希见 [Windows 检查索引](windows-checks.json)。

| 浏览器 | 完整链黑帧/读回 | 兼容及生命周期 | 两轮图像配对最大差异 | 原始报告 |
| --- | ---: | ---: | ---: | --- |
| Chrome 153.0.8010.50 | 24/24 | 8/8 | 0（12 对） | [Chrome](../../../artifacts/engine-0.2.1/g09/portable-2026-10-06T08-52-18.101Z/report.json) |
| Edge 154.0.4258.53 | 24/24 | 8/8 | 0（12 对） | [Edge](../../../artifacts/engine-0.2.1/g09/portable-2026-10-06T08-56-17.573Z/report.json) |

两个浏览器的 24 组对应黑帧探针图像跨浏览器比较最大差异也为 0。黑帧探针验证错误与资源残留为 0；设备生命周期夹具中的主动销毁属于预设用例，不计为自发故障。两种电源偏好在两个浏览器上均为同一 `nvidia/pascal`，没有 Intel 或软件 adapter 样本。

最终两轮使用相同私有 runtime 输入指纹 `769f59868be7144e6f4b83faf64522f8705654d5291c96e5b0fa8ab838eae3e6`；所有原始 JSON 和 chunk 哈希复核通过。Windows System 日志的 08:30–08:59 UTC 查询未返回事件，工具保留原始查询错误；不据此宣称已证明不存在驱动重置，也不与 Mac 内核日志作同等级比较。

固定诊断人口：每个浏览器 32 个独立会话。前 24 个是两轮 × 两种电源偏好 × COPY_SRC 开/关 × 三种编码/读回包装方式；其后 8 个是效果/AO、输出/反射、多视图、辅助表面、资源复用、缓存、312 次切换和设备销毁/重建回归。每个会话使用新的浏览器进程与配置。

黑帧探针保持与 Mac 相同的当前源码工作负载：64×64，3 个 PBR 物体，16 个点光源，Forward + GTAO/SAO/SSAO/两次 GaussianBlur，R8 临时纹理，4 帧预热后捕获第 5 帧。保留同提交已知数据/图案校验、4096 像素完整覆盖、直接拷贝与 compute 一致性、零验证错误和零清理残留。未替换 shader、降低画质或放宽阈值。12 个相同配置的第二轮图像分别与第一轮比较；这是 B4 重复性检查，不是 A0/B4 比较。

保留的先前尝试：

- 私有构建首次在 Windows 查找不存在的 `engine/dist/experimental.ts`，构建失败，未形成 GPU 样本。
- `regressions-2026-10-06T08-30-09.613Z.json`：现有单 GPU 资源复用/缓存 smoke 2/2 通过，不替代完整资格。
- `portable-2026-10-06T08-32-53.390Z/report.json`：24 个黑帧探针通过；整轮 28/32 通过，4 个兼容夹具因缺少显式 `isFallbackAdapter` 元数据被拒收。原始夹具报告渲染通过，但不能把缺失字段改写成硬件证明。两个公共模块夹具还消费了本机旧 `engine/dist`，不能给当前源码授予资格。原始报告保留不改，最终必须使用新构建重跑全部人口。

## 已修复的测试问题

1. 私有 fixture 的源文件重定向先统一 Windows 路径分隔符，修复把 `engine/dist/*.js` 错误转成 `engine/dist/*.ts` 的问题；加入 Windows/POSIX 回归测试，并将解析策略纳入构建指纹。
2. 新增 `npm run verify:framegraph:portable`，复用已有 Chrome/server runner、私有构建和全部像素/生命周期 validator。单独记录可用设备上的 B4 诊断，原有固定 AMD RDNA1 / Intel Gen9 full gate 不变。
3. 补齐四个兼容夹具的真实 `isFallbackAdapter` 输出；新诊断缺字段即失败。设备一致性使用共同身份字段，保留原始描述信息。
4. portable 入口采样前重建公共 Engine 产物及匹配的私有 fixture，采样前后校验源码、脚本和 chunk 指纹。每个失败与原始 JSON 单独保存，不用通过重试替换失败。

没有修改 Engine runtime、生成 shader、稳定 API 或性能预算。工程检查中，首次根测试被 Windows 沙箱禁止创建临时符号链接（EPERM）；相同安全边界用例在沙箱外 5/5 通过，未跳过或修改测试。

工程复核：FrameGraph 策略 41/41、性能门禁策略 214/214、根 typecheck、根 build（98 个 fresh 示例目标）、docs 与 API 检查通过。沙箱外完整重跑 `npm test` 通过：Shader Language 135、Engine 770、Animation Spec 107、Extensions 422、示例目录 7，共 1,441 项，没有跳过。首次沙箱失败日志与完整重跑日志分别保存。汇总辅助脚本初版导入路径错误在读取 GPU 记录前修正，没有重采或改写原始样本。

## 卡点处理顺序

Mac 的 Intel 失败与内核 GPU 超时/重置同窗，且历史 A0/B4 都有异常，详见[重启后记录](post-reboot-reproduction.md)和[同提交读回追查](atomic-readback-investigation.md)。本次 Windows NVIDIA 对照不能区分“Intel 跨平台问题”与“Mac 的 Intel/Metal/系统特有问题”，更不能证明某个驱动或 FrameGraph 已被修复。

下一步应补真实 Intel Windows 对照：先检查本机 BIOS 的 **Chipset → Internal Graphics**，启用后让 Windows 正确识别 HD Graphics 630 及其驱动，再运行同一诊断。该选项位置和默认 Auto 见 [GA-Z270-HD3 官方手册第 32 页](https://download1.gigabyte.com/Files/Manual/mb_manual_ga-z270-hd3_e.pdf)。这一步需要用户进入固件设置；本轮没有更改系统启动或显示设备配置。以实际 adapter 为准，不能只看 `low-power` 参数。

如果 Intel Windows 通过，优先在 Mac Intel/Metal 路径继续做可复现的命令/Shader 缩减及 Dawn/驱动归因；如果 Intel Windows 也失败，优先找跨后端共享的 shader、绑定和资源生命周期触发条件。两者都需要保留已知答案读回和系统日志，不采用默认关 AO、全局禁用 Intel 或无限重试作为未经验证的修复。

重新运行 Chrome：`npm run verify:framegraph:portable`。Windows Edge 可在当前 PowerShell 进程设置 `$env:CHROME_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'` 后执行同一命令。`-- --plan` 只打印固定人口。

G09 仍未完成；冻结的双 GPU、F0–F8、正式 A0/B4 性能人口以及 G05/G07 资格不因本轮诊断而改变。
