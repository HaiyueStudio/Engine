# M2.5 G08 runtime convergence completion

## Decision

G08 is complete. The integrated runtime convergence candidate at revision
`fb4c9878f895f28be00903976368827163245ce3` was validated from a clean working
tree on Windows 10 22H2 with Node.js 24.19.0. No tag, push, publication, formal
performance baseline promotion, or formal pixel/screenshot baseline promotion
was performed.

The integration revisions are:

- `84b573c` — runtime convergence contracts, reviewed API/package closure, owner
  deletion, editor bundle closure, and G07 WASM no-go integration;
- `fb4c987` — bounded Chrome DevTools calls for every browser gate, preventing a
  lost browser response from hanging the release sequence indefinitely.

## Validation

| Command | Result |
| --- | --- |
| `npm run check:fast` | passed on `fb4c987`; all workspace, architecture, API, docs, shader, lifecycle and editor bundle gates passed |
| `npm run check:slow -- --content-tier=smoke` | passed on `fb4c987`; real WebGPU renderer, glTF, AO, reflection, motion blur, PBR, screenshots, editor E2E/memory, 42 examples, 3 games and benchmark completed |
| `npm run release:artifact:check` | passed on `fb4c987`; deterministic public packages and app builds, nested base-path HTTP/Worker smoke, and Windows Electron `app.asar` verification passed |
| `npm run shader-language:stage14:dag` | passed; 25-node browser DAG and dual backend validation passed |
| `node scripts/benchmark/run-scene-batch-wasm-replay.mjs` | passed as a reproducible candidate replay; candidate missed the admission threshold and was rejected |
| `node --test scripts/webgpu-gate/latest-capabilities-gate-policy.test.mjs` | passed; all shared DevTools calls are bounded |

The release artifact audit produced deterministic package metrics matching the
reviewed G08 budget report: engine 549 files and 1,793,911 packed bytes; root
golden-path 47,679 bytes gzip; editor startup closure 21.9 KiB gzip with 10.18%
total gzip headroom. The Electron audit downloaded the locked Electron 43.2.0
runtime, built the Windows x64 unpacked package, and verified exactly one
`app.asar`.

## Decisions and retained boundaries

- Production shaders use the generated Artifact V2 path; compiler/Graph/IR do
  not enter engine or player runtime bundles.
- Render scheduling and renderer ownership follow the final owner matrix in
  [`g08-owner-deletion-matrix.md`](./g08-owner-deletion-matrix.md).
- Async/Worker consumers share the versioned runtime substrate and retain only
  their domain payload validation and diagnostics.
- GUI persistence is `haiyue.gui@1` with unknown-input validation and exact
  paths; compute resource order is explicit.
- The optional SceneBatch/WASM slice is a no-go. Its production runtime and
  exports were removed; only the reproducible benchmark remains.
- API and format decisions are classified in
  [`g08-api-format-review.md`](./g08-api-format-review.md). The reviewed API
  baseline and exact package file-count change are intentional; byte and
  consumer budgets were not widened.
- Held capabilities remain in
  `docs/for-ai/runtime-convergence/deferred-capabilities.md`; this milestone did
  not admit renderer threads, MSDF/Markdown, point-light shadows, WebGL2, or the
  other held product expansions.

## Diagnostics that do not change the decision

Ordinary smoke benchmark output reported several absolute-budget excesses and
no eligible same-run CPU baseline. These are diagnostic under the accepted
portable performance contract and were not promoted as release evidence. The
M02 release decision still requires a clean-revision formal same-host
cross-engine comparison and its separate correctness evidence.

## Handoff

M03 is unlocked only at G01. It must consume the frozen shader, render,
Worker/async, GUI and serialization boundaries documented in
[`g08-m03-handoff.md`](./g08-m03-handoff.md); downstream M03 Goals remain
blocked until their declared dependencies complete.

