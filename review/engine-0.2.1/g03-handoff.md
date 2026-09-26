# G02 → G03 integration handoff

This document describes integration points. G03 activation is controlled by the milestone manifest; writing this handoff does not start G03. Final G02 evidence is linked from [G02 progress](g02-progress.md).

## Reference path and ownership

- `engine/src/frame/DeferredLightTable.ts`: one immutable World source snapshot, before Forward's eight-light selection. Directionals precede points. Stable GPU IDs are distinct from entity IDs; updates retain IDs, removal/re-addition must not alias a stale identity. Source and view generations must agree.
- `shader-language/src/deferred-lighting/`: ABI descriptor, generated CPU writers/reflection/WGSL, shared standard PBR surface and BRDF use. Keep ABI evolution atomic; never edit generated files.
- `engine/src/renderer/DeferredLightGpuTable.ts`: device/World source arena plus per-view headers/indices. The same source is uploaded once across views; unchanged source/camera-only changes must not re-upload it. Record slots are protected until all referencing encoders submit; buffers retire only after GPU completion.
- `engine/src/renderer/DeferredReferenceBackend.ts`: private backend integrated through `DeferredLightingBackendPort`, existing Render3D/frame graph and transient attachment pool. It owns neither a second scene graph nor a second presentation chain.
- `engine/src/experimental/DeferredReferenceProfile.ts`: private lazy factory; strict/Forward failure policy and async initialization cancellation. It is not exported from the public package. G07 owns public experimental API review and packaging.

## Tiled extension constraints

Keep the all-light reference selectable and unchanged as an oracle. Tiled membership indices must address the source's local point list; they are not stable IDs or raw entity IDs. Directionals/environment/emissive stay outside per-tile point loops and must contribute exactly once. Derive tile data per view, with explicit generation, camera/depth convention and target extent.

The reference path deliberately accepts every valid source point, including offscreen influences. G03 must not reuse Forward's truncated selection as its input. Overflow must select a correct full-list path in the same frame, never silently clamp or wait for a CPU readback to repair the next frame. Declare tile/list resource capacities, device-limit behavior and ownership before implementation.

Retain submission protection for multiple views/phases and out-of-order encoder submission. Do not restore completion-timed record-slot reuse; see [resource reuse](g02-resource-reuse.md). Retain final-output arithmetic vertex generation and explicit destination viewport/scissor state.

## Mandatory comparison matrix

Use `milestones/m18-engine-0.2.1/integration.md` B and the frozen G01 thresholds as authority. At minimum: 128/256 sparse/high-overlap scenes, per-light membership with no false negatives, near-plane intersections, camera inside a light sphere, orthographic/perspective, standard/reverse/remapped depth, jitter, resize, empty/background tiles, extreme ranges, additions/removals, and forced local/global overflow.

Pair Tiled and full-list pixels for the same source generation. Keep CPU geometric membership reference independent of GPU code. Separate cull/resolve/frame GPU timings, CPU record cost, uploads, allocations, tile distribution and index memory; do not claim speedup from reduced loop counts alone.

## Reproduction

```sh
node scripts/webgpu-gate/build-deferred-fixture.mjs
node scripts/webgpu-gate/run-deferred-fixture.mjs --full
node scripts/webgpu-gate/run-deferred-fixture.mjs --full --integrated
node scripts/webgpu-gate/run-deferred-fixture.mjs --room
node scripts/webgpu-gate/run-deferred-fixture.mjs --room --integrated
```

The full fixture enforces 0/1/8/9/32/128/256 lights, 256 individual stable-ID contributions, Forward parity, material/vertex-color assertions, eight reconstruction combinations, jitter, actual indirect draws, resource reuse, 32-submission ordering, and 576 four-view frames with nine profile activations. Preserve failed archives. Source/harness changes invalidate earlier captures.

## Later goals

G04 owns general transparent/special-material compatibility and the broader rendering matrix. G05 owns 60 FPS discrete / 30 FPS integrated performance qualification and frozen G01 budgets. G06 owns the public interactive example. G07 owns public exports, clean candidate/package/device release gates and release materials. Diagnostic native correctness evidence does not substitute for those goals.


Generated runtime artifacts now compact metadata and share the common PBR source. Keep full WGSL/provenance/IR/reflection byte equivalence and regeneration checks. Compute's current gzip artifact is at its 4,500-byte limit: future Tiled capabilities require measured cost attribution; no automatic budget increase is authorized. See [artifact size correction](g02-bundle-optimization.md).
