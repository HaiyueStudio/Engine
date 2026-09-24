# 0.1.1 发布候选检查报告

后续候选为 **0.2.0**；新增能力、API 与包体预算的当前结论见 [0.2.0 评审](release-0.2.0-capability-budgets.md)。本页为历史记录。

更新（2026-09-23）：UI 的 API 与发布检查已拆出，原 UI 门禁问题不再阻塞 Engine 库发布。当前 Engine 自身的 API 差异及拆分验证见 [独立发布检查](independent-library-release.md)。以下保留当时的候选检查记录。

状态：候选整理完成，**尚不满足发布门禁**。版本号保持原值，没有发布、创建版本标签或推送。

## 分支与范围

- 切分基点：`3b7582350265bee60c5cc19b3cb1412d001fbfe5`（`add gui features`）。
- `feature/rive-development`：完整保留切分时的 Rive 研发代码。
- `release/0.1.1`：当前候选；移除 Rive 专用实现、依赖、工具、素材与三个示例。
- `master`：保持切分时的提交。
- 保留来源无关 HYA 能力，以及 Lottie、Live2D、GUI 等已有能力。
- Rive 历史 ADR/census 和安全禁止清单保留，不作为当前能力声明。

## 本次修正

1. 删除文本 atlas 的 Rive 专用 CPU 像素回读/量化和四次子像素采样，
   使用标准预乘透明度文本路径。回归测试覆盖高分辨率文本不读取或改写像素。
   这是代码路径简化，尚未量化帧率收益。
2. 两个 HYA 转换 CLI 增加可执行权限，修复打包后命令的权限问题。
3. 发布内容测试根据 manifest 校验数量与成员，消除示例增长造成的过期硬编码。
4. 修复 HYA viewer 跳转入口缺少共享 Engine 脚本的问题，避免启动时
   `HaiyueExampleEngine is not defined`；增加加载顺序回归测试。
5. 增加 Rive 排除检查，并接入发布范围门禁，防止依赖或构建产物重新混入。

## 验证与后续

### 已确认

- 全仓 `npm run typecheck` 通过；单元测试 **1283/1283** 通过（Shader Language 112、Engine 666、Animation Spec 106、Extensions 392、示例目录 7）；后补的 viewer 加载顺序回归测试 1/1 通过。
- 四个库均已构建；完整示例构建在共享 Engine bundle 触发默认 60 秒超时，受影响动画示例以 300 秒超时专项重试成功。
- Rive 排除策略与发布内容路由测试通过；源码和构建产物扫描通过（3052 个文件，含依赖、锁文件和示例清单）。
- 预览服务器测试 5/5、快速门禁策略（含 Rive 排除策略）14/14、benchmark/release 策略 30/30 通过。
- `docs:check`、发布产物范围检查通过。
- Engine 工作区依赖边界通过，452 个 Engine 模块无循环或反向 facade 依赖。
- 8 个动画示例及共享 bundle/source viewer 重建成功（10 个 fresh targets）；HYA 样例的独立 freshness 检查通过。未重新跑完其余 84 个示例。
- 浏览器验证：HYA viewer 正常初始化，文字选择器可见、暂停及时间轴跳至 1.5 秒正常；重载后未出现新增控制台/WebGPU 错误，页面诊断正常。
- 着色器由生成器更新；builtin-render 校验通过（19 文件、3 family、16 pass）。

### 发布阻塞与优先级

