# Narrative API review and validation

Date: 2026-10-03. Optional `@haiyue/extensions/narrative`; this change does not publish npm.

## API review

Four values and fifteen types (19 symbols) cover portable graph data, runtime, GPU GUI and an allowlisted host-action adapter.
No root aggregation or new dependencies. Engine imports use public GUI types/classes; i18n is reused within extensions.
[ADR](../../docs/for-ai/adr/0116-optional-narrative-runtime.md) · [Export snapshot](narrative-api.json).

Saved effects are not replayed. Pending external actions are explicitly replayable with durable token identity and new
acknowledgement IDs; hosts must durably deduplicate side effects. Reentrant mutations reject; observer exceptions occur
after commit. Storage migration, video/timed-choice/editor features and Native device validation remain outside this change.

## Validation

Focused tests: **16 passed**. Coverage includes three paths/two endings, guarded options, transaction rollback,
cycles, save validation, action deduplication/retry/cancellation, stale callbacks, GUI ownership, image lease
release and conservative Chinese line wrapping.

Repository `npm run typecheck` and `npm test` passed in an isolated source snapshot at
`/tmp/haiyue-narrative-validation-20261003`. Tests: shader-language 135, engine 770, animation-spec 107,
extensions 422, example catalog 7; **1,441 passed, zero failed or skipped**. The narrative source, tests,
type contracts and example sources were compared with the working directory and match.

Repository `npm run build` also passed in that snapshot: all five workspaces built, including **96 examples /
98 fresh targets**, fingerprint `96f9edf1e70f`. `npm run freshness:check -w ./examples` confirmed all 98 targets
match that source fingerprint.

The shared working directory had two transient missing Engine declaration failures while generated `dist`
outputs were being rebuilt. Standalone resolution passed afterward. The isolated snapshot uses local workspace
links and separate generated outputs to avoid that interference; installed third-party dependencies are shared.
Cold validation first builds shader-language and extensions, since existing ray-tracing example imports require
extension declarations before the root typecheck. No source workaround was introduced for that prerequisite.

`npm run api:check`, `npm run docs:check`, `npm run check:boundaries`, focused extension/example builds and
`git diff --check` passed in the working directory. Consumer type tests cover the public narrative/i18n contracts.

Browser verification passed in the in-app browser with WebGPU: actual Engine GUI pointer hit testing traversed
three branches and two endings, returned a battle result through the host adapter, restored a pending action
with a stable durable token and a new acknowledgement ID, and confirmed completed effects were not replayed.
Chinese/English text and artwork bindings render correctly; the Chinese initial dialogue wraps without clipping.
GPU validation and browser warning/error logs were empty. This is browser acceptance, not Native device acceptance.
See [machine-readable browser evidence](narrative-browser.json).

The optional entry and its local shared chunk total **31,623 bytes**, **8,265 bytes gzip** (sum of individually
compressed files), excluding the existing external Engine GUI dependency. No new dependencies or root exports.
See [package measurement and hashes](narrative-package-measurement.json).
