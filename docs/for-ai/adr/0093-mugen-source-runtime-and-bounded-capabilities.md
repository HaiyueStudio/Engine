# ADR 0093：MUGEN 来源运行时与受限通用能力边界

- 状态：Accepted
- 日期：2026-08-30
- 范围：Engine、Extensions、Games MUGEN、Worker、WebGPU、Web Audio、证据与安全

## 背景

HaiyueStudio 计划在 `Games/games/mugen` 中实现 M.U.G.E.N 1.1 Beta 1 兼容格斗游戏，第一个产品检查点是本地角色动画查看器。MUGEN 角色不是普通 sprite sheet：DEF 解析依赖，SFF v1/v2 保存压缩 indexed sprite 和 palette，SFF v2.01 还可保存 RGB24/RGBA32 sprite；AIR 使用整数 tick、axis、flip/blend/scale/angle 和逐 element Clsn，后续 CMD/CNS 还包含动态 trigger、controller、helper/target 与格斗状态语义。

现有 Engine 已有 WebGPU 2D、纹理生命周期、Animation2D STEP sampling、WorkerChannel 与资源 owner，但没有 MUGEN 格式、palette-indexed sprite bank、MUGEN VM 或确定性格斗循环。把 MUGEN state number、controller、raw 文件或兼容 quirks 加入 HYA/Engine 根 API 会污染来源无关契约；相反，把 fixed tick、多人输入、audio mixer 或 indexed/truecolor sprite 适配层复制进单个游戏又会失去复用、device-loss 和生命周期保证。

所有玩家角色包都必须视为不可信内容。社区包可能包含畸形 offset/count、解压炸弹、路径逃逸、超大图像/音频、表达式深度炸弹或依赖外部 DLL；项目不能通过 `eval`、主线程无界 fallback 或 host locale 猜测来换取兼容率。

## 决策

