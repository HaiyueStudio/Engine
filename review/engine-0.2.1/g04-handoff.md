# G03 → G04 integration handoff

2026-09-27: G03 is complete and this handoff is accepted. G04 is ready, not activated. Read the [completion audit](g03-completion-audit.md), [accepted performance review](g03-final-performance-review.md) and milestone manifest before explicit G04 activation.

## Paths and ownership to preserve

- `DeferredLightTable` and generated ABI retain an untruncated immutable World source: directionals first, local points indexed from zero within the point subset. GPU IDs are not array indices. View/source generations must match. The G02 reference artifact remains `a175e0b8187143b3e432490463f3724d4fc1ef9e63e6b0ea776c4447258d7222`.
- `DeferredLightGpuTable` uploads a shared source once across views; immutable slots remain protected until every referencing encoder submits, and old buffers remain alive until submitted work completes. Camera-only changes must not rewrite source lighting.
- `DeferredTileCuller` derives lists from each view's actual projection/extent. It reuses SceneFrameGpuArena data through a separate compute-visible group; no duplicate scene-frame upload. Cull uses frustum/sphere tests without opaque depth min/max, preserving conservative membership.
- `DeferredTileResources` bounds active/pending view scopes and live generations, protects out-of-order pending encoders, and checks actual buffer capacity when enforcing view memory. Do not reduce protection to the latest submitted frame.
- `DeferredReferenceBackend` keeps the existing G-buffer, frame graph, surface port and output owner. Reference and Tiled profiles remain independent/private. No new scene graph or presentation chain is introduced.
- Initialization compiles required pipelines asynchronously. Recording stays synchronous; do not move compilation/upload ownership into an implicit per-frame initialization path.

## Full-list behavior

A tile owns a fixed 16-byte header plus 128 u32 indices. Accepted-count overflow or a missing whole tile record selects the complete view list in the same fragment invocation. Never accumulate the prefix and then the complete list, silently clamp, or wait for CPU readback to repair a later frame.

The automatic selector skips compute only for empty source or when every point sphere strictly contains the entire near-plane quad. The current optimized resolve still evaluates the complete view list, using a legal 4-byte sentinel binding with storedTiles=0. `effective=deferred-tiled` plus the explicit bypass reason distinguishes this from a capability failure to Forward. The frame graph declares tile-list reads only when compute actually produces the list. Forced-culling fixtures retain independent GPU overflow coverage even when an automatic bypass would be possible.

The optimized point function hoists per-pixel roughness/view/F0 terms and skips provably zero contributions. It assumes the currently admitted standard PBR material domain (including fixed IOR/specular defaults). When G04 adds material features, update both the reference semantics and specialization atomically, with pixel evidence; do not silently reuse fixed-default equations for clearcoat/sheen/custom IOR.

## Scope boundaries for G04

The current guard explicitly rejects transparent/helpers/special material surfaces unless the private caller chooses the restricted Forward failure policy. A successful Forward render has `completeCoverage=false`; it does not establish 128-light transparent PBR compatibility. G04 must implement the frozen complete-light transparent path and C/D matrix, not reinterpret the eight-light legacy result as complete.

If view eligibility gains a new key beyond source identity, update the source-to-view cache and per-view headers/indices accordingly. Preserve source sharing where eligibility is identical. This does not authorize a new public light-layer API.

Directional/global terms, emissive, environment and output conversion remain outside point loops and must occur exactly once. Per-view diagnostic snapshots must be captured at the corresponding record boundary; the backend's last-view fields are not a four-view aggregate.

## Required regression starting point

Use [point correctness](g03-point-correctness.json) and [point reference regression](g03-point-reference-regression.json) only after checking their fingerprints against current inputs. Preserve the 32 forced overflow/parity cases, 47 projection/geometry/BRDF cases, 1025→1024 source-capacity checks, four-view compute transitions/resize/reuse, G02 independent-light oracle and submission-order checks.

Reproduction:

```sh
node scripts/webgpu-gate/build-deferred-fixture.mjs --tiled
node scripts/webgpu-gate/run-deferred-tile-fixture.mjs --render
node scripts/webgpu-gate/run-deferred-tile-fixture.mjs --render --integrated
node scripts/webgpu-gate/run-deferred-tiled-cohorts.mjs --plan --idle-ms=120000
node scripts/webgpu-gate/run-deferred-tiled-cohorts.mjs --run --idle-ms=120000
```

Do not run builds or change runtime/harness sources during performance capture. Every full capture retains 120 warmup / 300 samples, 120-second idle for the accepted G03 population (30-second frozen minimum) and before/after host state. Three equal-size cohorts are pooled without dropping slow samples, while round stability is checked separately.

## Remaining admission and later owners

- G03's Shader cost proposal is approved/applied and the complete 25-node Stage14 chain passes; see [application evidence](g03-budget-application.json). The final 24-capture population passes all four relative budgets and all 32 stability channels, resolving both original sparse GPU failures and the overlap frame-wall failure. All raw/provenance checks and eight room combinations pass. No release qualification is implied.
- G05 owns the complete 60 FPS discrete / 30 FPS integrated absolute performance/device matrix. Accepted high-overlap Tiled P95 remains AMD GPU/frameWall 14.761/34.805 ms and Intel 62.894/69.315 ms, above the 12/16.667 and 24/33.333 ms limits. Preserve these gaps and the runner absolute-budget failure; sparse-scene improvements do not solve them.
- G06 owns the interactive example. G07 owns public experimental exports, new deferred consumer registration, clean release/package/device qualification and publication materials. Existing root/focused consumer budgets remain unchanged.
