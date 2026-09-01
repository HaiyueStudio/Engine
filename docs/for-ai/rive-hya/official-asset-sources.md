# Official Rive 7.3 evidence inputs

本清单记录可用于 G11 正式 evidence denominator 的官方 Rive 输入身份。它不在 HaiYue 仓库保存 `.riv` 字节；正式 runner 按固定下载 URL 写入临时目录，先校验 byte length 与 SHA-256，再运行官方 oracle 和 HYA 转换，结束后清理临时输入。

## Source policy

- 官方范围限于 `rive-app` 组织维护的仓库路径；普通 Marketplace/Community 作者素材不因托管在 Rive 网站而自动成为“官方素材”。
- 身份由 repository + 40 位 commit + path + immutable URL + byte length + SHA-256 组成。branch URL、latest URL、Editor 版本号和 mutable share link 均不成立。
- 官方链接、hash 与 MIT license evidence 证明输入来源和可复现性，可以使素材进入正式分母；它们不证明转换已经通过。正式结论仍需要同一 clean revision 上冻结 workload 的 oracle/HYA trace、设备信息和 artifact validator。
- 失败的官方素材保留为正式红色证据，不能从 denominator 删除。素材内若引用额外 font/image/audio/library，仍须逐项登记 transitive rights 与 hash。

