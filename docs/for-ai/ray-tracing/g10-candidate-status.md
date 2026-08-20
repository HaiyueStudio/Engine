# M04 G10 ray tracing candidate status

日期：2026-08-20。当前结论：`pre-commit candidate passed`。实现、人工视觉候选和提交前门禁已通过；正式 G10 证据仍须在本次变更形成 clean revision 后，以 Node 22 在同一 revision tuple 上重采并由 validator 接受。

## Candidate tuple

| Repository | Revision before integration commit | State during candidate capture |
| --- | --- | --- |
| Engine | `e54e1df573d1adec0454bbc99ff1b75c0c6ae642` | dirty：G10 integration candidate |
| Editor | `829c676ae99900d3964c9cb8d9bbd91a5535a245` | clean |
| Games | `101833f2655e72d5ae2aa0657ac9da1959f66542` | dirty：Gravity Maze RT candidate |
| UI | `1b1ec27a2d9684356f8158c40f23390838fa262b` | dirty：dist-only public package contract |
| milestones | `08708a280c9dcf190fb70fe713d6cb3120c95638` | clean |

这些 revision 只标识提交前候选来源，不是正式 evidence tuple。正式 artifact 必须记录提交后的 clean Engine、Games、UI 与现有 clean Editor/milestones revision。

## Accepted integration decisions

- 人工视觉候选已批准；正式 capture 仍须绑定 clean tuple，且只能在 capture-set hash 与已批准候选完全一致时复用签字。
- 新增 `.github/workflows/ci-slow.yml` 与 `.github/workflows/ci-device-performance.yml`。
- `@haiyue/engine`、`@haiyue/animation-spec`、`@haiyue/extensions`、`@haiyue/shader-language`、`@haiyue/ui` 是正式公共 npm 范围；五个包均只发布 `dist`，不再提供 `source` condition 或 `src/**/*` 发布入口。
- 公共 API 与 package budget 改为按 capability 归属、稳定性、已审符号/产物和增长 reserve 管理；新增能力必须重新评审 capability budget，而不是维持历史总量。
- `@haiyue/engine` root 仍是固定 golden path，精确 30 个符号且 reserve 为 0；ray tracing 只从 experimental focused subpath `@haiyue/extensions/ray-tracing` 暴露。
- Stage 9 exact evidence `componentsEvidenceArtifactGzipBytes` 从错误记录 `2336` 修正为可复现值 `2334`；没有扩大 tolerance。

## Green pre-commit gates

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
- 产品候选：small analytic、medium material/light 和 Gravity Maze large-real-product 在 Chrome/Edge 均通过且 source/candidate hash 一致。Gravity Maze source 为 `0145dcc0…`、candidate 为 `4a31c3e1…`；0 未分类失败。
- Bundle topology：Gravity Maze 默认 bundle 不含 ray tracing runtime；RT 仅存在于 opt-in chunk（354,633B）。
- `haiyue-ray-product-candidate@1` diagnostic validator 通过，HTTP provenance、native backend、profile cleanup、像素/内存、跨浏览器确定性和 bundle topology 均完整。

## Remaining formalization step

1. 按用户授权分别提交 UI、Engine、Games；不 push、tag、publish。
2. 确认 Engine、Editor、Games、UI、milestones 均为 clean worktree，并固定最终 revision tuple。
3. 使用 Node 22 在该 clean tuple 重采 product artifact 与 G10 review capture；复用人工签字前必须确认 capture-set hash 与已批准候选完全相同。
4. 运行 `npm run ray-tracing:product-artifact:check -- --formal` 与 `npm run ray-tracing:g10:review:check -- --formal`。只有两者及 clean revision 条件全部通过，才能把 G10 标记 complete。

在上述正式化步骤完成前，不把 diagnostic artifact 冒充正式证据，也不更新 pixel/performance baseline。
