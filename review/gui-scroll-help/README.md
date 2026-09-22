# Scroll view and help dialog validation

2026-09-22 local development candidate, [ADR 0102](../../docs/for-ai/adr/0102-gui-scroll-view-and-help-dialog.md).

- Added focused `/gui` exports: GuiScrollView, GuiScrollViewOptions, GuiHelpDialog, GuiHelpDialogOptions. Root remains exactly 30; compatibility aggregate unchanged (846 actual source symbols). See [source API delta](api-diff.jsonl).
- `gui-scroll-help.test.mjs`: 9 checks, including clipping, drag vs tap, multi-pointer cancellation, wheel, persistent help, serialization, unfilled outline geometry, unchanged-layout cache reuse, and a completed fast tap queued before the next frame. Existing GUI runtime: 8 checks.
- Engine typecheck/build and 649-test suite passed before the additional cache-reuse test (also passed separately).
- Modules, responsibility boundary, renderer prepare and documentation checks passed.
- Sudoku 315 tests and Native 14 tests passed; new localized atlas check passes (GUI suite 8 tests).
- Browser WebGPU at 390×844: outline circles, persistent English help, close/backdrop dismissal, wheel scroll to Anti-king, clipped header/footer; no warning/error logs.
- Android and iPhone: 41 GUI checks each, including drag on switch without toggling, last rule reachable without pages, help dismissal and retained gameplay/undo. Device artifacts in Native/examples/led-sudoku/evidence/gui-scroll.

Full repository typecheck passed. Full tests passed: shader-language 112, Engine 649, animation-spec 139, extensions 393, catalog 7 (1300 total). Additional GUI tests were run separately after the final input fix.

## Global gate limitations

`api:check` is blocked by pre-existing `@haiyue/ui` entrypoints differing from the capability policy. The source also has an existing GuiFontOptions export not in the saved GUI baseline; this change adds only the four reviewed names and does not promote unrelated baseline drift.

`verify-engine-package` completes packed consumer validation but fails unrelated package policies: animation-spec packed size 130269 > 125000 bytes and non-executable CLI file modes; extensions unpacked size 2657358 > 2500000, animation bundle gzip 224422 > 120000 and state-machine gzip 231644 > 130000. No limits were raised for these failures. Current full output is in artifacts/release/public-packages.json.

A physical Android fast tap exposed deferred input capture after touch release. GuiSystem now skips capture when the latest queued event for that pointer has already ended; Native smoke reproduces this with synchronous down/up before requesting a frame.

Final private input regression: 17 GUI tests passed (9 new + 8 existing); Engine typecheck and final Engine build passed. Full repository build hit the 120-second Engine build timeout under concurrent compilation. The isolated Engine retry completed in 119 seconds with a 300-second process timeout; no build/performance policy files were changed for the retry.
