# M2.5 G02 shader convergence handoff

- Goal / source revision / candidate revision: `g02-shader-single-source-artifact-convergence`; source `1e03ca4`; candidate is the G02 working tree pending its clean commit.
- Changed owners:
  - Artifact V2 schema/type: engine and shader adapter duplicate declarations -> `shader-language/src/adapter/precompiled-artifact-contract.ts`, with deterministic engine declaration generation.
  - Motion Blur artifact: production Artifact V1 writer/runtime compatibility branch -> Artifact V2-only writer and consumer.
  - Production resource reflection: unchecked WGSL/resource metadata pairs -> canonical family definitions plus mandatory WGSL binding/layout parity validation.
  - Production family inventory: implicit Stage history -> `shader-language/production-source-registry.json` with module/version/signature/generator/artifact/resource/target/retention fields.
  - GLSL ES300: open feasibility cost -> private optional canonical-IR portability verifier defined by ADR 0075 and `shader-language/glsl-es300-decision.json`.
  - Cost accounting: exact historical byte equality -> immutable historical snapshot plus current/baseline/delta report and unchanged gzip/global growth budgets.
- Deleted duplicate state machines/files/branches:
  - Deleted the production Motion Blur Artifact V1 writer shape and engine runtime V1 reader/type branch.
  - Deleted independent engine Artifact V2 interfaces; the engine private type file is generated from the shader-language contract.
  - Deleted material-lighting WGSL binding `.replace()` remapping; deformation and PBR skin bindings are explicit source modules.
  - No compatibility reader, compiler, graph parser, or node registry remains in the engine runtime closure.
- Public API / format / package diff: none. `npm run api:check` passed; Artifact V2 remains private.
- Targeted commands and results:
  - `npm run typecheck -w ./shader-language`; `npm test -w ./shader-language` (109 passed at focused run); `npm run shader-language:check`: passed.
  - `npm run typecheck -w ./engine`; `npm test -w ./engine` (506 passed); `npm run build -w ./engine`: passed.
  - `npm run verify:shader-language-stage14`: 25/25 DAG nodes and 140 static contracts passed; Stage 2-14 browser cases passed.
  - `node scripts/verify-engine-package.mjs`: deterministic tarballs, real npm install, browser bundles, Node, TypeScript, exports, CLI and provenance passed.
  - `npm run check:boundaries`; `npm run api:check`: passed.
- Browser/WebGPU/device candidate evidence: Chrome Stage 2-14 real WebGPU suite passed, including deformation, material-lighting, specialized rendering, compute, Motion Blur pixels, GLSL/WGSL parity and zero reported validation failures. This is candidate validation, not M02 formal device evidence.
- Allocation/upload/draw/pass/bundle/startup impact:
  - Production WGSL is 327019 bytes, 64 files, 56 variants and 56 pipelines; all unchanged budgets pass.
  - Historical per-family gzip deltas are Stage 10 `+62`, Stage 11 `+50`, Stage 12 `+25`, Stage 13 `+0`; original gzip limits remain unchanged and pass.
  - Packed root golden path reports no shader artifact in the root closure; focused consumers only retain their declared artifacts.
- Failure injection and lifecycle residual: V1 and reflection drift are rejected before GPU resource allocation; no new long-lived owner was introduced.
- Deferred or blocked items: WebGL2 fallback and production GLSL remain unauthorized; CustomPass, ComputeKernel and WgslFeatureComposer remain explicit non-family escape hatches. Formal M02 device evidence remains external to G02.
- Follow-up required from G08: re-run full repository integration and verify no stable API, package, pixel, performance or bundle baseline was promoted.

## Contract references

- Family/source/target matrix: `shader-language/production-source-registry.json`
- Canonical Artifact V2 contract: `shader-language/src/adapter/precompiled-artifact-contract.ts`
- Generated engine type: `engine/src/shader/PrecompiledShaderArtifact.generated.ts`
- GLSL decision: `docs/for-ai/adr/0075-production-shader-single-source-convergence.md` and `shader-language/glsl-es300-decision.json`
- Cost evidence: `review/m025/g02-shader-cost-diff.json`

Mock, smoke and candidate browser artifacts in this handoff are not formal release evidence.
