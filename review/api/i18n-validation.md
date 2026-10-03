# I18n API review and validation

Date: 2026-10-02. Scope: optional `@haiyue/extensions/i18n`, not an npm publication.

## Review

The focused subpath adds 7 values and 12 types. Root exports and existing entrypoint limits remain unchanged.
[Decision](../../docs/for-ai/adr/0115-optional-i18n-runtime.md) · [Export snapshot](i18n-api.json).
No new dependencies; Engine still does not depend on extensions. Runtime has no browser global reads.
Bindings use public GUI setters and AssetManager texture leases. JSON v1 has no executable data.

Important contracts: latest request wins; preload does not commit locale; failed image keeps the prior image;
first-load failure shows fallback text; dispose/AbortSignal releases leases and listeners. GUI detach alone is
not destruction. Image readiness is separate from language readiness. A font repertoire must be supplied for
all required languages; `collectLocaleCharacters` collects known message glyphs, not arbitrary future player input.

## Evidence

- Focused tests: `node --test extensions/test/i18n.test.mjs`.
- Compile-time consumers: `extensions/type-tests/i18n-contract.type-test.ts`.
- Executable GPU GUI: [example](../../examples/i18n/README.md), `?verify=1`.
- The first visual inspection exposed missing CJK glyphs in the default GUI atlas; the example now supplies
  the repertoire from all language packs and language selector labels. String assertions alone were insufficient.
- [Browser result](i18n-browser.json): GPU validation scope clear, console warnings/errors empty, en/zh-CN/zh-Hant artwork and text switch correctly. The final verifier exercises synthetic pointer events through real GUI hit testing, plus rapid switching and plural/parameter updates. CUA OS-level clicks timed out; they are not counted as passed manual click evidence.
- Visual inspection confirmed Simplified Chinese text/title and the English menu; language buttons no longer show missing-glyph question marks.
- Focused runtime tests: 14 passed. Extension source and consumer typechecks passed.
- Repository typecheck, test and build passed. Test counts: shader-language 135, Engine 767, animation-spec 107, extensions 406, example catalog 7; total 1422, zero failures.
- Full build: 95 examples plus shared Engine and source viewer, 97 fresh targets. Workspace/module/Editor boundary checks, API baseline, documentation and catalog checks passed.
- [Package measurement](i18n-package-measurement.json): 16,706 bytes JS, 4,291 bytes gzip for the focused entry, no external runtime imports or added dependencies. Declaration files are packaged through the normal build/pruning pipeline.
- `git diff --check` passed. Existing unrelated framegraph changes were preserved; only the i18n entry was added to the already-modified API baseline.

## Limits

This change does not migrate existing games, implement Rust bindings, publish npm, or claim fresh Native device acceptance.
The schema is portable; availability of Intl and platform font/texture loaders must be verified by Native consumers.
ICU expressions, automatic RTL/shaping/font switching and translation editing remain outside this first implementation.
