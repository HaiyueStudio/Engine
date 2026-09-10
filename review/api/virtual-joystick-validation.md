# Virtual joystick validation — 2026-09-10

## Scope

Implemented `@haiyue/extensions/controls` as a local development candidate for the user-requested virtual joystick. One System class and eight public types; extensions root unchanged. API review and capability allocation: [ADR 0101](../../docs/for-ai/adr/0101-virtual-joystick-extension-controls.md). No package publication, Engine core change, Native deployment or release-matrix change.

## Passed

- Repository `npm test`: 1268 tests, zero failures. Shader Language 112; Engine 618; Animation Spec 139; Extensions 392; examples catalog 7. Includes 20 focused joystick tests.
- Repository `npm run typecheck`, plus focused Extensions/source-contract typechecks. Source aliases permit typechecking without prebuilding the new extension entrypoint. Packed declarations are tested independently through the real package export.
- Extensions build and example target build; the repository build also passed with `EXAMPLE_FILTER=virtual-joystick`, compiling all libraries, shared Engine bundle, source viewer and this example. This is not an all-example build. On this busy local host, some earlier default 60-second example builds timed out; the repository build used the supported `EXAMPLE_BUILD_TIMEOUT_MS=180000` environment setting. No repository timeout/budget policy was changed. Final focused example build passed through the shared Rollup runner.
- Six package policy tests; Engine workspace boundaries and internal module-cycle checks passed.
- Local `npm pack` runtime consumer imports `@haiyue/extensions/controls`, moves a real Entity, observes frame state and disposes. Separate strict TypeScript consumer checks the packed readonly frame declaration.
- Native Metal WebGPU Chrome at 430×860 and 960×540: fixed joystick; floating mode selected through actual Engine GUI; exactly one event per engine frame while held stationary; clamped distance; Entity translation and heading; second-finger isolation; stop on release; cancellation; shared GUI ownership cleanup. Zero browser/GPU failures. Both screenshots reviewed.
- In-app browser manual mouse drag changes the rendered player position and heading; floating selection hides the idle stick. Preview uses Engine GUI only.
- Regression coverage includes slightly negative initial RAF intervals and GuiSystem's default scroll-prevention behavior. System updates normalize negative initial intervals to zero; prevented browser defaults do not incorrectly swallow joystick input.

## Environment limits

`npm run api:check`, `npm run docs:check`, and the Editor stage of `npm run check:boundaries` cannot finish because this workspace has no sibling `Editor` repository. The existing scripts were not weakened or given fake inputs. The reviewed baseline update contains only the nine new controls exports, preserving all previous entries. Focused public export/budget/type checks and new documentation links were checked locally. API diff: [virtual-joystick-api.json](./virtual-joystick-api.json).

Browser validation here is local extended macOS evidence, not a claim of formal Windows release admission. No iPhone/Native runtime verification was performed for this new extension. Movement is parent-local and does not solve collisions; event-only mode supports application-owned physics/navigation.

## Evidence

[Evidence index](./virtual-joystick-evidence/README.md) contains final tests, typechecks, build logs, packed-consumer results, blocked-gate diagnostics and screenshots. `build-proof.json` binds source and bundles to SHA-256 and records package size. Browser JSON records actual served file provenance and device/backend identity.
