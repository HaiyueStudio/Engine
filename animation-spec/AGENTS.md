# Animation specification instructions

## Boundary and format policy

- `@haiyue/animation-spec` is independent of engine, DOM, WebGPU, and editor code. It owns the HYA document model, validation, binary codec, state-machine data, and source adapters.
- HYA is a source-neutral runtime format. Lottie and other authoring formats are converted before delivery; source-specific branches must not enter playback contracts.
- Treat all JSON and binary input as untrusted. Validate byte/count/range/reference/hierarchy/numeric limits before large allocations or runtime object creation.
- Preserve the repository's declared legacy container decoding. New formats need explicit versioning, deterministic encoding, stable error codes, and tests for supported old versions and unknown-version rejection.
- Unsupported or approximated Lottie semantics require an exact diagnostic code and JSON path. Strict mode must fail on fidelity loss; `unclassifiedFailureCount` remains zero.

## Fidelity and corpus

- Do not optimize size or parse time by changing the fidelity population, hiding failed samples, dropping diagnostics, or changing metric definitions.
- Corpus sources, licenses, revisions, hashes, reference frames, feature attribution, HTTP/network phases, parse, and first-frame evidence must stay traceable.
- Keep small and large cohorts separate. A synthetic fixture validates mechanics but cannot replace a real licensed corpus case for capability claims.
- Do not overwrite `corpus/results/latest.json` during exploratory work. Generate a candidate, review fidelity/size/network/parse/first-frame deltas, then promote explicitly.
- `samples/**` should isolate one understandable capability where practical and must be generated reproducibly from source scripts rather than patched as opaque binary blobs.

## Validation

```bash
npm run typecheck -w ./animation-spec
npm test -w ./animation-spec
npm run build -w ./animation-spec
npm run hya:dashboard:offline
```

- Lottie/corpus changes also run the capability generator and the full dashboard when network/browser evidence is in scope.

