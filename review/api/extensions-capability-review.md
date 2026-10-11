# Extensions 实现、结构和稳定能力评审

日期：2026-10-11。依据用户要求及 [ADR 0122](../../docs/for-ai/adr/0122-package-capability-structure-review.md)，本次检查实现职责和稳定能力的真实可用性，不以文件总数决定通过与否。

## 结构结论

变更前发布包的 202 个文件由 161 个 `.d.ts`、38 个 JavaScript 文件和 3 个元数据文件组成，并不等于 202 个独立功能。声明由公开类型的递归依赖决定，构建已通过 `prune-package-declarations` 清除不可达声明。按职责拆开的私有模块和 Rollup 共享块应保留，不能为满足计数合并文件或扩大根入口。

当前 14 个已准入的稳定入口均有 package exports、源码 facade 和构建声明。没有发现需要把新的内部模块升为稳定 API 才能补齐已准入能力的情况。下面是复核的职责边界；稳定等级沿用现有能力分组，本次没有新增公开符号。

| 入口 | 对外能力及实现归属 |
| --- | --- |
| `/gltf` | 模型加载、component/system/plugin、材质 adapter 和兼容报告；解析器、Worker transport 与准备数据保留私有或 experimental |
| `/gltf-animation3d` | 把 glTF clip、TRS、关节和 morph 接到来源无关 Animation3D pose/mixer；不另造 importer 专用 mixer |
| `/animation3d` | clip、pose、mixer、状态机和 HYA adapter；2D/3D 状态机控制器复用共享 runtime |
| `/animation` | Animation2D 组件、系统、加载、渲染、扩展注册及交互；布局、文本、向量、音频等内部 owner 不额外散落到根入口 |
| `/hya-state-machine` | HYA 2D 状态机装配、clip adapter 与 channel 能力诊断 |
| `/deformable-animation` | 来源无关形变 runtime extension、采样和状态；参数化 rig、mask 和 GPU 细节保留内部 |
| `/spine` | Spine 组件、渲染系统、插件及 Worker 接口；骨架/timeline/path solver 是格式运行时内部 |
| `/tilemap` | 地图数据组件、渲染系统与插件；私有渲染器复用 2D 基础设施 |
| `/canvas-text` | Canvas text 组件及渲染系统；GPU 缓存由系统所有 |
| `/tween`、`/grid` | 聚焦的 Tween2D 组件/系统与 Grid2D 数据契约 |
| `/controls` | 摇杆输入、移动/朝向与可选 GUI；JoystickView 为内部实现 |
| `/i18n` | 语言包校验、格式化和可取消 GUI 绑定；GUI 类型导入不引入 GUI 渲染实现 |
| `/narrative` | 校验、运行时、存档、宿主动作 adapter 和可选 NarrativeGui；headless 使用单独验证 tree-shaking |

根入口只暴露实验性 2D authoring base；3 个 `/experimental/*` 和无前缀的 `/ray-tracing` 保持 experimental。仅仅实现了内部 sampler/worker/renderer 不构成稳定承诺。

## 已修复问题

1. glTF、Spine、Tilemap 插件使用共享闭包保存最后一个场景的 system，卸载时仅执行 `World.removeSystem`。该方法只脱离 World，不执行系统的 `destroy`，无法释放其加载任务、资源和设备恢复监听。现在系统只归本次安装所有，安装前登记 rollback 销毁，覆盖正常卸载、场景销毁及安装失败。编辑器自建系统同样销毁，借用系统保留，dispose 幂等，注册渲染器失败也释放自建系统。初始 9 项回归在旧实现上全部失败，旧失败日志保留；另补部分安装失败和视口注册失败检查。
2. 稳定声明边界的手工 10 项名单遗漏 deformable-animation、controls、i18n、narrative，现从稳定能力分组自动推导全部 14 项。
3. 发布包缺少 i18n/narrative focused consumer，且全量类型检查仅枚举 Engine。现补齐独立消费场景，并检查四个包的全部声明入口；新增稳定入口未登记消费场景将失败。
4. 补齐 README/API 稳定性索引，明确 ray tracing 的实验状态和 controls 的当前准入状态。包文件数改为观察值，仍保留包体、能力/API、按需加载和内容白名单门禁。

## 仍可独立优化的方向

Animation2D 与 HYA 状态机的 OpenType 静态成本是 ADR 0106 已明确接受的取舍。未来可以评审文本资源按需加载，但需要同时定义异步准备和失败行为，不能在本次所有权修复中改变加载合同。glTF 的低层逐 clip 播放与高层 Animation3D adapter 具有不同对外契约；保留已有插值/绑定测试，后续抽取采样计算时应先证明数值和生命周期等价。

## 验证

验证记录位于 [本轮原始目录](../../artifacts/engine-0.2.1/extensions-review-20261011)。首次真实包测量的新增场景如下；预算按实测增加 15% 后向上取整至 500 B，仅新增这些原本不存在的消费约束，既有约束均未放宽。

| 消费场景 | 实测 gzip B | 新预算 B | 归因 |
| --- | ---: | ---: | --- |
| extensions root | 35,445 | 41,000 | 2D authoring base 及其 ECS、camera、matrix、诊断访问依赖；无 glTF、Spine、Animation2D、NarrativeGui |
| i18n | 4,274 | 5,000 | 语言包、格式化及仅持有 GUI 类型的绑定 |
| narrative headless | 4,704 | 5,500 | 状态/校验/宿主动作；无 NarrativeGui 和 GuiSystem |
| narrative GUI | 10,897 | 13,000 | 显式选择的剧情 GUI 及其控件依赖 |

root 首轮探测使用未经测量的 10,000 B 暂定值，因此该轮保留 failed。检查实际依赖后按上表登记新观察和预算；这不是修改之前已有的 root 门禁。原 202/200 文件数失败和初次探测失败都保留，最终门禁另行运行。

最终发布包门禁已通过：仍为 202 个文件，压缩 528,657 B、解压 2,711,809 B，分别低于原 550,000 B / 3,000,000 B 上限。全部 66 个公开声明入口、ESM 加载、Node/CLI 以及 focused consumer 通过，四个新增消费场景的最终测量与上表一致。

全仓类型检查、1,460 项测试（其中 extensions 436 项，包含 14 项新增生命周期回归）和 98 个示例构建通过。首次全量测试因受限 Windows 会话无创建符号链接权限而中断，原日志保留；以标准权限运行后全部通过，没有跳过用例。

API 基线、文档、架构边界及发布策略回归通过。Windows Chrome/WebGPU glTF 三档生产资产与参考/Worker 对照通过，销毁后 GPU 资源数、GPU 字节及 owner 残留均为 0。该功能回归的启动时间不作为 G09 稳态性能证据。

最终文件绑定和详细状态见[机器复核](extensions-capability-checks.json)。本次不代表 G09 性能资格或发布完成。
