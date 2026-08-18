# HaiYue cross-engine performance comparison

This directory contains a reproducible same-host rendering comparison for HaiYue Engine, Three.js, Babylon.js, PlayCanvas and Galacean. It is deliberately separate from `scripts/benchmark`: the existing suites remain useful for finding an internal regression, while this suite answers whether HaiYue is competitive when several engines render the same scene on the same machine and browser.

## Commands

```bash
npm run performance:compare
npm run performance:compare:full
npm run performance:compare:formal
```

- `performance:compare` is a one-cohort smoke candidate.
- `performance:compare:full` runs three interleaved cohorts and enforces the comparison policy.
- `performance:compare:formal` additionally requires a clean revision and writes `artifacts/performance-comparison/formal.json`. It is the M02 release path.

Local candidate data is written to `data/local/latest.json` and ignored by Git. No command updates a reviewed baseline.

## Fairness contract

`scene-contract.mjs` is the source of truth. Every adapter renders a 1280×720 DPR-1 scene containing 256 one-unit boxes, 3,072 visible triangles, eight metallic-roughness materials, one directional light, one ambient/environment light, no shadows and no MSAA. The camera, transforms, colors and material parameters are deterministic.

The runner creates a fresh canvas and engine instance for every cohort. Adapter order rotates between cohorts. Each measured frame records CPU submission time and wall time through the engine-specific GPU completion fence. Every result contains raw samples, P50/P95, variance, browser/OS/CPU/adapter identity, dependency versions, source revision and the HTTP source hashes observed by the browser runner.

Each engine uses its normal optimized public scene path. Implementation details such as instancing and batching are reported instead of artificially forcing every engine to use the same draw-call count: optimizing an equivalent authored scene is part of an engine's performance value.

## Backend and decision policy

- HaiYue, Three.js, Babylon.js and PlayCanvas must all run native WebGPU and form the ranked group.
- Galacean 1.6 currently exposes WebGL1/2, so its WebGL2 result is required and reported but never mixed into the WebGPU ranking.
- Every adapter must match structural counts and pass an independently captured screenshot sanity gate. A blank frame, backend fallback, missing adapter or browser error fails closed. If cohort spread exceeds 15%, the result is inconclusive unless HaiYue's worst cohort still remains within 5% of the best cohort produced by any eligible competitor; this conservative dominance check prevents an obviously stable lead from being discarded only because very short frame times amplify scheduler noise.
- HaiYue passes when its median cohort P50 leads, or is within 5% of, the fastest eligible WebGPU competitor. This is a same-run relative decision; it does not require a named GPU model.

The exact hardware is still recorded. Software adapters, remote rendering and backend substitution remain invalid because a relative comparison is only meaningful when all ranked engines share one real host/browser environment.

Official backend references: [Three.js WebGPURenderer](https://threejs.org/manual/en/webgpurenderer), [Babylon.js WebGPU](https://doc.babylonjs.com/setup/support/webGPU/), [Galacean engine](https://galacean.antgroup.com/engine/en/docs/core/engine/), and [PlayCanvas WebGPU device support](https://api.playcanvas.com/engine/).
