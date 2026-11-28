# GUI display and overlays

Development additions for the next minor. Authoritative signatures are the matching built `gui-display.d.ts`, `gui-overlays.d.ts` and existing GUI declarations. [ADR 0142](../for-ai/adr/0142-gui-p1-composition-and-overlays.md) records API attribution. See the [guide](../engine-guide/gui-library.md) and [example](../../examples/gui-library/index.html).

## Display entry

`@haiyue/extensions/gui-display` exports eleven classes and their option types. Each exposes `element`, `setStyle`, and idempotent `dispose`. Common options extend `GuiElementOptions` with optional root/focusManager; the latter is distinct from element `focus` options.

| Class | Main API | Named parts |
| --- | --- | --- |
| GuiCard | header/body/footer, setLoading | header, title, extra, cover, coverContent, body, content, footer, footerContent |
| GuiDivider | horizontal/vertical, label alignment | line, label |
| GuiTag | label, closeButton, close veto | label, close |
| GuiImageView | image, placeholder, status, setSource | image, placeholder |
| GuiAvatar | ImageView; size 16–512, circle/square | image, placeholder |
| GuiAlert | titleLabel, descriptionLabel, setContent | icon, body, title, description, action, actionContent, close |
| GuiEmpty | optional borrowed image/action | image, description, action, actionContent |
| GuiSpin | setSpinning, isSpinning; delay 0–60,000 ms | content, contentBody, indicator, progress, label |
| GuiSkeleton | setLoading, isLoading; rows 1–20 | placeholders, avatar, block, content, contentBody |
| GuiButtonGroup | setItems, setSelectedKey, selectedKey, buttons | item |
| GuiSegmented | single-selection ButtonGroup | item |

`GuiFeedbackStatus` is default/info/success/warning/error; Alert excludes default. `GuiSelectionItem` contains a unique key, label, optional borrowed icon and disabled flag. The original focus manager enables roving Tab and arrows. Programmatic selection does not emit by default.

## Overlay entry

`@haiyue/extensions/gui-overlays` exports eight classes and twelve types. Overlays take the original root/focusManager, optional anchor, dimensions, placement/alignment, dismissal flags and onOpenChange.

| Class | Behavior |
| --- | --- |
| GuiMenu | Standalone items; icons, shortcut, checked/danger/disabled, separators and children; buttons/setItems |
| GuiDropdown | Menu plus trigger; menu, setItems, open/openAt/close/setOpen/isOpen/dispose |
| GuiContextMenu | Right-click or long-press; 250–2,000 ms, default 500 |
| GuiPopover | Borrowed content; click/hover/manual |
| GuiPopconfirm | Title/description/actions; confirmation veto |
| GuiDialog | Borrowed body/header/footer; confirm/cancel veto; outside-close defaults false |
| GuiDrawer | Dialog at left/right/top/bottom |
| GuiNotificationCenter | open returns key, keys/close/closeAll/dispose; keyed updates; 1–8 visible, default 4; timeout default 4,500 ms, zero persistent |

Menus allow 1,000 unique items, depth 16. Nested panels share one GuiModal host. Hidden/detached anchors close popups. Close reasons are trigger/outside/escape/select/confirm/cancel/close/anchor-hidden/disposed. Overlay parts are panel/content. Dialog parts are header/title/close/body/footer/cancel/confirm plus bodyContent/headerContent/footerContent. Menu parts are list/row/item/separator/shortcut/arrow; notifications use Alert parts. Slots and image sources remain borrowed.

## Existing entries

The development P2 [data/forms/content API](gui-data-content.md) adds three focused extensions entries while preserving these entries and the root export surface.

`gui-controls` adds GuiExpandable/GuiExpandableOptions, a single-panel Collapse adapter. Tabs/Breadcrumb/Badge/Collapse/Split retain their owners and add default skins and named parts. Processing Badge animation uses the existing visible clock.

`gui-collections` adds readonly GuiCollectionRowState (selected, depth, expanded, leaf) for optional row setState, preserving the original keyed window and binding lifecycle.

Engine adds default-skin binding, frozen theme inspection, effective visibility and GuiRoot.onDispose. `setActivity(tick,{motion:false})` uses the original visible non-motion clock. GuiModal's pure getDialogRect/getContentLayoutRect and getPopupRect's optional anchor rectangle support planned layout without mutating live rectangles. Image/Progress/Slider fields and bounds are defined in their declarations; rendering remains in existing shape/text/image batches.
