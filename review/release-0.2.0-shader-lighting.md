# 0.2.0 Shader 与原生 Mac 灯光评审

日期：2026-09-23。延续 [能力预算评审](release-0.2.0-capability-budgets.md)，本轮专门处理 Shader 超限和灯光证据。
平台决策见 [ADR 0107](../docs/for-ai/adr/0107-native-macos-release-qualification.md)。

## Shader 成本评审

重新核对生成器、文件内容和计数：生产 WGSL 共 356,696 B / 66 文件，58 variants / pipelines。
总量包含每个独立 pass 的真实源文件，未修改统计口径、删掉 renderer pass 或重置旧 growth baseline。
粗略单引用 helper 检查只有约 12 KB，且包含必须保留的独立 feature module；不能据此安全移除全部函数来满足旧预算。

原字节上限 328,000 B 已无法覆盖当前已实现的正确性和渲染能力；需要按现有发布范围重新准入，
而不是归因给此前的音频/输入等五组能力。相对预算配置首次引入提交 `ac31e7c` 的具体增长包括：

| 文件/能力 | 字节增量 |
| --- | ---: |
| indexed-sprite 新 pass：索引纹理与调色板 | 5,326 |
| postprocess-output 新 pass：输出颜色处理 | 1,856 |
| normal-material | 4,920 |
| deformation motion-vector | 4,208 |
| animation-2d | 3,842 |
| TAA | 2,662 |
| deformation shadow/depth/outline | 多个 pass 各约 1,355，包含一致的材质覆盖判断 |

该提交的文件总量是 327,019 B；配置中的更早 growth baseline 仍为 305,504 B / 64 文件，两个参考点不能混用。
预算调整为 **360,000 B**，growth 上限为 **54,496 B**，相对实测留 **3,304 B**；新增文件额度从 1 调到 2，
对应 indexed-sprite 和 output 两个已存在 pass。绝对文件数 66、variant/pipeline 数 58、冷生成 10 秒和 DAG 各一次构建的上限均不变。
本次修复方式是有明示能力归因的预算校准，不声称缩减了 356,696 B 的实际源码体积。

完整 DAG 还检出 Stage 9/10 的历史压缩预算落后：simple3d gzip 7,025 B（旧 6,718），components evidence 2,812 B（旧 2,334），deformation 9,468 B（旧上限 7,500）。
检查生成器后，增长分别对应 normal pass 的材质覆盖/线性深度、indexed-sprite 新 pass 与 Animation2D 效果，以及 deformation 的材质覆盖和 motion history。
历史 stage contract 保留原值；当前 `productionBundles` 独立准入上限为 7,100 / 2,850 / 9,600 B。
Engine 2D+simple3d gzip 合计 11,767 B，仍受原 12,000 B 总预算约束；compiler 泄漏、公共入口不能加载 evidence、重复 deformation 代码检查全部保留。
Stage 11/12/13 原预算检查已通过，无需调整。

Stage 9 浏览器回归还发现两处旧验证契约不匹配：Animation2D fixture 写入旧 1,264 B / 硬编码偏移，现改为按 1,296 B 反射字段填充；像素期待按现有预乘颜色契约计算为 `[36,0,60,96]`，不放宽误差。
Animation2D 的 `fs_effect` 读取相机矩阵，但生成反射仅标记 vertex；现补上 fragment，与生产 renderer 的 Camera2D layout 一致，并增加反射断言。生成产物由生成器更新，不手改 WGSL。

## 灯光实测与统计修复

当前主机：macOS 26.6.2 (25G83)，Intel UHD 630 / AMD Radeon Pro 5300M，实际浏览器报告 AMD RDNA-1 / Metal。
原脚本固定假定 ambient 和 directional 各占一个槽位，局部灯容量恒为 6。
真实渲染器的视图选择可替换其中部分全局灯，实测提交 7 个 local + 1 个 global，共 8 个；旧校验因此错误报超限。
改为以实际 submitted 全局灯计算剩余槽位，同时保留 authored 总量、全局与局部 overflow 的守恒检查。
新增回归用例覆盖全局灯被替换及 overflow 不能被掩盖。

首次修复后 diagnostic 结果：128 authored local，7 submitted local，130 authored total，8 submitted total，
121 local overflow / 122 total overflow。CPU P95 5.67 ms，WebGPU validation error=0，owner residual=0。
这仅证明当前 Forward 上限下的执行与测量正确，不代表 128 盏灯都被渲染或已满足整个发布矩阵。

正式证据需要在冻结的 clean revision 重跑；诊断文件不能通过正式证据校验。
命令：`npm run verify:lighting-scaling:formal`，然后 `npm run lighting:evidence:check`。

## 验证

已通过：57 项 Shader/平台/灯光专项策略测试、37 项发布策略测试、113 项 Shader Language 测试及生产生成成本检查、Stage 9 反射专项 5 项、文档与 API 检查。
原生 Mac 浏览器 Stage 2–8 已通过；修正上述反射/fixture 后 Stage 9–14 全部单项通过。Stage 9/10 的压缩预算及 Stage 11–13 原预算检查通过。
最终完整 DAG 和正式灯光采集在隔离的 frozen clean revision 中执行，机器记录分别为 `artifacts/shader-language/stage14-dag.json` 与 `artifacts/webgpu/lighting-scaling.json`；以记录中的状态和 revision 为准。
正式灯光记录仅适用于其绑定提交，不把原工作区的未提交改动声明为 clean；修改源码后需要重新采集。这不代替所有示例、完整设备场景、跨引擎性能比较及供应链发布门禁。
