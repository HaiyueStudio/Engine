# M2.5 G07 WASM admission no-go

## Result

WASM is **not admitted**. The prerequisite end-to-end TypedArray batch did not meet ADR 0079, so implementing or packaging a WASM transform/cull runtime would add an unproven owner and is forbidden.

| Renderables | Object total P50 | Typed total P50 | P50 change | Object P95 | Typed P95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.3047 ms | 0.2932 ms | 3.8% faster | 0.4150 ms | 0.3570 ms |
| 10,000 | 2.9677 ms | 7.3870 ms | 148.9% slower | 4.1545 ms | 10.5097 ms |
| 50,000 | 11.3904 ms | 30.2102 ms | 165.2% slower | 14.7891 ms | 35.0268 ms |

The retention threshold required at least 20% P50 improvement at both 10k and 50k with no P95 regression. The candidate failed both conditions by a wide margin. Exact parity passed for entity ids, matrices, visible ids, depth, and order, so the no-go is performance-based rather than a correctness waiver.

These timings are candidate evidence on Windows 10, Node 24.19.0, Intel Core i7-7700, not a formal release performance baseline. Raw samples, RSD, allocation observations, workload, and environment are in `g07-scene-batch-benchmark.json` and can be regenerated with:

```powershell
npm run benchmark:wasm -w ./engine -- --output=../review/m025/g07-scene-batch-benchmark.json
```

## Deletion/absence proof

- The earlier sphere-only feasibility microbenchmark was removed because it did not include current extraction/sync/map-back costs or full parity.
- There is no `.wasm` binary, WebAssembly loader/glue, WASM package dependency, worker, package export, initialization hook, fallback state machine, or runtime call.
- The temporary `engine/src/wasm/Render3DSceneBatch*.ts` diagnostic path was removed during G08 because it had no performance value and breached frozen editor bundle headroom. Its reproducible oracle is retained only as `scripts/benchmark/m025-scene-batch-candidate.mjs`.
- WASM call count and gzip delta are both zero.

A later WASM proposal requires new product evidence and a new accepted admission decision; this no-go does not authorize BVH, instance-builder, SIMD, or renderer-thread expansion.
