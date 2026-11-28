# 0143: GUI data, forms and content composition

Status: Accepted for the next minor development candidate, 2026-11-27.

Problem: the component plan's P2 data/forms/content layer needs bounded large collections, cancellable async work and application-owned styling without new GUI runtime owners.

Decision: admit focused extensions entries `gui-forms` (11 symbols), `gui-data` (11) and `gui-content` (24), zero symbol reserve and no root/Engine exports. The 18 controllers compose original elements. Table and Timeline use `createGuiVirtualList`; TreeSelect uses `createGuiVirtualTree`; TreeSelect/Cascader and ImagePreview use the shared Popover/Dialog modal protocol. AutoComplete deliberately expands inline so the original input stays editable in its existing focus scope; it does not manufacture a second text host or a modal around an external focused editor.

Form adapters expose caller-owned read/write/subscription/validation. Async validation, suggestions and cascader children use one AbortController per owner and reject late results. Virtual rows retain stable keys and release editing bindings on retirement. Numeric input commits only complete finite text, defers during composition and shares the original editor. Carousel uses the original visible activity lease; image preview borrows image sources. Drag wraps the original drag protocol; resize uses its original routed pointer/cancel events and keyboard/gamepad actions. No document listeners, private Engine imports, replacement layout/scroll engines, GPU caches or independent animation clocks are added.

Skins remain defaults: live semantic theme → application theme resources/parts → explicit child styles. Content slots are borrowed and detached at disposal. State/callbacks and caller async producers remain application-owned; `dispose()` aborts in-flight publication and releases bindings.

Validation: focused lifecycle/IME/latest-wins/keyed recycling tests, public installed consumers (whole entry plus leaf closure), a manifest-backed dark/light native WebGPU gallery, root typecheck/test/build and architecture/API/docs/package gates. Development browser actions are not physical IME/gamepad/iPhone qualification. Package capacity can grow only after deterministic tarball/closure measurements and the duplicate-owner audit recorded in the P2 review. Existing performance, pixel and resource limits stay fixed.

Outcome and measurements: [P2 review](../../../review/gui-p2-20261127.md). This admits new stable capabilities for a subsequent minor; it does not republish 0.2.4 or promote old qualification evidence.

The existing layout adapter also recognizes an explicitly admitted composite row host and arranges its contents after a manual virtual viewport receives its frame. Logical row offsets/content extent stay collection-owned; the original retained-frame layer applies scrolling once. Unadmitted controls continue to own their private children. This private opt-in fixes nested composed rows without adding public layout APIs or another solver.
