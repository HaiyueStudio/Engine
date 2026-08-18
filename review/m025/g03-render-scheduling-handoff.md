# M2.5 G03 render scheduling handoff

- Goal / source revision / candidate revision: `g03-render-scheduling-positive-contracts`; source `e246e53`; candidate is the G03 working tree pending its clean commit.
- Changed owners:
  - Pipeline entry ordering: mutable `RenderPipeline._entries.sort()` -> device-free `RenderFramePlanCompiler`, producing cached immutable plan items only when registration changes.
  - Logical dependency/reachability/lifetime: `RenderGraph` remains the sole device-free graph compiler; external/observable resource writers are now explicit DCE roots.
  - Actual pass compatibility/submission: `RenderPipeline` compares resolved descriptor attachment identities, stable target key, depth presence, sample count, load/store and required pass state before sharing an encoder pass.
  - Command encoder/pass/submission lifecycle: `RenderFrameContext` remains the sole owner; `RenderIntegration` coordinates systems and frame tokens without recording commands or compiling graph dependencies.
- Deleted duplicate state machines/files/branches:
  - Removed Pipeline-owned entry sorting; it only consumes the compiled frame plan.
  - Removed the `hasSameRenderTarget() => true` placeholder.
  - Removed diagnostics-off GPU timing labels and stale trace retention; no pass/issue arrays, conflict strings or timing labels are produced on that path.
- Public API / format / package diff: none. New frame/plan types are private runtime contracts; `npm run api:check` passed.
- Targeted commands and results:
  - Focused scheduling/graph/observability/mirror suite: 42 tests passed.
  - `npm run typecheck -w ./engine`; `npm test -w ./engine` (515 passed); `npm run build -w ./engine`: passed.
  - `npm run modules:check`; `npm run responsibilities:check`; `npm run renderer-prepare:check`; `npm run api:check`: passed.
- Browser/WebGPU/device candidate evidence: `npm run verify:planar-reflection` passed 4 real WebGPU cases and 4 pixel gates. The GTX 1070 Ti Windows device recorded four existing P95 checks as diagnostic-only over budget; no performance baseline or budget was changed, and G03 makes no performance-improvement claim.
- Allocation/upload/draw/pass/bundle/startup impact:
  - Frame plan allocation occurs only when systems are added, removed or cleared; steady diagnostics-off execution reuses the plan and empty trace constants.
  - Pass merging is stricter only when actual attachment/sample/depth/state differs; compatible shared passes keep the existing one-pass behavior.
  - No renderer object table, upload policy, draw count or package export changed.
- Failure injection and lifecycle residual:
  - Single-writer and dependency-cycle failures remain structured.
  - Observable external outputs cannot be removed by DCE; transient unobserved writers remain culled.
  - Shared target/load/store/sample/depth conflicts split the pass and produce diagnostics from the same decision used by execution.
- Deferred or blocked items: renderer object/geometry/upload owner migration belongs to G04. Formal release/device performance evidence remains owned by M02/G08.
- Follow-up required from G04: import the private frame/plan contract rather than recreating sort/submit state; renderer-specific policy must remain payload, never move target resolution or encoder ownership into the shared renderer core.

## Frozen G04 contract

`RenderIntegration (frame coordinator) -> RenderFramePlanCompiler (immutable order) -> RenderPipeline (actual target resolution and submit) -> RenderFrameContext (encoder/resource lifecycle)`

RenderGraph output may be encapsulated inside one Pipeline system payload (for example Render3D mirror planning), but Pipeline does not re-derive its logical dependencies or transient lifetime. The pass-history fixture index is `review/m025/g03-pass-history-fixtures.json`.

Candidate browser artifacts and diagnostic timing are not formal release evidence.
