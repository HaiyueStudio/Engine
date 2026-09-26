# G02 implementation progress

Status: complete, 2026-09-26. See the [completion audit](g02-completion-audit.md) and [final validation](g02-completion-validation.json). G03 is ready, not active. This is development correctness acceptance, not release or performance qualification. G01 remains frozen; its historical runtime hash is not expected to match this implementation.

## Implemented so far

- Private, lazy Deferred reference profile/provider. No package exports or versions changed.
- Untruncated World source extraction; ABI v1 descriptor generates CPU writers, WGSL and reflection. Separate source/view lists; stable u32 IDs, generation validation, explicit capacities and conserved counts.
- Submission-protected immutable GPU records using FrameRingResource; stable source upload reuse; shared transient pool MRT attachment allocation and safe retirement. Growth now tracks every referencing encoder, including out-of-order submission; device loss can abandon already-retired pending generations.
- MRT capacity guards enforce four live view scopes and two live target generations per scope. A view falling back retires only its own attachments; a supplied view family prunes unused scopes.
- Shared Forward/Deferred standard PBR surface sampling; generated 3×rgba16float G-buffer and full-list HDR resolve using existing BRDF, shadow/environment bindings and fog. Existing Render3D output and frame graph remain owners.
- Explicit strict/Forward failure policy. G02 currently rejects non-standard/transparent/helper surfaces; G04 owns those compatibility paths.
- Device-limit, MSAA, cancellation, source/view ABI, World extraction and resource lifecycle tests.
- Approved private per-vertex normalized linear RGBA port, with copied input, finite/range/count validation and geometry version invalidation. Forward/Deferred multiply interpolated color by material/base texture; depth, shadow, normal, motion and outline use the same vertex-alpha coverage. UV1/RGBA interleaving keeps eight vertex buffer slots. No importer/editor or public API was added.
- Native reactivation fix: cache immutable module compilation checks once. Repeated `getCompilationInfo()` on the same cached G-buffer module stalled on the tested Chrome/Metal path. Cancellation now rejects even if a native async diagnostic never resolves; Render3D owner destruction abandons pending work before removing its provider.

## Initial G02 evidence (historical)

- Current full repository `npm test` passed 1,331 tests: Shader Language 118, Engine 707, animation-spec 107, extensions 392, catalog 7. Vertex/color-cache and resource lifecycle focus passed 25 tests; fixture policy passed four tests.
- Repository typecheck, module boundaries, responsibility boundaries, renderer prepare contract and public API check passed.
- Built-runtime legacy regressions also passed: 17 scene-output cases (including PBR/Toon/HDR) and 17 auxiliary-surface pixel cases, with zero WebGPU validation errors. Showcase canonical artifact generation matches its source.
- Independent character-material browser verification passed all five deformation/silhouette passes. Lab PBR/character sub-results have zero compilation/validation errors, but the overall Lab check failed its unchanged standalone WGSL/GLSL pixel parity (maximum 190 > 2; mean 0.01630). Evidence: `artifacts/engine-0.2.1/g02/{character-material,lab-failure}.json`.
- AMD RDNA-1 and Intel Gen-9 actual WebGPU: named 0/1/8/9/32/128/256 counts, 256 individual contributions, linear HDR sum, 0/1/8 Forward parity, emissive-once, alpha-mask, last-light intensity/range updates passed at intermediate source state.
- Both adapters rendered the fixed 1280×720 room with 256 boxes and 128/256 sparse/overlapping lights. HDR and three G-buffer screenshots are in `artifacts/engine-0.2.1/g02/room-{high-performance,low-power}.png`; AMD screenshot inspected.
- Extended material cases passed on both adapters: UV0/1, texture transform, clamp/repeat samplers, normal mapping (AMD 0.01674° error), metallic/roughness/occlusion/emissive textures, texture alpha mask, clipping updates, double-sided rendering, environment/ambient exactly once, last-light color/remove/add and distinct stable IDs.
- Both adapters passed eight perspective/orthographic × standard/reverse depth × default/remapped depth combinations, fixed camera jitter reconstruction, actual GPU-driven indirect bundle execution, eight stationary and eight dynamic-light frames without new buffers/bind groups/pipelines, and four separate view outputs sharing one source upload.
- Runtime build manifests and before/after source/harness fingerprints now reject stale or concurrently changed evidence. Final captures enforce zero owner residual and zero live tracked GPU resources after cleanup.
- The four-view empty output reproduced again during the vertex-color run (frame 5, zero versus expected channel value 11). The fixture now reports the GPU error scope at that boundary and compares all four targets across 576 frames (512 continuous frames plus eight profile reactivations with eight frames each), with G-buffer/HDR/error-scope diagnostics on mismatch. Subsequent AMD and Intel 576-frame/nine-activation runs passed, but the isolated failure has no established root cause and remains an open reliability item; successful retries do not erase it.
- Evidence is dirty-worktree diagnostic evidence. It does not confer G05 performance or G07 release qualification.

## Initial gate results (historical)

The existing shader cost gate fails honestly: 397,578 generated WGSL bytes versus 363,464 allowed; 69 files versus 67; 61 variants/pipelines versus 59. Deferred contributes two passes and 33,068 WGSL bytes. Vertex-color coverage adds 1,810 generated bytes relative to the preceding G02 candidate, without adding static passes. Existing budgets and historical contracts are unchanged. `shader-language/deferred-lighting-extension-contract.json` records exact new artifact hashes/costs and links the previous HDR material hash. G07 cost admission or implementation reduction remains required; generation consistency does not imply budget approval.

