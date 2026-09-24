# Engine 0.2.1：GPU 实例与模拟基础能力

日期：2026-09-24。分支：`release/0.2.1`，起点 `4563e8d6b1f5204af37dc98d5630c62918d02a84`。
此记录是开发验证，不是发布完成或手机性能资格。

## 对源码审查的处理

| 项目 | 实现与边界 |
| --- | --- |
| E1 共享材质脏数据 | 私有 32 项 revision journal；各实体/渲染器有独立消费进度；落后过多则全量刷新。跨实体、跨 renderer、重复绘制与日志溢出有回归测试。 |
| E2 ComputeKernel | 保留同步旧接口，新增设备/active pass/dispatch 上限保护与 pass label。GpuComputeProgram 提供异步 initialize、间接 dispatch、初始化世代和 bind group 所有权检查。 |
| E3 外部 GPU 实例 | 借用 STORAGE mat4、RGBA、visible ID；不上传 CPU material.transforms/colors。每批仅拥有 16 B material uniform；数据与索引可由 compute 生成。当前 ABI 是标准矩阵/颜色，不直接解释游戏自定义士兵结构。 |
| E4 法线与 Toon | 实例法线使用 cofactor 的逆转置方向，保留镜像符号；零尺度提供有限 fallback。新增 opaque/no-shadow InstancedToonMaterial。 |
| E5 LOD | GPU 视锥剔除、保守包围球投影高度、3 档滞回、稳定 ID 列表；人数直接复制到 indexed indirect，不需要 CPU 获取可见性。不同视图使用独立 owner。 |
| E6 通用读回 | 有界 staging ring；提交后 map，忙时返回 null；携带 generation/token；销毁/取消不提前复用在途缓冲。已编码任务仍需提交或销毁整个设备。 |
| E7 能力与恢复 | 按实际 device.limits 做准入，optional features 单列；拒绝旧设备句柄。继续使用既有 recovery participant，由游戏恢复检查点；本次没有宣称 GPU 世界状态能够无损自动恢复。 |
| E8 辅助资源 | CPU 实例路径的剔除/排序/间接资源按需分配；未启用时每批从 11 个 GPU buffer 降至 4 个。外部 GPU 实例路径不创建 CPU mat cache。 |

## 实验性 API、打包与示例

- [ADR 0108](../docs/for-ai/adr/0108-gpu-instance-simulation-021.md) 记录范围和兼容边界。
- stable root 保持 30 个符号；`experimental/gpu-driven` 25 → 36，兼容聚合 846 → 855。
- workspace 包与候选清单一致更新到 0.2.1；没有执行 git commit、push 或 npm publish。
- [gpu-instances](../examples/gpu-instances/main.ts) 已加入 manifest full tier。启动自检读回计数/ID，正常动画帧只做 GPU 计算和绘制。
- [使用指南](../docs/engine-guide/gpu-instances.md) 与 [API 契约](../docs/api/gpu-instances.md) 覆盖队列提交、缓冲所有权、设备替换和游戏接入。

初次 dist-only 测量：Engine tarball 1,886,706 B，展开 8,413,469 B，602 文件。packed/unpacked 总预算维持 2,100,000 / 9,000,000 B。
新增 GPU 类的声明和 runtime chunk 使文件数从历史 593 增至 602，因此已审查文件数随能力调整，原 7 文件储备保留（上限 609）。
新 consumer `gpu-instances-only` 首次 bundle 为 495,452 B / gzip 78,772 B，包含 compute 与 specialized rendering 两个必要 shader artifact；新增场景预算 91,000 B（约 15% 储备）。
该值包含 renderer 与几何缓存等传递依赖，不是纯模拟代码的大小。最终权威值由 `verify:engine-package` 的 packed-consumer 报告记录。

Shader 预算按新增能力的实际增量归因：相对起点，新增 LOD WGSL 为 2,332 B，现有 instanced shader 的法线/Toon 增量为 1,132 B，共 3,464 B。
仅增加一个 generated 文件、一个 compute variant 和一个 compute pipeline；Toon 使用原有 uniform 分支，不增加 render pipeline 组合。
生成源码总额从 356,777 B 变为 360,241 B。原上限 360,000 B 加上这 3,464 B 为 363,464 B，保留原 3,223 B 余量；历史 growth baseline 不变，增长额度同量增加。
文件/variant/pipeline 仅增加一个名额；编译耗时、DAG、原有消费端和其他能力预算保持原值。

## 验证记录

已通过：

- `npm test`：1,296 项，113 shader-language + 677 Engine + 107 animation-spec + 392 extensions + 7 examples catalog。
- `npm run typecheck`：全部工作区通过。
- `EXAMPLE_FILTER=gpu-instances npm run build`：全部库工作区与新示例构建通过；本次未重建所有历史示例。
- `api:check`、workspace/module boundaries、renderer prepare、Engine contracts、docs、122 项 performance policy、14 项 fast-gate policy、68 项 release policy 均通过。
- Shader 生成校验、Stage 14 runtime 边界与 production cache/cost 校验通过。
- 真实 WebGPU Stage 12（7 个 specialized pass）和 Stage 13（6 个 compute pass）验证通过。
- 最终浏览器验证：Chrome 153.0.8010.53 / macOS Metal，设备报告 AMD RDNA-1，isFallbackAdapter=false；未公开具体型号，不推断手机表现。
- 新实例门禁：10,000 个唯一 ID，三档 3334/3333/3333；视锥可剔除全部实例；Toon 像素为 255/119/51（非均匀缩放/镜像/纯环境），LOD 滞回序列 0/0/1/1/2/0，0 validation errors。

`npm run verify:engine-package` 已通过：四个公共包确定性 repack、真实 npm install、浏览器 bundle、Node、TypeScript、exports、CLI、provenance 均通过。
最终 Engine 为 1,887,115 B packed / 8,414,724 B unpacked / 603 文件；相对初测多一个共享 chunk，消耗一个原有储备，仍在 609 上限内。
独立安装后的 GPU consumer 为 503,091 B raw / 79,986 B gzip，低于 91,000 B；无动态依赖或告警，只有已登记的两个 shader artifact。
最终机器可读包报告为 `artifacts/release/public-packages.json`。

- 针对性测试覆盖共享材质、实例范围上传、异步管线取消、旧设备拒绝、读回压力/销毁、LOD 对齐与辅助资源回收。
- 浏览器门禁：`node scripts/verify-gpu-instances-021.mjs`，输出 `artifacts/gpu-instances-021/diagnostic.json`，包含 revision、dirty、设备、HTTP 输入 hash。
- 此门禁检查 10,000 个 GPU 生成实例，三档人数 3334/3333/3333，所有 ID 唯一且正确归档、全员视锥剔除、间接绘制合法；另测非均匀/镜像法线的 Toon 像素和 LOD 滞回。
- Shader Language 生成产物通过正式源文件再生成；没有手改 generated 文件。

## 仍属于游戏和真机阶段的工作

ParallelLegion 尚未接入这套 GPU 展示路径。本次没有修改游戏的容量 32、单 workgroup、单线程 settlement、O(N²) 误伤检查或每 tick 全量读回。
接下来应先做格子索引、确定性意图/提交和跨 workgroup CPU oracle，再连接 GPU 姿态及 LOD；不能仅调大士兵上限。

未测 iPhone/Android 真机、手机热稳定、功耗、后台恢复；没有 GPU timestamp 性能采样，也没有新能力的正式 CPU/GPU benchmark 资格。
当前资源数量结论来自审计设备的结构计数，不等同于帧率提升。
