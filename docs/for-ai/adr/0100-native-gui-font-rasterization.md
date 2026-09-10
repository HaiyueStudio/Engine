# ADR 0100: Injectable GUI font rasterization

Status: proposed implementation for the Native Spider Solitaire integration.

GUI controls remain Engine-owned. Native must not emulate a browser document to
build a font atlas. Add optional `canvasFactory(width, height)` to BuildFontOptions
and GuiFontOptions, and `readAtlasPixels(canvas)` to GuiFontOptions. The latter
returns tightly packed RGBA8 bytes; Engine owns texture allocation, upload and
retirement. Browser defaults retain Canvas 2D and copyExternalImageToTexture.
Callbacks must be synchronous and reusable on device recovery. No NativeScript
imports enter Engine, and no new root or subpath symbols are added.

API review scope: additive options on stable /font and /gui declarations, zero
export-count growth; keep the exact root and existing symbol budgets. This is a
local development candidate, not authorization to publish a 0.1.x release. Stable
publication of these added options requires the reviewed minor release described
in api-stability.md. The package API diff and native packed consumer are validation
artifacts for that review.

The concrete consumer is Native/examples/spider-solitaire. Focused validation
covers a DOM-free font builder, one-time RGBA uploads, and resource cleanup. The
native app exercises ordinary GuiRoot, GuiButton and GuiLabel rendering and input.
