# Engine instructions

## Boundary

- `@haiyue/engine` is the dependency-free runtime foundation. Engine source must not import another workspace.
- Follow `docs/for-ai/api-stability.md`: the root export is an exact golden path; stable domain subpaths, focused experimental subpaths, and private modules have different compatibility promises.
- GPU/render internals, caches, frame plans, diagnostics, and low-level asset machinery must not leak through stable declarations accidentally.
- Optional loaders, third-party formats, heavy workers, and source-specific adapters belong in `extensions` unless an accepted ADR says otherwise.

## Rendering and shader rules

- Preserve frame/group 0, object/group 1, material/group 2, and pass/group 3 shader resource ownership. ABI changes require CPU packer, reflection, all consumers, tests, and diagnostics to move atomically.
- Morph, skinning, displacement, alpha coverage, and history semantics must remain consistent across forward, depth, shadow, motion-vector, and outline/selection passes.
- Never hand-edit `src/shaders/generated/**`. Change `shader-language` inputs/compiler and regenerate. A handwritten shader is allowed only as a deliberate documented escape hatch represented in the migration manifest.
- `prepare()` remains synchronous; real asynchronous setup belongs in `initialize()`. Do not move uploads or compilation into a hidden per-frame path.
- Transparent behavior must preserve ordering and correctness. Do not trade semantics for batching without explicit product evidence and pixel coverage.
- WebGPU is the product backend. Shader GLSL feasibility does not authorize an implicit WebGL2 renderer fallback.

## Lifecycle and performance

- Label GPU resources with stable owners and retire buffers/textures only after submitted work is safe. Handle device loss and pending `mapAsync()`/worker results without use-after-destroy.
- Unchanged object data must not be re-uploaded; multi-view rendering must not duplicate object uploads. Add structural counters when changing draw/pass/upload behavior.
- Use the shared versioned audit GPU device in benchmark/tests instead of creating incomplete one-off `GPUDevice` mocks.
- Performance work must preserve correctness and report CPU runtime, GPU/queue wait, upload bytes/count, draw/pass count, allocations, and resource residue as applicable. Never loosen a budget to conceal a regression.
- Respect the responsibility contracts in ADR 0037 and `scripts/check-responsibility-boundaries.mjs`; orchestrators coordinate but do not reacquire extracted responsibilities.

## Validation

```bash
npm run typecheck -w ./engine
npm test -w ./engine
npm run build -w ./engine
npm run modules:check
npm run responsibilities:check
npm run renderer-prepare:check
npm run api:check
```

- Add the focused browser/WebGPU verifier for material, renderer, postprocess, navigation, clipping, or device-lifecycle changes.
- Package/export work also requires `npm run verify:engine-package`.

