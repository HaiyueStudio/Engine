# M2.5 G07 SceneBatch ownership handoff

## Decision

G07 rejects a WASM runtime. G08 then applied the frozen package/bundle admission gate and removed the pure-TypeScript `Render3DSceneBatch` from production as well. `World`, `Entity`, components, hierarchy, and `FrameData` remain the only authoritative state.

The final benchmark-only `SceneBatchCandidate` is under `scripts/benchmark/`. It is not imported by `engine/src`, emitted into `engine/dist`, or shipped in a public package. This closes the temporary diagnostic path after integration showed that even dormant static code reduced the editor's frozen total-gzip headroom below 10%.

## Schema and owner

The benchmark process owns exactly one monotonically growing candidate batch. `SceneBatchCandidate` owns:

- stable `entityIds`, entity-to-index mapping, `parentIndices`, and parent-first topology;
- local/world matrices and local/world numeric versions;
- world spheres and flags for sphere/helper/outline presence;
- per-view visible mask/index and depth output;
- separate structural and numeric revisions.

Structure is rebuilt only when entity identity or parent identity changes. Matrix copies occur only when their version changes; sphere values are compared in place. `prepareView()` allocates no TypedArray and preserves source order. Structure rebuild may use a temporary number stack because it is not a per-frame numeric path.

Disabled hierarchy filtering, LOD/resource choice, transparent material classification, and component lifecycle remain owned by the object extraction/collection path. The batch consumes the resulting `WorldFrameState`; it does not duplicate those policies.

## Correctness evidence

`engine/test/wasm-scene-batch-no-go.test.mjs` verifies the benchmark oracle and final absence boundary:

- stable entity identity with child-before-parent input and parent-first topology;
- no structural/numeric revision or backing-array change on a clean sync;
- dirty local/world numeric synchronization without structural rebuild;
- exact visible batch order, entity identity, depth, and sphere mapping;
- absence of production SceneBatch/WASM modules, dependencies, and public package exports.

The generated benchmark at `review/m025/g07-scene-batch-benchmark.json` replays 1k/10k/50k hierarchy fixtures across two views with 8 warmups and 30 raw samples. Each size checks entity id, world matrix, visible id, depth, and stable-order parity before timing.

## Final integration boundary

- Allocation owner: benchmark process only.
- Production allocation/reset/per-view scratch: none.
- Public API/export change: none.
- Root manifest or formal baseline change: none.
- Re-entry condition: new product evidence must independently pass correctness, 10k/50k performance, browser, package, and bundle admission before any runtime code returns.
