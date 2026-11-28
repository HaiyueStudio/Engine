# ADR 0144: Optional specialized GUI components

Status: accepted for next-minor development, 2026-11-28. The user requested all fourteen P3 specialties from the [GUI plan](../../../review/gui-component-visual-plan-20261126.md); this supersedes the plan's earlier demand-based deferral for this batch. It does not change published 0.2.4 packages.

## Decision

Admit four focused Extensions entries with zero symbol reserve: `gui-pickers` 4, `gui-assets` 9, `gui-composition` 15 and `gui-assistive` 13. No Engine or root exports. Keep the original editor, input domain, virtual collections, scroll viewport, layout solver, overlay focus stack, image renderer and visible activity clock authoritative.

DatePicker represents an ISO calendar date without a timezone; TimePicker represents wall-clock HH:mm[:ss]. File picking/transport, QR encoding/rasterization, virtual pointer dispatch and application history are explicit caller-owned ports. No implicit fetch, document picker, QR dependency, native backend, extra event sampler or second command-history implementation is installed.

Masonry assigns items to columns but lowers geometry to the existing shared flex layout. Anchor/Affix consume the original viewport's events and scroll coordinates. Tour uses the original Popover and exposes `refresh()` to the application's existing layout/frame owner. Watermark does not intercept input. BorderBeam borrows content and the original visibility/reduced-motion-aware activity lease. Mentions composes AutoComplete and the original GuiInput, including its composition and grapheme behavior.

Parts, theme resources and explicit styles retain their established priority. Borrowed nodes return to callers; owned subscriptions, pending producers and image leases release on cancellation/root disposal, including acquisition failure. Adapters ignoring AbortSignal still cannot publish obsolete results. Callers must not reuse a released image source or mutate their input tree synchronously from lifecycle callbacks.

## Validation and capacity

Require focused type/behavior checks, a manifest-backed native WebGPU gallery, deterministic real tarball installation and independent full/leaf consumers before completion. Source hashes and old failures remain in the [P3 evidence](../../../artifacts/gui-p3/20261128). Existing performance, pixel, resource, root and consumer budgets remain. Any package capacity increase follows measured capability/duplication review under the user's standing authorization, preserving the first raw failure. No physical-device or formal release qualification is implied.

See [guide](../../engine-guide/gui-specialty.md), [API/limits](../../api/gui-specialty.md) and [implementation review](../../../review/gui-p3-20261128.md).
