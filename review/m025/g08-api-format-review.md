# M2.5 G08 API and format review

## Stable surface

No stable engine, extension, animation-spec, or UI entrypoint gained or lost an export. The `@haiyue/engine` root remains the exact 30-symbol ADR 0035 golden path. Scene, HYA, voxel, animation, and material public formats are unchanged.

## Reviewed experimental package changes

The API snapshot intentionally adds:

- `@haiyue/engine/experimental/async`: `WorkerChannel`, its structural worker/diagnostic types, protocol version, abort helper, monotonic clock, and worker-first orchestration;
- `@haiyue/engine/experimental/ktx2-worker-runtime`: a side-effect-only module-worker entry with zero exports;
- the compatibility `@haiyue/engine/experimental` aggregate equivalents needed by existing experimental callers;
- `recordComputeResourcePass` as the explicit compute/resource ordering seam;
- `GUI_SHAPE_VERTEX_LAYOUT` and `GUI_TEXTURED_VERTEX_LAYOUT` as executable CPU/GPU layout parity and custom-renderer diagnostics.

All three G06 values remain experimental rather than entering `./gui` or another stable subpath. The reviewed aggregate count is 793; focused entry budgets and all stable budgets are unchanged.

`review/baselines/api-surface.json` was regenerated only after this classification. `npm run api:check` then passed.

## Private/runtime formats

| Contract | Decision | Compatibility |
| --- | --- | --- |
| Production shader artifact | Private Artifact V2 only | V1 production writer/reader removed; generated engine declaration comes from the canonical shader-language contract |
| Worker envelope | Versioned experimental plain-data protocol | malformed/version-mismatched replies fault and retire the channel; no silent adapter |
| GUI persistence | `format: "haiyue.gui"`, `version: 1` | pre-0.1 atomic fixture migration under ADR 0005; no released legacy format |
| Compute ordering token | Experimental structural contract | WebGPU command order remains the mechanism; missing dependencies are structured errors |
| SceneBatch candidate | Benchmark-only derived data | production runtime/declarations removed; no package export or persisted format |
| WASM | No-go | no binary, loader, package, export, or fallback format exists |

Editor production chunks retain full hidden sourcemaps but omit repeated `sourceMappingURL` trailers. This is a packaging-only representation change; test bundles and JavaScript semantics are unchanged. No formal pixel, CPU, GPU, screenshot, fidelity, or performance baseline was changed.
