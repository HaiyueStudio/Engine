# Stage 8 asset/script runtime review

## Reconstruction status

The original review artifact was lost when the repository was copied from the
previous macOS host without its Git history. This file was reconstructed on
2026-08-15 from source revision
`e9ddeb7962624ccb86cfc6ad263b0ad72f21419b`.

This is a source-contract review and an evidence tombstone. It does not restore,
estimate, or promote the original CPU, GPU, latency, throughput, memory, pixel,
or browser measurements. Any formal performance result mentioned by historical
material must be collected again from a clean frozen revision and its required
registered runner.

## Reviewed source contract

- Asset jobs own priority, progress, timeout, cancellation, generation identity,
  and late-result disposal.
- Network, parsed CPU, and per-device GPU caches have separate budgets and
  lifecycle release paths.
- KTX2 uploads are frame-budgeted and can be split by mip, layer, and block row.
- glTF/Draco, KTX2, and Spine main/worker paths share their production parsers;
  content errors retain their structured code and path.
- Project scripts use the `read`, `scene`, `asset`, `input`, `physics`, and
  `debug` capability groups driven by one runtime contract.
- The supported trusted-project entry point is `enableTrustedProject()`.
  Removed flat script APIs and the former trusted-eval naming are not retained.
- Script listeners, timers, and custom disposers are owned by
  `ScriptExecutionScope`; hot reload, removal, and destruction dispose the old
  scope before replacement.

## Current validation

The reconstructed contract is checked by `npm run asset-script:check`, the
Engine asset/script lifecycle tests, the Extensions parser contract tests, and
the benchmark policy. Passing those structural checks does not make this file a
formal performance baseline.