1. 正式兼容档位固定为 `mugen-1.1b1-strict`。版本、官方 archive/doc hash、Ikemen 辅助提交、编码/路径/数值/quirk 策略由 [M08 G01 contract](../../../../milestones/milestones/m08-mugen-asset-vertical-slice/g01-contract/README.md) 唯一冻结。IKEMEN-only、add004/Uno、外部 DLL、cheapies 和未定义内存行为不计入该档位。
2. `Games/games/mugen` 独占 MUGEN 来源模型：DEF/AIR/CMD/CNS/SFF/SND/FNT/stage/motif parser、依赖解析、`.hymugen` package、action evaluator、CNS compiler/VM、combat/round/team/stage/motif 语义、导入 UI 和 oracle/corpus harness。Engine、Extensions 与 HYA 不出现 MUGEN state number、group/item、controller 或 raw payload。
3. `.hymugen` 是 versioned、source-specific、确定性的交付包，不属于 HYA。浏览器比赛帧不解析 raw 文本/二进制；用户目录也必须先在受限 Worker 完整导入成功，再原子替换当前 package。
4. 来源无关的 indexed/truecolor sprite GPU slice 进入 `@haiyue/extensions` focused experimental subpath。indexed sprite 使用 index plane 与 palette bank/remap；SFF v2.01 RGB24/RGBA32 sprite 复用普通 color texture。该 slice 拥有 atlas、axis-independent draw geometry、alpha/blend parameters、batch/stats、device recovery 和幂等 dispose；它不解析 SFF/ACT，也不暴露到 Extensions 根聚合。
5. 来源无关的 fixed-tick driver、每玩家 keyboard/gamepad/virtual input snapshot 与 replay seam 进入 Engine focused experimental subpath。时钟使用整数 tick、显式 catch-up/pause policy；RAF 只提供 accumulator/render alpha。MUGEN command grammar、facing-relative direction与 state hash layout 留在 Games。
6. 来源无关的 owner-safe Web Audio mixer 进入 Engine focused experimental subpath。它拥有共享 AudioContext、bus、voice/channel、decode cache、pause/unlock、late-result disposal；SND parser、MUGEN channel replacement细节和 tick side-effect 生成留在 Games。
7. parser/decoder 使用已有 versioned WorkerChannel/AssetJob ownership 语义：plain-data envelope、unknown validation、AbortSignal、latest-wins generation、bounded queue、transferable、fault retirement 和迟到结果释放。资产内容错误不得触发主线程 fallback；只有明确登记的 infrastructure failure 才可 retry。
8. 所有 parser、decoder、compiler、VM、entity、Worker、CPU/GPU/audio 和 evidence 限额由 [`security-budgets.json`](../../../../milestones/milestones/m08-mugen-asset-vertical-slice/g01-contract/security-budgets.json) 统一定义。任何 count/offset/length/product 在分配前检查；strict profile 不提供提高预算的隐藏开关，超限 fail closed 并报告 observed/limit。
9. CNS 只编译到自有 typed bytecode。禁止 `eval`、`new Function`、动态 import、DOM/network/filesystem capability、外部 DLL 和任意 native code。authoritative simulation 只读取 package、seed 和 tick input；GPU、DOM、AudioContext、`performance.now()` 和非 seed random 不进入状态或 hash。
10. 许可与素材资格由 [`fixture-license-manifest.json`](../../../../milestones/milestones/m08-mugen-asset-vertical-slice/g01-contract/fixture-license-manifest.json) 决定。Elecbyte 环境/示例和未知许可社区角色只可在本地评估，不能进入仓库、CI、截图基线或发布包；formal fixtures 必须自制、CC0、MIT 或具有明确 CI/再分发授权。
11. 诊断、oracle trace、tick hash、pixel/audio/performance/security/lifecycle 证据分别遵循 G01 catalog/schema。未知官方 feature 必须阻断 owner ledger；M08 未实现 feature 必须导入失败，禁止静默 no-op 或近似成功。
12. 新 experimental subpath 仍需 exports、declaration/type tests、minimal manifest-backed MUGEN consumer、API review、focused browser/WebGPU/audio/lifecycle 证据。没有产品证据时不进入 Engine 根稳定入口。

## 安全与 no-go

- VFS 拒绝绝对路径、盘符、UNC、`..`、NUL、remote URL、符号链接和大小写折叠冲突。
- 文本编码由 profile/用户显式选择并写入 package；不得读取 host locale 或静默 heuristic。无 BOM 默认 Windows-1252，允许的 legacy encoding 由兼容 tuple 列举。
- SFF linked sprite/palette、archive dependency 和 trigger redirection 都有深度/环检测；压缩比、decoded pixel/PCM、expression depth、VM instruction 和 spawn 数量有硬上限。
- 无法安全表达运行时 palette remap、无法定义 int32/float32/bottom 数值、没有合法 oracle/corpus 或必须执行任意代码才能工作的内容，均提交 no-go，不降低边界。

## 验证

- `node milestones/m08-mugen-asset-vertical-slice/g01-contract/verify-g01-contract.mjs`
- Engine：focused workspace typecheck/test/build、boundary/API/package checks，以及 indexed/truecolor sprite、fixed tick、input、audio 的对应 browser/device/lifecycle gate。
- Games：import golden/fuzz、Node action/VM/combat determinism、manifest target build、browser pixel/audio/manual 与 restart/device-loss residue。
- M11 只有在 feature census 未分类为 0 且全部证据绑定同一 clean revision 后才能声明 `mugen-1.1b1-strict`。

## 后果

- 角色查看器可先复用 G02–G04，不等待 CNS、AI、音频或完整战斗循环。
- MUGEN 兼容复杂度被隔离在产品运行时，同时通用时钟、输入、音频和 indexed/truecolor renderer 获得其他游戏可复用的生命周期契约。
- strict profile 会拒绝部分社区包；兼容范围扩张必须新增 profile/Goal 和证据，不能通过 parser 宽松分支暗中发生。