Earlier packed consumer Node/TypeScript/all-exports/CLI checks passed; they are historical, not a release acceptance of this candidate. Package count admission failed: Engine 614 files versus 609 allowed (current `npm pack --dry-run`). No budget or export was changed to hide this. The current 139 built Engine JS files contain no Deferred G-buffer/resolve shader; the private factory is still absent from public exports.

Current full `npm run build` did not pass: all runtime workspaces built, then `physics3d-joints` exceeded the default 60-second process timeout after 22 completed examples. The previous `hya-lottie-corpus-dashboard` timeout did not recur (34.2 seconds this run). The unbuilt remainder of the 93-example full build is not qualified. The independent `physics3d-joints` retry passed at 44.1 seconds under the default timeout. The focused material-example build first timed out rebuilding the shared Engine bundle; a local diagnostic retry with the existing `EXAMPLE_BUILD_TIMEOUT_MS=120000` override produced all three requested targets (shared Engine 52.3s, Lab 83.3s, character 58.3s). This does not turn the default full-build gate green.

## Resolved follow-ups (2026-09-25)

- Shader/package budgets were explicitly approved and applied with attribution, unchanged byte/consumer limits, and complete package verification: [budget review](g02-budget-review.md).
- The default full build now passes all 93 examples plus shared Engine/source viewer (95 fresh targets), without increasing the 60-second limit. Lab uses matched linear filtering and passes the original pixel limits across the default and four additional sampling cases: [build/Lab fixes](g02-build-lab-fixes.md). Initial failures above remain historical evidence.

- Four-view output now has a native-validated compatibility fix: establish the destination viewport/scissor explicitly. The original failed three interleaved probe runs; the changed state passed three, followed by five AMD and three Intel full Engine runs (4,608 four-view frames). See [four-view investigation](g02-four-view-investigation.md) and [validation index](g02-four-view-validation.json). Native backend root cause remains unproven.

## Outstanding at the earlier checkpoint (historical)

- The intermittent dynamic-light bind-group reuse assertion remains open. G07 public Deferred package/API and release qualification remain pending.
- Retain the ABI/lifecycle audit evidence: view/generation bounds, out-of-order submission, pending-resource loss, cancellation and teardown cases passed in the full Engine suite. Further G03 handoff remains gated by the unresolved correctness/reliability items.
- The source-bound validation report is current; keep G02 active and postpone G03 handoff until all done conditions have evidence.

On 2026-09-25 the user approved minimal per-vertex RGBA support: standard PBR Forward/Deferred and consistent alpha coverage, with tests. Model import and editing tools remain outside this scope; public API review remains G07. The private port uses normalized linear RGBA and interleaves it with UV1 in a 24-byte stream, retaining the existing eight-buffer hardware requirement. Native pixel validation passed on AMD RDNA-1 and Intel Gen-9: interpolated base/texture products, 4,096-pixel opaque/mask Forward parity, white fallback after color removal, and morph/skin coverage across motion MRT, normal/depth MRT, standalone depth, outline and shadow. Both report zero tracked resources after cleanup.

### Vertex-color implementation cost

The current shared geometry cache stores a 24-byte UV1/RGBA stream per vertex: 16 additional bytes when UV1 previously existed, or 24 when UV1 previously fell back to UV0. Color updates use the existing geometry version/rebuild path; unchanged frames/views do not upload again. This is correctness evidence, not a G05 memory/upload-performance acceptance.

## Four-view investigation update (2026-09-25)

The four-view failure is now localized to the output path and also reproduces in a renderer-independent native WebGPU program. The harness retains first-frame and later per-view G-buffer/readback/whole-target diagnostics. A standalone source-bound output probe was added. The continuation applies explicit output viewport/scissor state after controlled before/after comparisons and eight successful full Engine runs. A separate intermittent dynamic-light bind-group reuse assertion remains open. Detailed observations and limitations are in [g02-four-view-investigation.md](g02-four-view-investigation.md).


## Closing continuation (historical checkpoint, 2026-09-26)

The 67→68 issue has a deterministic regression and a slot-lifetime fix, with GPU buffer retirement still waiting for completion: [resource reuse](g02-resource-reuse.md). The explicit viewport/scissor mitigation subsequently failed again; arithmetic output vertex generation is undergoing final source-bound native validation. G02 remains active until that validation and the closing checks pass. Earlier “mitigated” statements describe historical cohorts only. A [G03 handoff](g03-handoff.md) is prepared; G03 is not activated.


## Frozen candidate verification

The final source-bound native cohort passes all nine full-reference launches (six AMD, three Intel), 5,184 four-view frames, 81 profile activations, 32-submission ordering per run, dynamic bind groups 67→67, and both 720p room captures. The final artifact metadata/source storage is losslessly compacted, with exact compiled/runtime equality; see [bundle correction](g02-bundle-optimization.md) and [native validation](g02-final-native-validation.json). The final serial repository, complete Stage14 DAG, SceneOutput, Lab and character checks passed; G02 is complete. Current results and retained failures are recorded by the [completion audit](g02-completion-audit.md) and [validation index](g02-completion-validation.json).
