# G02 four-view empty output investigation

Status: **arithmetic output vertex plus explicit destination state validated on the tested native adapters**. The explicit-state-only attempt recurred and is superseded. Final evidence is in [the source-bound native validation index](g02-final-native-validation.json). These are dirty-worktree correctness diagnostics, not release or performance qualification. Earlier successful cohorts and failures below remain historical.

## Reproduction and localization

On 2026-09-25, twelve independent AMD full-reference runs produced seven passes, four empty-output failures, and one separate dynamic-resource-reuse failure. The empty-output failures occurred at frame 168, frame 1, the initial frame, and frame 1. A passing retry does not resolve these failures.

The captured frame-168 failure had these results:

- View 1 was `[0, 0, 0, 0]`; views 0, 2, and 3 were `[11, 17, 29, 255]`.
- Re-reading the unchanged targets serially returned the same pixels.
- All four G-buffers contained the expected receiver surface.
- The final view's HDR center contained the expected radiance and alpha 1.
- The validation error scope contained no error.

The later failures also copied each complete output texture. All 4,096 pixels in each affected output had zero alpha. This rules out a single-pixel edge discrepancy. The shared HDR surface only preserves the last view, so these observations do not establish the intermediate HDR contents of an earlier failing view.

The strengthened `deferred-view-fixture.mjs` now records per-view G-buffer references, serial output re-reads, whole-output transparency counts, last-view HDR/depth, and the error scope for both initial-frame and later failures. It retains the original 576-frame/nine-profile-activation checks and source-upload assertions.

## Renderer-independent experiments

A small program with no Engine imports reproduced the same transparent output using only a cleared RGBA16F source, the generated SceneOutput shader, four BGRA8 outputs, and native WebGPU commands. The first captured failure occurred at frame 0, with views 1–3 empty. Separate variants with fresh/cached texture views and only one source clear per frame also failed. This establishes that the symptom does not require Deferred light tables, scene collection, or Engine resource retirement. It does **not** identify a particular Chromium, Dawn, Metal, or driver defect.

The behavior remains intermittent:

| Experiment | Observation |
| --- | --- |
| Four clear-only targets and parallel pixel readback | 3,000 frames passed |
| Original shared-HDR output program | Failed at frame 0; later 3,000-frame repeat passed |
| Same-frame original/arithmetic/fragment-position/constant shader comparison | All four variants passed 1,000 frames |
| Same-frame shared/isolated HDR and shared/distinct texture-view comparison | All four variants passed 1,000 frames |
| Magenta clear sentinel, 16 fresh browser launches | All 16 × 64 frames passed |

At that stage there was no demonstrated basis for replacing the fullscreen shader, allocating an HDR texture per view, serializing rendering, or weakening pixel assertions.

## Repeatable probe

The repository source for the next diagnostic run is renderer-independent and loads the generated output shader with a verified SHA-256:

```sh
node scripts/webgpu-gate/run-multiview-output-probe.mjs
node scripts/webgpu-gate/run-multiview-output-probe.mjs --integrated
```

It checks 512 frames each of clear-only, shared-HDR, and isolated-HDR output. Draw cases use a magenta clear sentinel: a magenta failure means the draw did not cover the pixel; transparent black would mean the draw or subsequent storage produced zero. The runner retains failed structured results, browser/adapter identity, HTTP provenance, and source hashes. Passing this diagnostic alone does not close the original issue.

Local ignored evidence is under `artifacts/engine-0.2.1/g02/`:

- `four-view-failure.json`: frame-168 failure with the runtime/harness fingerprints captured before subsequent harness changes.
- `four-view-reproduction-series.json`: all four failures and the separate resource-reuse failure; the series itself is not formal source-bound acceptance evidence.
- `output-variants-results.json`, `output-ab-results.json`, `output-comparison-results.json`, `output-hdr-comparison-results.json`, `output-sentinel-results.json`: diagnostic comparisons, including negative results.
- `output-probe-high-performance.json` and `output-probe-low-power.json`: current standalone probe captures.

## Follow-up scope

1. The continuation below establishes a repeatable original-fails/changed-passes comparison and validates the selected Engine change. Exact native-backend root cause remains unproven; other devices/backends need their own qualification.
2. Independently investigate the dynamic-resource-reuse assertion: one run created 68 bind groups versus its baseline of 67, with buffer/pipeline counts unchanged. This occurred before the four-view check and was not skipped or accepted.

## Sentinel and cold-start comparisons (2026-09-25 continuation)

The original output shader now reproduced whole-target magenta sentinel failures in both shared-HDR and isolated-HDR modes. Serial re-reads agree. A complete 64×64 copy contains 4,096 magenta pixels, zero expected pixels, and zero transparent pixels in the affected target; the other three targets contain 4,096 expected pixels each. The output clear executed but the draw did not replace any sentinel texels. No WebGPU validation error was reported. This establishes missing output coverage, rather than a center-pixel tolerance issue or a transparent source sample, and rules out shared-HDR reuse as a necessary condition.

The probe can select `--variant=original|explicit-state|arithmetic-vertex|vertex-buffer` and `--frames=N` (default 512). Alternatives retain the production fragment stage. `explicit-state` sets full-target viewport and scissor; `arithmetic-vertex` computes the same three vertices without indexed local arrays; `vertex-buffer` supplies the same positions/UVs from a buffer. Each independent launch retains all three clear/shared/isolated cases. The runner archives successful and failed results with exact input hashes, so later captures cannot erase earlier results.

Two early 4,096-frame diagnostic setup runs (`explicit-state` and `vertex-buffer`) had a JavaScript reference error in the probe. That error was corrected before the comparison series; those runs are not GPU findings. The early `arithmetic-vertex` run timed out in isolated-HDR at 2,226/4,096 after completing the first two cases. It is incomplete evidence, not a pass. The timeout is unchanged; subsequent cold-start comparisons use the documented 512 frames per case.

