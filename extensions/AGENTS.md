# Extensions instructions

## Boundary

- This workspace owns optional complete capability slices: component, system, renderer, loader, worker, runtime, adapter, plugin factory, and diagnostics.
- Allowed workspace dependencies are only `engine` and `animation-spec`. Import them through declared package exports, never relative paths or private `src/` files.
- Keep `@haiyue/extensions` root lightweight. Heavy glTF, Spine, animation, Worker, and similar features are exposed from focused subpaths and remain lazy for consumers.
- Engine must never depend on extensions. Editor-specific UI stays in `editor`; expose a contribution description instead of importing editor internals.

## Implementation rules

- Source-specific parsing/adaptation must lower to source-independent runtime contracts. Do not duplicate sampler, mixer, state-machine, particle, or renderer implementations for one importer.
- glTF animation preserves STEP, LINEAR, and CUBICSPLINE and binds root TRS, joints, and GPU morph through the public Animation3D pose/mixer contracts.
- Worker protocols use plain data, explicit versions, transferables where safe, AbortSignal, latest-wins/generation identity, bounded queues, and deterministic disposal. Do not silently fall back to blocking main-thread work.
- Resource replacement, abort, scene destruction, and plugin rollback must remove bindings, actions, handles, listeners, workers, and GPU resources.
- Never hand-edit `src/shaders/generated/**`; regenerate it from `shader-language`.
- A new public subpath requires exports, declarations, focused type tests, docs, a minimal example, and API review. Do not aggregate it into the root by default.

## Validation

```bash
npm run typecheck -w ./extensions
npm test -w ./extensions
npm run build -w ./extensions
npm run check:boundaries
npm run api:check
```

- glTF work also runs `npm run verify:gltf-asset`; visual feature changes add their focused example/WebGPU verifier.

