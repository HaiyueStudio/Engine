# Optional achievements review · 2026-10-13

Development source review, not an npm publication or platform-account qualification. Public entry `@haiyue/extensions/achievements` exports two values and eleven types; root exports remain unchanged. [API snapshot](../api/achievements-api.json), [guide](../../docs/engine-guide/achievements.md), [ADR](../../docs/for-ai/adr/0121-optional-achievements-runtime.md).

Focused runtime tests cover immutable catalogs, atomic save/dedupe, duplicate and parallel facts, write failure, failed report/restart, monotonic checkpoints, migration, bounded queue, late completion/disposal, hidden GUI content, locale changes and no duplicate toast. The full repository typecheck/test/build also passed, including 100 manifest build targets; [validation summary](validation.json) binds the results to source identities. Boundaries/API/docs checks passed.

[Chrome WebGPU result](browser.json) and [screenshot](browser.png) use the native Metal backend. The fixture verifies local values, duplicate suppression, English locale and four rows, audits console/GPU errors, then navigates away and closes the browser. The screenshot was visually inspected after fixing the language toggle's missing Chinese font characters. This is a correctness/cleanup smoke test, not a performance benchmark.

The real Native packaged facade and extension were extracted into an isolated consumer and directly typechecked/assembled; there is no Native import in the extension. Steam/Game Center integration and mobile/desktop acceptance live in Native's P1 evidence; absent platform accounts are not replaced by mock results.

The 0.2.1 public-package gate adds a focused `AchievementRuntime` consumer through
`@haiyue/extensions/achievements`. The workspace-dist measurement is 2,924 bytes gzip;
its new 3,500-byte ceiling provides about 20% bounded growth room. GUI, glTF and the
achievement presentation runtime must remain absent. Actual tarball installation,
all declaration roots and the existing package ceilings remain independently required.
