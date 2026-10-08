# Share content API review

Date: 2026-10-08. Source implementation; no package publishing.

Five values and eleven types belong exclusively to `@haiyue/extensions/share-content`.
No root aggregation, Native import, platform SDK or new dependency.
[Decision](../../docs/for-ai/adr/0118-share-content-composition.md) · [Guide](../../docs/engine-guide/share-content.md).

The output is structurally compatible with the Native share payload; type tests cover that boundary without
creating a workspace dependency. Canvas2D card composition is one-shot. Image sources are borrowed;
output surfaces are owned/reset; cancellation suppresses late results. Challenge links are unsigned data,
validated against host-supplied origin/game/rules policy, never automatic navigation or reward evidence.

Focused tests cover capture timing, encoding fallback/failure, abort/late callbacks, owned/borrowed surfaces,
layout overflow, i18n snapshot consistency, image crop modes and versioned challenge round trips/rejection.
Measured validation on 2026-10-08:

- Repository `npm run typecheck`, `npm test` and `npm run build`: passed. All 1,457 tests passed,
  including 13 focused share-content tests (also covering hosts without an Intl global). The complete build produced 99 fresh targets for 97 examples;
  `npm run freshness:check -w ./examples` confirmed every target matches its source.
- `npm run api:check`, `npm run docs:check`, `npm run check:boundaries` and `git diff --check`: passed.
- [Browser evidence](share-content-browser.json): real WebGPU GUI capture, PNG decoding, Chinese/English
  landscape and portrait cards, challenge-link round trip, and GPU validation all passed. Each of five
  source captures contained 15,764 bright digit pixels, ruling out a blank captured board. The four card
  variants have distinct SHA-256 hashes. No browser warnings or errors were reported.
- [Package measurement](share-content-package-measurement.json): standalone entry 16,025 bytes,
  gzip 5,120 bytes; no runtime imports or new dependencies. Root exports are unchanged.
- Interactive example: `examples/share-content/index.html`; append `?verify=1` to run the browser checks.

Device follow-up: the Native repository's independent `org.haiyue.nativevalidation` host exercised actual
GPU readback before presentation, Canvas2D composition, four locale/layout outputs and challenge parsing
on iPhone 15 Plus and Android X4000. Host requirements found during acceptance: supply Intl locale
canonicalization for NativeScript V8, supply reason/throwIfAborted on its legacy AbortSignal, and keep
embedded Canvas layout dimensions in a fixed parent with the canvas filling it. Engine itself adds no
Native dependency. Native's `bridge/share/evidence/device-content-2026-10-08.json` records exact system
sheet outcomes and limitations separately; a capability check alone is not UI acceptance.

Challenge URLs contain unsigned game parameters; they are not trusted score/reward records and do not
register OS deep links.
