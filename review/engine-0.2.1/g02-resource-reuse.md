# G02 dynamic-light resource reuse

Status: implementation and focused regression tests passed; final G02 acceptance is tracked separately. No resource-count budget was changed.

## Captured failure

The sixth independent AMD full-reference launch reproduced the dynamic-light assertion: bind groups **67 → 68**, with buffers **429 → 429** and pipelines **27 → 27**. The added group was `DeferredReference.pass` at frame 323. Both underlying light buffers retained their identity, but source offset changed **0 → 66304** and view-header offset **0 → 4352** (view indices **256 → 4608**). The binding cache correctly treats different buffer ranges as different bindings.

The raw failure is retained in `artifacts/engine-0.2.1/g02/reuse-failure-before.log` and the recovered diagnostics in `reuse-failure-before.json`. That capture predates structured runner failure output; it does not independently retain browser identity. Its runtime/harness fingerprints were stable across the six-launch diagnostic series. The original log is retained rather than presenting recovered metadata as a fully structured capture.

## Cause and change

`DeferredImmutableBufferArena` kept each record slot occupied until the GPU-completion promise settled. A subsequent changed light snapshot could select a second slot despite the earlier command already being submitted. This made binding offsets depend on completion-notification timing and created another bind group.

Record reuse and buffer destruction now have different boundaries:

- **Unsubmitted encoders:** retain immutable record slots. Multiple encoders referencing one snapshot all have to submit before that slot can be overwritten.
- **Submitted commands:** release the record slot through the existing `afterSubmit` hook. A later `queue.writeBuffer` is ordered after earlier submitted reads on the same queue.
- **Buffer retirement:** still waits for actual GPU completion for every referencing encoder. Growth, out-of-order submission, cancellation/device loss and owner teardown retain their existing protection.

This does not assume out-of-order `onSubmittedWorkDone()` promise settlement. Current WebGPU specifies ordering for consecutive completion promises; this change removes completion notification as a prerequisite for record reuse. See the [WebGPU queue timeline](https://gpuweb.github.io/gpuweb/#queue-timeline) and [promise ordering](https://gpuweb.github.io/gpuweb/#promise-ordering).

No new synchronization wait, resource allocation, draw, or public API was introduced.

## Regression coverage

Two audit-device tests in `engine/test/deferred-light-gpu-table.test.mjs` cover:

1. Twelve submissions with completion callbacks intentionally held: buffer identity and offset stay constant, while destruction still waits. Before the fix this failed deterministically with `66304 !== 0`.
2. Two encoders sharing one record: submitting one cannot release the slot still used by the other. After both submit, the slot can be reused even with completion callbacks held.

The native `deferred-submission-fixture.mjs` additionally performs 32 write/copy/submit iterations with no intermediate await. It checks the same binding each time, requests destruction before readback, then verifies all 128 distinct copied words. This checks actual queue ordering rather than relying only on a mock.

The full native fixture still requires eight stationary and eight dynamic-light frames with unchanged buffers/bind groups/pipelines. Source uploads must increase by seven during eight dynamic frames (the first intensity assignment is unchanged), proving updates were not skipped. Newly created bind groups must be an explicitly present empty list. Policy tests reject missing or shortened coverage, extra resources, and suppressed uploads.

The standalone ordering probe runs before the renderer audit is installed. Its 32 writes are outside the renderer workload. Two initial harness runs incorrectly mixed these writes into renderer classification totals; their failed archives are retained and are not reported as production GPU failures.

## Evidence retention

The runner now archives every structured passed/failed result with timestamp, source/harness hashes and browser identity, before validating it. A failed run cannot overwrite the latest passed alias. Four-view output failures remain independent of this fix and must pass their own acceptance; see [four-view investigation](g02-four-view-investigation.md).


## Final native result

The frozen candidate passed six independent AMD and three Intel full-reference launches, each with bind groups 67→67, buffers/pipelines unchanged, uploads 1→8, an empty newly-created-group list, and all 128 ordering readback words correct. Exact source hashes, per-run counters and zero-resource cleanup are in [the final native index](g02-final-native-validation.json).
