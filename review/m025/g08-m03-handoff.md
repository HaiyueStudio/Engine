# M2.5 G08 handoff to M03

M03 may consume these frozen boundaries without reopening runtime ownership:

- Shader compiler/Graph/IR stays in `shader-language`; engine/editor runtime consumes generated Artifact V2 and must not parse or rewrite WGSL.
- Render coordination follows `RenderIntegration -> RenderFramePlanCompiler -> RenderPipeline -> RenderFrameContext`. Editor preview systems provide payloads; they do not take encoder/submission ownership.
- Renderer implementations compose `ParameterizedRendererCore`; editor preview or extension renderers use public material/extension contracts rather than another object-table cache.
- Extension/editor worker clients import the focused `@haiyue/engine/experimental/async` contract. They retain their payload validator and diagnostic domain but do not recreate request/fault/abort/clock state.
- GUI project/runtime payload is `haiyue.gui@1` and must enter through unknown validation. M03 should surface exact paths rather than catch-and-coerce malformed documents.
- Compute consumers declare storage/read/indirect ordering; GUI packers consume the private shared descriptor through engine-owned render paths.
- SceneBatch is benchmark-only and WASM is a no-go; neither has a production runtime or package export. M03 must not use either as authorization for archetype ECS, renderer threads, BVH WASM, or instance-builder WASM.

Minimum regression commands after editor-side integration:

```powershell
npm run typecheck
npm run check:boundaries
npm run responsibilities:check
npm run lifecycle:check
npm run api:check
npm run check:fast
npm run check:slow -- --content-tier=smoke
```

Held capabilities remain listed in `docs/for-ai/runtime-convergence/deferred-capabilities.md` and require the normal capability-admission workflow.
