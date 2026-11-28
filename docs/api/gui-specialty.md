# Specialized GUI API (development)

Next-minor additions. Authoritative declarations belong to `@haiyue/extensions/gui-pickers`, `/gui-assets`, `/gui-composition` and `/gui-assistive`; none is aggregated into the root. [Guide and runnable gallery](../engine-guide/gui-specialty.md).

Common composite controllers expose `element`, `setStyle` and idempotent `dispose`. A supplied live root owns teardown. Business data/content and host interfaces stay caller-owned; only explicitly returned QR image leases transfer release responsibility. The shared style/parts priority is unchanged.

| Controller | Contract / bounds | Named parts |
| --- | --- | --- |
| GuiDatePicker | value: string/null; month; setValue(value, emit=false), setMonth(YYYY-MM), open(); calendar dates 0001-01-01–9999-12-31; 42 reused buttons; firstDayOfWeek 0–6 | trigger/calendar/navigation/previous/heading/next/weekdays/weekday/grid/day/clear |
| GuiTimePicker | value: string/null; hours/minutes/optional seconds: original InputNumber; setValue; HH:mm[:ss], min/max; integer steps 1–60 | hours/minutes/seconds/separator; nested number input/decrease/increase |
| GuiUpload | choose/list/feedback; add, pick → Promise<boolean>, start → Promise<void>, cancel/retry/remove; items readonly snapshots; maxFiles default 20 up to 1,000; bytes default 32 MiB | choose/start/feedback; original virtual-list row/content |
| GuiQRCode | image/feedback; value; setValue → Promise<boolean>; UTF-16 text ceiling 8,192; matrix versions 1–40 (21–177 modules), exact 0/1 Uint8Array; size 32–2,048; quiet zone 4–16 | image/feedback; original ImageView image/placeholder |
| GuiAnchor | buttons/activeKey; activate/refresh; borrowed vertical viewport, 1–256 unique keyed target links | link |
| GuiAffix | fixed; refresh; numeric height default 48; top/contentOffset default 0; borrowed viewport/content | panel/content |
| GuiMasonry | readonly columnHeights; 1–12 columns, columnWidth 16–4,096, gap 0–128; up to 1,000 distinct borrowed nodes with height 1–16,384 | column/item/content |
| GuiTour | currentKey; start/go → Promise<boolean>, refresh/close; 1–256 keyed target steps; original modal focus owner | title/description/footer/previous/next/close |
| GuiWatermark | borrowed content; text ≤256 UTF-16 units; integer rows/columns 1–20 | content/overlay/mark |
| GuiBorderBeam | borrowed content; setPaused(boolean); duration 250–3,600,000 ms, marker size 2–64 | content/beam |
| GuiMentions | input/autocomplete; search → Promise<boolean>; one Unicode trigger, query ≤128 UTF-16 units; inherits bounded AutoComplete | autocomplete; nested input/feedback/suggestions |
| GuiVirtualKeyboard | buttons; press(key) → boolean; 1–8 rows, 1–20 distinct keys per row; a key has text or action, never both | row/key |
| GuiVirtualMouse | pad/feedback/position; moveBy, press/release/click/cancel; step 1–4,096 logical px; required host bounds/dispatch | pad/row/left/up/down/right/click/position |
| GuiHistoryControls | undo/redo/optional list; refresh; required read/subscribe/undo/redo and optional goTo; at most 1,000 keyed entries | undo/redo; original virtual-list row/content |

The explicit `createGuiQrCanvasRasterizer(createCanvas)` helper is the only new browser raster adapter and is retained only when imported. Encoders, file pickers/transports and virtual pointer hosts have no silent fallback. Aborted/stale producers cannot publish results; a producer ignoring abort may still consume its own work until it settles. Cancelling an upload does not undo a server-side action: the injected transport owns that protocol.

Invalid input raises the existing LayoutError `invalid-input`; disposed controllers raise `disposed`. Async host/validation failures appear in the controller's feedback/boolean result. User-supplied adapters must release listeners, object URLs, native handles or worker work that they acquire. Physical IME/gamepad/Mac/iPhone and formal release-performance qualification are separate from development automation.
