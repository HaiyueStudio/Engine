# Specialized GPU GUI components

Next-minor development APIs; these entries are absent from the published 0.2.4 distribution. Use matching Engine/Extensions candidates and one existing `GuiSystem`, its `focus`, and `attachGuiLayout(root)`. The [specialty gallery](../../examples/gui-specialty-library/index.html) demonstrates all fourteen controllers and explicit application skins.

## Calendar and time

```ts
import {GuiDatePicker, GuiTimePicker} from '@haiyue/extensions/gui-pickers';
const date = new GuiDatePicker({root, focusManager: gui.focus,
  value: '2026-11-28', min: '2026-01-01', max: '2027-12-31', locale: 'zh-CN'});
const time = new GuiTimePicker({root, focusManager: gui.focus, value: '12:30'});
root.add(date.element); root.add(time.element);
```

Calendar values are ISO dates, never timestamps converted through local midnight. Locale controls labels, `firstDayOfWeek` controls the grid, and min/max/disabled rules control selection. Arrow/gamepad actions traverse enabled dates; Enter selects and the original popup returns focus. Time uses the existing numeric editor/IME and emits HH:mm or HH:mm:ss. Its step changes button increments; manual valid times need not align with that step. No timezone conversion, range calendar or native picker is implied.

## Files and QR codes

`GuiUpload` requires a host with `pick(signal)` and `upload(file, signal, progress)`. Files are opaque caller-owned records with stable keys, name/size/type and data. `add()` validates a whole batch, `start()` serializes queued uploads, and cancel/remove/dispose abort active work. Retry explicitly requeues an error/cancelled entry. Choose and Upload are separate buttons. MIME/extension checks are presentation policy; the transport must enforce its own file/security rules. Successful entries remain complete even if an application completion callback throws.

`GuiQRCode` requires `encode(text, signal)` returning `{size, cells: Uint8Array}` and a `rasterize(matrix, colors)` image lease `{source, dispose}`. Inject a licensed QR library, worker or platform service appropriate to your product. The explicit browser helper `createGuiQrCanvasRasterizer(() => document.createElement('canvas'))` paints a matrix into one image with a minimum four-module quiet zone. It does not install an encoder or DOM backend globally. Superseded requests cannot replace current images; replacement/disposal releases leases. Await `setValue()` and inspect its boolean result/feedback. The gallery has a precomputed matrix for the single payload `Haiyue GUI P3`; it is a fixture, not a production encoder.

## Scroll, composition and guided help

Anchor borrows a vertical GuiScrollView and named targets; `activate(key)` uses its original scroll owner. Call `refresh()` after application layout changes. Affix presents borrowed content in a fixed-height placeholder and offsets one panel using that same viewport. Supply the placeholder's content-space `contentOffset` if it does not begin at zero. Add the affix last in a manually positioned viewport to keep its panel after the scrolling body in painter order; no independent z-index/layer owner is added. Use numeric heights and call `refresh()` after content-size changes.

Masonry receives distinct borrowed item nodes and their heights at an explicit `columnWidth`, assigns each item to the shortest column, and delegates actual geometry to the shared layout. Use a fitting column count/width; this bounded composition is not a virtualized arbitrary-height list. Recreate it after a different measured dataset/column configuration.

Tour receives keyed target/title/description steps and optional cancellable `prepare(signal)`. Await `start()` or `go(index)`; missing/hidden targets return false. The original Popover handles focus/Escape/outside-close. Call `refresh()` from the application's existing layout/frame callback while open to follow target movement; unchanged geometry does not dirty the GUI. Dispose the tour on teardown. Watermark overlays noninteractive text on borrowed content. BorderBeam animates a marker along its border through the original activity lease, pauses while hidden/reduced motion, and offers `setPaused(true)` for a static surface.

## Input aids and history

Mentions composes the existing AutoComplete: type a trigger such as @ after whitespace, choose an async suggestion, and only that token is replaced. Prefix/suffix and caret are preserved; no query or selection is applied during native IME composition. Call `search()` after programmatic edits/caret changes when suggestions are needed.

VirtualKeyboard receives a function returning the intended original GuiInput, rather than creating another text model. The function should keep returning that input while a keyboard button owns focus. Keys call the editor's original insert/delete/grapheme/selection/submit methods; read-only and composition prevent edits. Supply custom rows for your language or product. This is an optional onscreen keyboard, not an IME replacement.

VirtualMouse emits logical `move/down/up/cancel` snapshots through an explicit host with `bounds()` and `dispatch(event)`. Route those through your existing canvas/native input surface; the gallery shows a browser adapter using canvas PointerEvents. Movement is clamped and held buttons are cancelled on hiding/disposal. It neither installs a gamepad sampler nor moves the OS cursor.

HistoryControls only presents a caller-owned `read/subscribe/undo/redo/goTo` port. Its bounded history list uses the original virtual list. Apply edits and store undo data in your application's existing command owner; unsubscribe/dispose the controls when leaving the scene.

All composite controllers expose original elements and named style parts. Semantic default skins stay below application theme resources, part styles and explicit child styles. Use `setStyle`, `style.parts` or borrowed custom content for your visual language. See [API and limits](../api/gui-specialty.md).