| 优先级 | 问题 / 证据 | 建议 |
| --- | --- | --- |
| P1 | `api:check` 失败：UI 包新增 `./expandable`，Engine 的能力预算配置没有对应入口 | 在 UI 能力评审后同步 `config/public-api-capability-budgets.json` 和 API 基线；不能直接增大预算绕过审查 |
| P1 | 重新打包仍有 4 项体积超预算，详见下表 | 优先分析 `Animation2DRuntime` 静态引用的文本/字体解析、脚本与向量渲染闭包；考虑按能力注入或异步加载，保持功能一致后重新测量 |
| P1 | `shader-language:check` 的生成成本门禁失败：WGSL 总量 356,696 B > 328,000 B；相对基线增量 51,192 B > 22,500 B；文件增量 2 > 1 | 分析新 shader family 的重复代码与增长来源，优化后复核；如需调整预算，必须独立审查，不能直接放宽 |
| P1 | `performance-budget:test` 114/115；缺少 `artifacts/webgpu/lighting-scaling.json` | 在仓库要求的真实 GPU runner 生成并复核灯光测量；不以当前机器的诊断数据代替正式证据 |
| P2 | 全仓 `check:boundaries` 在兄弟 Editor 仓库因缺少 TypeScript 安装而中断 | 补齐 Editor 工作区依赖后重跑；Engine 自身两项边界检查已通过 |
| P2 | 完整 92 示例构建首次因共享包的 60 秒超时中断；本次仅完成受影响 8 示例的专项重建 | 发布前在稳定环境完成全部示例与 freshness 检查，分析共享构建及各示例重复编译成本 |
| P2 | 离线 Lottie corpus 检查缺少 `animation-spec/corpus/.cache/assets/layers/solid-layer.json` 等缓存 | 恢复固定来源和 hash 对应的 corpus 缓存后，运行完整离线/浏览器验证 |

`animation-spec/AGENTS.md` 要求的 `hya:dashboard:offline` 在当前 package scripts 中不存在；
本次直接尝试底层 corpus 入口的离线 Node 诊断 `node scripts/hya-corpus/run.mjs --offline --skip-browser`，
在缓存检查阶段失败，未改写正式 corpus 结果。Stage 14 DAG 已尝试，在 `generate:production` 节点因上述 shader 成本超预算停止，未执行浏览器节点；正式
跨设备 GPU 性能证据仍需完成，不能据单元测试宣称全部发布门禁通过。

### 发布包测量

运行 `node scripts/verify-engine-package.mjs`，消费者安装、运行时/类型/CLI 检查执行完成，
门禁仅剩以下体积失败；两个 CLI 的可执行权限错误已消除。未调整任何预算。

| 项目 | 候选实测 | 现有预算 |
| --- | ---: | ---: |
| `@haiyue/animation-spec` 压缩包 | 130,278 B | 125,000 B |
| `@haiyue/extensions` 解包体积 | 2,651,601 B | 2,500,000 B |
| `extensions-animation` 消费者 gzip | 223,060 B | 120,000 B |
| `extensions-hya-state-machine` 消费者 gzip | 230,623 B | 130,000 B |

具体依赖闭包和检查结果见本地 `artifacts/release/public-packages.json`；
包产物位于 `artifacts/release/npm/`，仍使用各包原有版本，仅供检查。
Rive 导入器原本就不在公开包入口中，因此移出大量研发文件不会等比例缩小发布包。
当前代码的一个明确优化切入点是 `Animation2DRuntime` → `AnimationTextRasterizer`
→ `opentype.js` 的静态依赖；应先做模块体积归因，再决定可选字体后端/异步加载方案。
本次动画 WGSL 从 17,242 B 减到 16,090 B；不据此推算帧率提升。

### 继续开发

候选改动已保存在当前分支，可用 `git switch feature/rive-development` 继续 Rive 研发；
用 `git switch release/0.1.1` 回到候选。通用修复按需 cherry-pick 到研发分支，
不要直接把 Rive 实现合回候选。发布前另行确认版本号、变更日志和最终门禁。

## 本地检查记录

日志和本次测量快照保存在 `artifacts/release/0.1.1-checks/`（忽略的本地产物）。
包含 `types.log`、`tests.log`、`animation-examples.log`、`package.log`、
`no-rive-artifacts.log`、`shader-gate.log`、`stage14.log`、`public-packages.json` 等。
这些是本机工作树的候选检查记录，不是正式 clean-runner 发布证据。

8 个重建示例：`animation-spec`、`live2d-hya`、`lottie-hya-compare`、
`live2d-hya-compare`、`hya-state-machine`、`hya-samples`、
`hya-lottie-corpus-dashboard`、`hya-live2d-corpus-dashboard`。
