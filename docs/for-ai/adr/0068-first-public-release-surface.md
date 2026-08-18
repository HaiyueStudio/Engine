# ADR 0068：首发公共包、应用分发与版本边界

- 状态：Accepted
- 日期：2026-08-05

## 背景

HaiYue 已有 engine、HYA specification、optional extensions、共享 UI、三个编辑器、示例和游戏 workspace。它们都可被构建，但“可被仓库消费”不等于“首发公共 npm API”。若首发前不冻结 package visibility、应用渠道、stable/experimental 入口和独立数据格式版本，后续制品、文档、供应链与 RC Goals 会各自推断发布范围，产生无法原子回滚的混合 release。

## 决策

1. 首发公共 npm 包仅为 `@haiyue/engine@0.1.0` 与 `@haiyue/animation-spec@0.1.0`，以 public access 和 `latest` tag 作为正式发布渠道。G01 只冻结元数据，不执行 publish。
2. Engine 默认入口继续严格等于 ADR 0035 的 30 个黄金路径符号；所有非 `experimental` 子入口为 stable，`/experimental` 及其 focused 子入口为 experimental，未在 `exports` 中的文件为 private。
3. Animation Spec 的根入口、`/lottie`、`/native3d` 与 `hya-convert` CLI 为 0.1 stable。`@haiyue/extensions`、`@haiyue/ui` 和 `@haiyue/shader-language` 保持 private；它们的 package exports 只服务同仓构建，不构成外部兼容承诺。
4. Scene Editor 与 Animation Editor 作为 stable static web app 分发；Voxel Editor PWA 为 stable，未签名、未公证的 Electron 多平台制品为 preview。Examples 与 Games 作为 supporting static catalog 分发。所有对应 npm workspace 继续 `private: true`。
5. 本 release train 的 artifact 版本统一为 `0.1.0`，但每个 npm package、静态 deployment、PWA 和 Electron platform set 都是独立 rollback unit。后续版本不要求永久 lockstep。
6. 0.1.x patch 只接受向后兼容修复。新增 stable API 需要 reviewed minor；stable 破坏需要新的 minor、迁移说明、ADR、API diff 和完整 consumer 证据。Experimental 可在 minor 破坏，但仍须在 diff 和 release note 中显式出现。
7. HYA core `haiyue-animation@1.0`、binary container reader v1/v2（writer v2）、2D project `haiyue-animation-editor-project@1` schema 1、3D project `haiyue-animation-editor-project-3d@1` schema 1 和 required extension `org.haiyue.animation-3d@1` 独立于 npm/app 版本。
8. [`review/api/release-manifest.json`](../../../review/api/release-manifest.json) 是 G02–G06 只读消费的唯一 release scope manifest。浏览器与设备只引用 [`config/release-matrix.json`](../../../config/release-matrix.json)，不在 manifest 中复制。
9. Freeze 后只有 P0/P1 release blocker 可以新增行为。其他功能进入下一 milestone；例外必须由 G07 integration owner 记录、重新执行受影响验证并重新冻结。

## 后果

- Private editor/UI/extension exports 不会因应用交付而被误发布到 npm。
- 两个公共 package 的 tarball、declaration、每个 export subpath 和真实 consumer 可以形成明确的 G03 输入。
- 静态站点、PWA 与 Electron 能共享代码但保持不同支持等级和回滚单位。
- G02–G06 不得自行扩大 public package、入口、browser matrix 或 artifact 集；任何变更回到 G01/G07 shared owner。

## 验证

- `npm run api:check`
- `npm run check:boundaries`
- `npm run release:scope:check`
- `npm run docs:check`
