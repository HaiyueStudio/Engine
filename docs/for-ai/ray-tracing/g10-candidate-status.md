# M04 G10 ray tracing formal acceptance

日期：2026-08-21。当前结论：`formal passed`。第一版 WebGPU ray tracing 能力、响应式分辨率、Gravity Maze 真实产品候选、公共包与预算政策已经完成实现、人工视觉批准、完整门禁和正式证据验证。

## Formal revision tuple

| Repository | Accepted revision | State during formal capture |
| --- | --- | --- |
| Engine | 由两份正式 artifact 的 Engine provenance 记录 | clean |
| Editor | `829c676ae99900d3964c9cb8d9bbd91a5535a245` | clean |
| Games | `86b657ed743598f674dbab1a7983017923f572cb` | clean |
| UI | `72ef29ea322466ba4137410b880ddcc7e7d7e571` | clean |
| milestones | `08708a280c9dcf190fb70fe713d6cb3120c95638` | clean |

状态文档属于 Engine revision，因此不在文档正文中硬编码自身提交后的 Engine hash。最终 Engine revision 以 `artifacts/ray-tracing/g09-product-candidates.json` 的 `evidence.engineRevision` 和 `artifacts/ray-tracing-g10-review/manifest.json` 的 Engine repository entry 为唯一事实来源；product artifact 同时记录 clean Games revision，review manifest 记录五个 clean repository revision。正式证据使用 Node 22 生成，并由独立 formal validator 接受。

## Accepted integration decisions

- 用户已批准稳定单帧视觉候选；正式 review capture 的 capture-set 为 `4145058769dd7966c65100f6906c54f5086f83be3052d7dca3f66dce8d3cf950`，只在逐图 hash 完全一致时复用批准。
- 新增 `.github/workflows/ci-slow.yml` 与 `.github/workflows/ci-device-performance.yml`。
- `@haiyue/engine`、`@haiyue/animation-spec`、`@haiyue/extensions`、`@haiyue/shader-language`、`@haiyue/ui` 是正式公共 npm 范围；五个包均只发布 `dist`，不再提供 `source` condition 或 `src/**/*` 发布入口。
- 公共 API 与 package budget 按 capability 归属、稳定性、已审符号/产物和增长 reserve 管理。后续新增能力必须评估需要开放的 API、无需公开的内部实现和对应 reserve，不沿用历史总量作为固定上限。
- `@haiyue/engine` root 仍是固定 golden path，精确 30 个符号且 reserve 为 0；ray tracing 只从 experimental focused subpath `@haiyue/extensions/ray-tracing` 暴露。
- Stage 9 exact evidence `componentsEvidenceArtifactGzipBytes` 从错误记录 `2336` 修正为可复现值 `2334`，没有扩大 tolerance。
- 未提升 pixel、CPU、GPU、gzip 或 performance baseline；未执行 push、tag 或 publish。

## Green repository gates

- Focused ray tests：58 个 oracle、scene、BLAS/TLAS、traversal、path、progressive、hybrid、Worker、lifecycle 与 package-export tests。
- `npm run check:fast`：完整通过。工作区测试计数包括 Engine 538、Animation Spec 76、Extensions 219、Shader Language 140、UI 14、Games 40、Editor 101、Animation Editor 107、Voxel 145。
- `npm run check:slow -- --content-tier=smoke`：50 个目标完整通过。
- `npm run check:slow -- --content-tier=full`：61 个目标完整通过；52 个 Engine examples（含 `ray-tracing`）和 9 个 Games（含 `gravity-maze`）均构建成功。
- `npm run verify:engine-package`：五个正式公共包完成 build、pack、确定性 repack、真实 npm install、全部 exports、Node/TypeScript/CLI 与 browser consumer 验证。Shader material graph consumer 为 39,688B gzip（预算 65,000B），UI button consumer 为 830B gzip（预算 5,000B）。
- `npm run api:check`、`npm run check:boundaries`、`npm run release:scope:check`、`npm run docs:check` 与 Stage 14 DAG 通过；Stage 9 exact evidence 为 `2334`。
- Editor create/save/export/play、glTF、Tetris 和 RT preview enable/save/reopen/play/unload/reload/teardown E2E 通过；startup closure 29.3KiB gzip，总 bundle 965.1KiB gzip，保留 245.8KiB headroom。
- 产品截图、readback churn、glTF asset、真实 renderer、128-light、planar reflection、Motion Blur、AO、clipping、NavMesh、PBR、Fog、Volume、基础像素、大场景与 Editor memory 门禁通过。CPU benchmark 没有合格相对 baseline，其绝对超限仍按既有政策保留为 diagnostic-only，未提高预算。

## Ray-specific device, browser, long-run and product evidence

- G04 traversal：Chrome/Edge 原生 D3D11 WebGPU；3 fixed、4 edge、256 randomized、256 any-hit、44 dispatches、0 mismatch、峰值 72,720B。
- G05 path tracing：Chrome/Edge candidate `fnv1a32:35f11fe8`；576 pixels、1,416 rays、996 bounces、峰值 14,048B。
- G06 progressive：Chrome/Edge candidate `fnv1a32:e01072cf`；32 samples、128-sample long run、13 resets/recovery，convergence `2.682 -> 0.659`，峰值 46,304B。
- G07 hybrid shadow/reflection/AO：Chrome/Edge artifact `4a09990032ae1bfa…`；遮挡、反射命中、AO、透明中性与 composite checks 全部通过，0 GPU/browser 未分类错误。
- G08 Worker/device lifecycle：Chrome/Edge crash recovery、latest-wins、queue overflow、late reply classification、device generation `1 -> 3`、4/4 Worker terminated、zero residual 全部通过。
- Ray example：Chrome/Edge analytic/material 固定 hash 一致；响应式门禁实测 CSS display size × `pixelRatio=0.5` 得到 `271x153`。交互默认值来自 `window.devicePixelRatio`，不再使用固定渲染分辨率；evidence mode 继续显式固定尺寸以保证可重放。
- Gravity Maze evidence mode 在场景/源快照完成后只渲染一个确定性的 `after-update` raster frame，随后停止 Engine 并等待 GPU queue；连续两次 Node 22 capture 的六张图片逐图 hash 完全一致。Gravity Maze PNG hash 为 `ac226c72979ebed99777543651179946384871dc9f48a49af2b7133a10fdbe24`。
- 产品候选：small analytic、medium material/light 和 Gravity Maze large-real-product 在 Chrome/Edge 均通过且 source/candidate hash 一致。Gravity Maze source 为 `0145dcc0…`、candidate 为 `4a31c3e1…`；0 未分类失败。
- Bundle topology：Gravity Maze 默认 bundle 不含 ray tracing runtime；RT 仅存在于 opt-in chunk（354,771B）。

## Formal artifacts

- `artifacts/ray-tracing/g09-product-candidates.json`：`haiyue-ray-product-candidate@1` formal artifact；验证 HTTP provenance、native backend、profile cleanup、像素/内存、跨浏览器确定性、bundle topology 和 clean revision tuple。
- `artifacts/ray-tracing-g10-review/manifest.json`：G10 clean-revision review capture；记录逐图 hash、批准 receipt、Node 22 环境和五个 clean repository revision，其中 Engine/Games 与 product artifact 一致。
- `npm run ray-tracing:product-artifact:check -- --formal` 与 `npm run ray-tracing:g10:review:check -- --formal` 均通过。

至此 M04 G10 的实现、产品集成、人工批准、正式 artifact 和验证闭环完成。artifacts 为本地可重建证据，不作为手工编辑的发布内容提交。
