# G04 Shader 预算与模块复用实施

日期：2026-09-27。用户批准“按照这个建议进行优化”。范围是当前已实现的透明完整灯表 Shader；不代表 G04 全部能力完成。

## 实施结果

- 四个 Deferred full Forward PBR 变体共享一份 WGSL 基础字符串及五组相同反射数据。生成时检查共享字段完全一致，测试使用实际 Rollup 输出还原完整 Artifact 并与编译结果深比较。
- 新增私有构建期 `#include <module/id>`，九个已注册的 PBR/场景/变形公共模块由一个 `.wgslinc` 入口引用。生产 WGSL 与原有拼接结果逐字节一致。
- 注册表、传递依赖及内容指纹进入 watch/cache；保留构建专用 provenance sidecar 和原文件行号映射。缺失、循环、重复 ID、路径越界、声明/数字绑定冲突有测试。完整 WGSL/ABI 验证仍由现有 compiler 和 native 门禁负责。
- Engine runtime 不加载 include 解析器或 Shader Language compiler；公共 API 和 Graph JSON 能力未扩展。使用说明见 [Shader Language README](../../shader-language/README.md#受信任-wgsl-的构建期-include)。

## 预算

| 指标 | 当前值 | 批准上限 |
| --- | ---: | ---: |
| 展开 WGSL 字节 | 555,236 | 570,000 |
| 生成 WGSL 文件 | 75 | 75 |
| 静态变体 | 67 | 67 |
| Pipeline | 67 | 67 |

保留 14,764 B 字节余量。历史增长基线仍为 305,504 B / 64 / 56 / 56，对应 growth 上限 264,496 B / 11 / 11 / 11。未修改成本统计/排除口径、其他包体/编译耗时/帧性能预算，也未提前采用未来不透明代理表面的 600,000 B 规划额度。

## 实际打包测量

范围：独立的完整 Deferred full Forward Artifact，经 Rollup 打包，不 minify，gzip level 9，含反射，不含 renderer 或 npm 整包。

| 产物 | 优化前 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| JavaScript | 190,289 B | 52,867 B | 72.2% |
| gzip | 31,297 B | 10,484 B | 66.5% |

四份展开 WGSL 共 137,842 B，逐份代码哈希完全不变；Artifact hash 保持 `924dc9c0413c497d013dd3f8bbb9207eff4622e861b9c8f6f4a9db7cf991b853`。include 本身改善作者维护，实际包体收益来自共享基础字符串/反射。该测量不能解读为 npm 整包减少 66.5%，也不说明 GPU 编译速度或 FPS 提升。

原始 before/after、验证日志、成本报告、Stage14 报告及依赖 provenance 归档于 `artifacts/engine-0.2.1/g04/module-optimization/`；[机器可读报告](g04-budget-import-application.json) 记录精确路径与哈希。

## Native 画面复测

| Adapter | 通过用例 | 最大 HDR 通道误差 | GPU 错误 | Owner / live GPU 残留 |
| --- | ---: | ---: | ---: | ---: |
| AMD RDNA 1 | 50/50 | 0.0002765655517578125 | 0 | 0 / 0 |
| Intel Gen 9 | 50/50 | 0.00015926361083984375 | 0 | 0 / 0 |

各自验证五种材质、0/1/8/9/128 灯、Reference/强制 Tiled，与独立逐灯原 Forward 渲染 oracle 比较 RGBA；误差与优化前一致。64×64 正确性测试不代替性能预算采样。

- AMD：`artifacts/engine-0.2.1/g04/transparent-high-performance-passed-2026-09-27T13-09-32.641Z.json`
- Intel：`artifacts/engine-0.2.1/g04/transparent-low-power-passed-2026-09-27T13-09-39.124Z.json`

## 仓库验证

- 根目录 `typecheck`、`test`、`build` 均成功；1,360 项测试通过（Shader Language 135、Engine 719、animation-spec 107、extensions 392、示例目录 7），95 个示例 fresh 构建通过。
- Stage14 完整 DAG 25/25 通过，Shader Language / Engine / extensions 各构建一次，生产生成一次；含 WebGPU 与 WebGL 像素验证，原包体门禁全部通过。
- API、Engine workspace/module 边界、职责边界与 synchronous prepare 检查通过。
- 额外执行的聚合 `npm run check:boundaries` 在 Engine 两项检查通过后，于兄弟 Editor 仓退出：其本地 `Editor/node_modules/typescript/index.js` 无法解析。原始失败日志已归档，不计为 Engine 实现回归，也未修改 Editor 依赖。

## 完成边界

本次解决当前 Shader 成本准入与公共代码维护重复。G04 的不透明扩展代理表面、辅助/effect 顺序、变形/外部实例、子视图、300 次 native 生命周期切换与最终全矩阵审计仍按 [进度记录](g04-progress.md) 推进。本次不发布、不改版本，也不将 G04 标记完成。

## Editor 安装修复追记 — 2026-09-27

上面记录的缺少 TypeScript 问题已通过按原 lockfile 重新安装解决，Engine 聚合边界检查已通过。Editor 的包版本范围与源码均未改变。另发现已发布的 Extensions 0.1.0 缺少 Editor 光追预览使用的导出，用户明确选择仅修复安装、继续 Engine G04；该产品兼容问题未计为通过。见[修复与范围说明](g04-editor-install-repair.md)。