### Controlled comparison and selected change

Three interleaved rounds (12 fresh browser launches, 512 frames per case) produced:

| Output variant | Passed launches | Failed launches |
| --- | ---: | ---: |
| Original | 0 | 3 |
| Explicit viewport and scissor | 3 | 0 |
| Arithmetic fullscreen vertices | 3 | 0 |
| Vertex buffer | 3 | 0 |

The original failed in shared-HDR frame 24, isolated-HDR frame 59, and shared-HDR frame 137. All three retained the whole-target magenta sentinel and had no validation errors. The archive index is `artifacts/engine-0.2.1/g02/output-probe-cold-start-series.json`; it identifies each immutable source-bound capture and its SHA-256. These runs distinguish the alternatives from the original but do not identify which native compiler/driver/render-state mechanism caused the missing coverage.

`SceneOutputPass.apply()` now explicitly establishes full-target viewport and scissor when the view does not supply them. It uses the destination target dimensions, preserving scaled output; explicit local viewport/scissor values are unchanged. The fallback private invocation without a view keeps the existing behavior because a bare `GPUTextureView` does not expose destination dimensions. Normal renderer output supplies a view.

This is the smallest selected compatibility change: at most two state-setting commands per output pass, with no extra draws, passes, buffers, textures, uploads, submissions, waits, shader variants, or public API changes. Tests cover returning from an offset/clipped view to a larger destination than the source, for both 1× and 4× MSAA. No measured CPU/GPU performance improvement is claimed.

### Complete Engine validation

The selected runtime passed five independent full AMD RDNA-1 runs and three full Intel Gen-9 runs on native Chrome/Metal. Each run retains all light/material/projection/indirect/resource-reuse cases and checks 576 four-view frames with nine profile activations. Total: 4,608 four-view frames, 18,432 checked view outputs, 72 profile activations. Every run preserved one source upload per profile, reported zero WebGPU validation errors, and cleaned up all tracked resources.

[Source-bound validation index](g02-four-view-validation.json) retains all eight runtime/harness fingerprints, capture paths and hashes. This supports keeping the compatibility change on the tested configurations. It does not prove a particular Chromium/Dawn/Metal/driver defect, qualify other backends, or close the separate historical dynamic-resource-reuse failure. G02 remains active for that remaining item and the later release/performance gates.

### Final repository checks

- Root typecheck and all 1,334 tests passed (119 Shader Language, 709 Engine, 107 animation-spec, 392 extensions, 7 catalog).
- Focused SceneOutput tests: 12 passed. Policy suite: 126 passed. Module/responsibility/prepare, public API and docs checks passed.
- Existing SceneOutput native pixel regression: 17 cases passed, zero validation errors. Its fingerprint still matches the final built runtime.
- Final standalone explicit-state probe: AMD and Intel each passed all three × 512-frame cases with the final validator/archive runner.
- Default full build passed all 93 examples plus shared Engine/source viewer; all 95 outputs match source fingerprint prefix `ef3395be3b40`. No timeout override was used.
- Logs and checksums are indexed in [validation evidence](g02-four-view-validation.json). No public API/version or frozen G01 performance budget changed.


## Recurrence and arithmetic output vertex (2026-09-26)

After the independent record-slot reuse fix, AMD full runs 1–2 passed and run 3 failed at four-view frame 1: view 2 was entirely transparent and serial reread agreed. Capture: `reference-high-performance-failed-2026-09-25T14-53-32.311Z.json`. Explicit viewport/scissor alone is therefore insufficient. The resource reuse checks had already passed in this run.

An output-only shader substitution then passed five complete AMD runs. Its sixth launch timed out at “Rendering 8 lights”; it is incomplete, not a pass, and the log is retained. This experiment changes only `GeneratedShader.output`, not the Deferred resolve, fragment stage or resources.

The production candidate computes the same fullscreen positions/UVs arithmetically without indexed function-local arrays. Only `output` changes; the other fourteen generated postprocess passes are hash-checked unchanged. The fragment stage and binding ABI are unchanged. Shader Language owns the source, and the generator regenerates the output and artifact hashes. `output-vertex-compatibility-contract.json` chains the historical HDR contract rather than rewriting its hash. Explicit destination viewport/scissor remains in place. Total generated WGSL decreases by 151 bytes to 397,427; no variant/pipeline or resource count is added.

The low-level browser/driver cause remains unproven. Final independent production runs are required before accepting this compatibility mitigation on the tested native adapters.


### Final production evidence

The final generated production shader passed six independent AMD and three Intel full-reference launches: 5,184 four-view frames and 81 profile activations, with no missing output, GPU validation errors or tracked resources after cleanup. Every launch also passed dynamic bind-group reuse (67→67), light uploads (1→8), and all 32-submission/128-word ordering checks. Two additional standalone production-shader probes each completed 512 clear-only + 512 shared-HDR + 512 isolated-HDR frames. The probe option `original` means the current generated production source (now arithmetic vertex generation), not the historical indexed-array shader.

Both adapters also passed final 1280×720 room captures for 128/256 sparse and overlapping lights. HDR and all three G-buffer screenshot panels were inspected. These final captures share runtime fingerprint `0beca3099d61ccdbfdd5654c69d612765eb56350ccbe935bc1d90bf7ff26f0d9`. See [native validation](g02-final-native-validation.json) for every capture hash, device identity, resource counters and candidate manifest. This accepts the compatibility mitigation for the tested configuration; it does not assert a proven low-level driver cause or universal device reliability.
