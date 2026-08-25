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

8 项已经进入 G11 `formalAssets` 输入分母并承担 19 个独立 role，覆盖 8/8 feature family、4/4 product case 与 3 个 combined-stress witness。每项都绑定完整 workload scenario、官方浏览器 load/selection/首帧记录与 importer feature coverage。G10 pipeline 与 G11 v2 runner 通过 [`haiyue-rive-production-adapter@1`](./production-differential-adapter.md) 连接 revision-pinned capability、native official WebGL2 和 exact-HYA WebGPU 可执行宿主，并由 validator 重算全部 channel comparison。它们仍全部标记为 `not trace-ready`：仓库当前没有配置完成这些 workload 的三个 native host，worktree 也不 clean，且尚无两台不同的 Windows 10+ 物理设备完成 Chrome/Edge 证据。Node.js 22 及更高版本均可用于正式运行。机器可读缺口来自 [`rive-g11-evidence-index.json`](../../../review/candidates/rive-g11-evidence-index.json) 与 [`rive-g11-candidate.json`](../../../review/candidates/rive-g11-candidate.json)。