冻结仓库是 [`rive-app/rive-runtime@3f4047a85f11fecfde8c4d906c0c1654aa12b015`](https://github.com/rive-app/rive-runtime/commit/3f4047a85f11fecfde8c4d906c0c1654aa12b015)。源码归档 SHA-256 为 `021a49ed83ddda9a5e476d8c3a165c0eb44960e6719e751f4711b6b8befe1062`；[MIT license](https://github.com/rive-app/rive-runtime/blob/3f4047a85f11fecfde8c4d906c0c1654aa12b015/LICENSE) SHA-256 为 `fa43eb0d7fbf66f9504182d92dd097311278bb80111a5bf1403c366d6a403144`。

## Exact 7.3 catalog

| Input | Bytes / SHA-256 | Intended evidence roles |
| --- | --- | --- |
| [`game_menu_ad_police_files.riv`](https://github.com/rive-app/rive-runtime/blob/3f4047a85f11fecfde8c4d906c0c1654aa12b015/tests/unit_tests/assets/game_menu_ad_police_files.riv) | `4,806,420` / `19c7306dbaa741d1d4e3ce7239b98c3a40943f07f1260a92851f2e558fd6e9f5` | large multi-artboard animation/state-machine product-like stress |
| [`inventory_demo_test_v2.riv`](https://github.com/rive-app/rive-runtime/blob/3f4047a85f11fecfde8c4d906c0c1654aa12b015/tests/unit_tests/assets/inventory_demo_test_v2.riv) | `394,478` / `6ff18f16bc96efe5fa7027bf5f149c55d722f5894f6f28083548d65ec40ca9cf` | data/layout/component inventory combination |
| [`joystick_databound_keyframe_test.riv`](https://github.com/rive-app/rive-runtime/blob/3f4047a85f11fecfde8c4d906c0c1654aa12b015/tests/unit_tests/assets/joystick_databound_keyframe_test.riv) | `708` / `ca3e052d533a32143279f8e035f95ca53461a4f5d5fdf782bd0e63332bbe2c63` | data-bound keyframe and state-machine isolation |
| [`grid_placement_bound.riv`](https://github.com/rive-app/rive-runtime/blob/3f4047a85f11fecfde8c4d906c0c1654aa12b015/tests/unit_tests/assets/layout/grid_placement_bound.riv) | `385` / `02dca529414c584c38e7c438e501e276d89337588d9042381120d330784380d0` | minimal grid placement/data-bound layout |
| [`layoutstest_8-planets-grid.riv`](https://github.com/rive-app/rive-runtime/blob/3f4047a85f11fecfde8c4d906c0c1654aa12b015/tests/unit_tests/assets/layoutstest_8-planets-grid.riv) | `310,228` / `aa42cd7baac6d5a67c1e8f5804c354d2ea9f0583678f1f037f33f9221a8ce8c0` | multi-artboard grid/layout/state-machine stress |
| [`text_fit_test.riv`](https://github.com/rive-app/rive-runtime/blob/3f4047a85f11fecfde8c4d906c0c1654aa12b015/tests/unit_tests/assets/text_fit_test.riv) | `877,874` / `540cfae6ba78a81518525af17a8d09e4cd50131dcbd9e584832c2468f24fbcd3` | text fit/layout/state-machine coverage |
| [`text_style_background.riv`](https://github.com/rive-app/rive-runtime/blob/3f4047a85f11fecfde8c4d906c0c1654aa12b015/tests/unit_tests/assets/text_style_background.riv) | `1,287,851` / `1ffdb33251da4ccd7713555d7fb1f1216326cd52fb7fd1d6206b72471ea9080c` | positive text-style import control |
| [`double_library_with_image.riv`](https://github.com/rive-app/rive-runtime/blob/3f4047a85f11fecfde8c4d906c0c1654aa12b015/tests/unit_tests/assets/double_library_with_image.riv) | `749` / `a11cac0f7453147eef9d5a387472ab3235868f404354fe8e44e0a89b2b729162` | positive library/image import control |

每项的机器可读 `downloadUrl`、格式、许可、storage policy 与 `evidenceRoles` 由 [`rive-g11-corpus-manifest.json`](../../../animation-spec/corpus/rive/rive-g11-corpus-manifest.json) 固定。一个素材可同时承担 feature、product、combined-stress 或 property-boundary role；role 不复制 `.riv`，也不减少素材 × 设备 × 浏览器的正式 trace 分母。文档链接用于人工溯源，不是 runner 使用的 mutable 输入。

## Current diagnostic observation

2026-08-25 的 Chrome 与 Edge 非正式筛查中，上述 8 个输入均可由冻结 official WebGL2 oracle 加载，两个浏览器的 owner residual 均为 0。G01 compatibility addendum 与 G02 importer follow-up 已显式分类 runtime-null object `526`、property `565`、file-level `ViewModelInstance` aggregate 与 `ScrollPhysics` hierarchy，当前 importer 接受 8 项且未分类失败为 0。

2026-09-01 的 `layoutstest_8-planets-grid.riv` 定向回归进一步区分了静态渲染与行为缺口：`Planets-OneLayout / Pluto / ForGridPlanet` 的静态行星选择和 nested-leaf fit 已工作；缺失行为来自 `StateMachineListenerSingle` 的 pointer enter/exit、`ListenerBoolChange` 布尔输入、嵌套状态转换，以及 `Float → PlutoIn → PlutoIdle2` 时间轴未被执行。本轮 production evaluator 将这个有界组合降级为 HYA core timeline + `org.haiyue.interaction@1`：初始帧转换成功，产物包含嵌套 transform tracks 和 enter/exit listener。Feature Corpus 因而只把 `NestedArtboard*`、`StateMachineListenerSingle`、`ListenerBoolChange` 及其已消费字段从 `missing` 调整为 `partial`；trigger/number listener、任意状态机条件/混合/中断、skin/mesh deformation 和正式跨设备 pixel parity 仍未闭环。该记录是实现回归证据，不替代 G11 clean-revision 的正式 trace。

同日的后续逐帧回归确认，hover 后右下角跳变不是新的素材能力缺口，而是 HYA 简化 flex solver 把 `PaddingExpand` 的四边 padding 当成 `NestedArtboardLeaf` 的普通位移，额外写入了 `(500, 500)`。solver 现在保持 nested leaf 在宿主原点，由 nested-fit 单独处理内容尺寸；idle/hover 两套树的所有可绘制根会作为一个状态整体切换，避免无父绘制节点残留。`CubicEaseInterpolator` 的官方默认控制点 `(0.42, 0, 0.58, 1)` 也已按固定 60 Hz 线性采样写入 HYA timeline，对照页在两端加载完成后统一归零。随后发现面部节点虽然完整进入 hover 树，却因 importer 的 Rive drawable ledger 被正序当作 HYA painter order，先绘制的眼睛和嘴被后绘制的不透明行星主体覆盖；转换器现在按 scope 反转 front-to-back ledger，面部与轮廓可同时显示，并已回归 Police Files 展开面板和 Inventory 复合界面。Feature Corpus 仍保持 layout、timeline/state-machine 与 interaction 为 `partial`：本次只闭合该官方素材实际命中的 nested-leaf padding、cubic-ease loop、drawable painter order 和 boolean pointer-hover 路径，不把未实现的通用 flex、transition mixing/interruption 或其他 listener 类型误报为完整支持。

本轮 Eight Planets hover 逐帧回归又闭合了四项素材实际命中的语义：启用的 animation work area 会裁剪并重定位 keyframe，省略序列化值的 `KeyFrameDouble` 按 Rive 默认零值进入曲线，拓扑稳定的 `PointsPath`/vertex 动画会以绝对 morph track 写入 HYA，嵌套响应式内容的已解析祖先放大倍率会降级为可执行 scale track。因此 pointer enter 现在按 `NeptuneIn → NeptuneIdle` 顺序完成放大、旋转和连续表情变化；pointer exit 执行独立的 `NeptuneOut → NeptuneDefault` 后再恢复无表情树，再次 enter 从入场起点重播。该 lowering 仍不是通用运行时 Yoga/flex solver，也不覆盖拓扑变化的 path、任意状态混合或 transition interruption，所以 Feature Corpus 中 vector、layout、timeline/state-machine 与 interaction 继续保持 `partial`。

后续回归把响应式入场、循环与退出阶段进一步分离：放大/位移采用父 `ForGridPlanet` 布尔 transition 的作者值 `200 ms`，并按 nested artboard 高度抵消缩放产生的垂直漂移，只保留向右扩张与原路回收；组合时间轴保存 `loopStart=1 s`、`loopEnd=7 s`、`exitStart=7 s`，播放器只循环完整的 6 秒 `NeptuneIdle`，离开 hover 后再单次播放约 1 秒的退出尾段。因此第二轮表情变化不会重放入场位移、放大或旋转，离开也不再瞬间复位。素材中直接动画化的 `PointsPath` 轮廓按 60 Hz 样本使用 step hold，保留官方轮廓的间隔跳跃感。播放区间是通用 HYA 能力，但 transition 查找与响应式位移仍只闭合该确定性 boolean/nested-fit 子图。

8 项已经进入 G11 `formalAssets` 输入分母并承担 19 个独立 role，覆盖 8/8 feature family、4/4 product case 与 3 个 combined-stress witness。每项都绑定完整 workload scenario、官方浏览器 load/selection/首帧记录与 importer feature coverage，并已标记为 `trace-ready`。ADR 0092 另用 HaiYue 自有、MIT、确定性生成且经 `readFrozenRiv` 重放的 3047-byte 7.3 fixture 闭合 288/288 object、565/565 property 与 9/9 asset wire key；该 fixture 不承担 behavioral role 或设备 trace。G10 pipeline 与 G11 v2 runner 通过 [`haiyue-rive-production-adapter@1`](./production-differential-adapter.md) 连接 revision-pinned capability、native official WebGL2 和 exact-HYA WebGPU 可执行宿主，并由 validator 重算全部 channel comparison。当前仍缺三个已配置 production host、clean worktree，以及两台不同 Windows 10+ 物理设备上的 Chrome/Edge trace 与 performance；Node.js 22 及更高版本均可用于正式运行。机器可读缺口来自 [`rive-g11-evidence-index.json`](../../../review/candidates/rive-g11-evidence-index.json) 与 [`rive-g11-candidate.json`](../../../review/candidates/rive-g11-candidate.json)。
