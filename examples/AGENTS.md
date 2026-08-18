# Examples instructions

## Purpose and structure

- An example is a minimal executable proof of one engine capability. Prefer the stable high-level `HaiyueEngine` and `engine.createScene()` golden path unless the example explicitly teaches a low-level renderer, pipeline, compute, or resource-lifetime concept.
- Every example is declared in `manifest.json`; the manifest is the source for title, entry, capabilities, assets, screenshot/performance metadata, catalog placement, and `ci` tier.
- Do not maintain a second static CI target list. `smoke`, `full`, and `manual` routing is derived from the manifest.
- Import workspace code through public package exports. An example may use `experimental` only when that instability is part of what it demonstrates.

## Runtime behavior

- Start the render loop before optional heavy asynchronous generation where the example is meant to demonstrate responsiveness.
- Teardown must abort pending work and dispose engines, scenes, controls, GUI handlers, workers, object URLs, readbacks, and device resources. Example switching must not surface unhandled promise rejections.
- UI-only toggles must not retrigger unrelated geometry/compute work. Rapid controls use generation identity/latest-wins when old async results could overwrite new state.
- Do not patch built `bundle.js` files. Edit source and use the target builder.
- Visual examples need deterministic camera/content and explicit diagnostics so browser gates can distinguish unsupported features from rendering regressions.

## Validation

```bash
npm run typecheck -w ./examples
npm run examples:catalog:check
npm run build:target -- example:<id>
```

- Add or run a focused browser verifier for WebGPU correctness, pixel differences, lifecycle, or responsiveness when the example is evidence for a product feature.
- Run `npm run examples:freshness:check` when changing build/catalog infrastructure.

