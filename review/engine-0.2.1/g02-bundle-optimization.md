# G02 generated artifact size correction

The complete Stage14 gate exposed per-artifact limits not covered by the aggregate WGSL budget: deformation 9,607/9,600 gzip bytes, material-lighting 31,166/15,000, and compute 4,835/4,500. These failures are retained. The existing limits and historical contracts are unchanged.

## Changes

- Generate compact TypeScript metadata literals for these three artifacts. Property names use normal JavaScript identifier syntax where legal; strings, quoted keys and `__proto__` preserve their values. Generated local source aliases are short and deterministic. Metadata values, public artifact constants and provenance stay intact.
- Store the common PBR shader once. The three specialized PBR sources are assembled from slices of that base plus their already-compiled differing lines when the module loads. The build-time generator derives every slice from the complete compiled variants; it fails if the line-preserving specialization precondition changes. This is lossless source storage, not a change to shader semantics or a per-frame operation.
- Keep all complete generated WGSL files for inspection, hashing, source maps and production cost accounting. Variant/pipeline counts, reflection layouts and artifact hashes remain unchanged. Compiler code stays outside Engine runtime.

`shader-source-variant.test.mjs` verifies exact production variant reconstruction including provenance, plus escaping, Unicode, incompatible inputs and compact metadata keys/values. The final built artifacts are also deep-compared with the compiler outputs. Actual GPU compilation and rendering are covered by the complete Stage14 DAG and G02 native fixtures.

Generator cache inputs include both helper modules so changes cannot be hidden by a cache hit. This affects import-time source representation; no startup-time speed claim is made. G05 owns measured performance qualification.

Final byte counts and equality evidence are indexed by [G02 completion validation](g02-completion-validation.json). Metadata and source-dedup changes require fresh runtime fingerprints; older successful native cohorts remain archived separately.


## Final measured sizes

| Runtime artifact | Before gzip | Final gzip | Unchanged cap |
| --- | ---: | ---: | ---: |
| Deformation | 9,607 | 7,983 | 9,600 |
| Material lighting | 31,166 | 12,852 | 15,000 |
| Compute | 4,835 | 4,500 | 4,500 |

Compute has **zero remaining gzip headroom**. Further capability growth must reduce cost or receive an explicit separately attributed budget review; this change does not grant future growth. All three built artifacts deep-equal the full compiler outputs, including WGSL, reflection and source maps, with unchanged hashes. Evidence: `artifacts/engine-0.2.1/g02/compact-deformation-equivalence.json` (contains all three families).
