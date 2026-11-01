# GUI composite controls

The 0.2.3 development candidate adds `GuiIconPosition` to `@haiyue/engine/gui`, `GuiTabHeaderOptions` to the existing `@haiyue/extensions/gui-layout`, and twelve exports to `@haiyue/extensions/gui-controls`. Published 0.2.2 packages do not contain these additions. Use matching Engine/extensions candidates.

`GuiStyle.iconPosition` accepts `left` or `right`, defaulting to left. Measurement, theme insets, aspect ratio and painting share the original GuiContent geometry. With no icon there is no icon gap. Images remain borrowed; their original owner handles readiness, replacement and detachment.

## Tabs

The original `GuiTabContainer` and `GuiTabPage` retain their identities and state format. Page headers accept `icon`, `iconPosition`, `iconSize` and `iconGap`. `setPageHeader(id,options)` merges named fields after validation. Omitted fields remain; explicit `icon: undefined` clears the page icon. Dimensions and gaps must be finite and nonnegative. Existing activation, hidden pages, close veto, reordering and focus history remain available. Only the active page joins the GUI tree. Disposal detaches borrowed page content.

## Breadcrumb

`GuiBreadcrumb` exposes `element`, `currentKey`, `setItems(items)`, `setCurrent(key|null)` and `dispose()`. It exports `GuiBreadcrumbItem`, `GuiBreadcrumbMenuItem` and `GuiBreadcrumbOptions`. Keys must be nonempty and unique across the path and all menu items. Labels, optional icons, disabled flags and per-item separators are captured as immutable configuration; images remain mutable borrowed sources.

The last enabled item is current by default. Current and disabled path items do not navigate. Explicit null selects no current item, including after `setItems`; removing another current key falls back to the last enabled item. Separators default to `/`. Long paths wrap within their available width. Navigation calls `onNavigate(key)` once; the application owns route changes.

Optional one-level menus use original GUI buttons, scrolling and the modal focus domain. Pass the existing GUI system's `focus` manager. Closing restores the trigger focus; selecting returns the menu item's key. No DOM router or browser history is involved.

## Badge

`GuiBadge` exposes `element`, `setValue(value)`, `setOptions(options)` and `dispose()`. It exports `GuiBadgeValue`, `GuiBadgeStatus`, `GuiBadgePlacement` and `GuiBadgeOptions`. Optional `content` is borrowed at construction and cannot be replaced through `setOptions`.

| Option | Behavior |
| --- | --- |
| `variant` | `count` by default; also `dot` and `status` |
| `value` | Nonnegative safe integer or nonempty text; default 0 |
| `showZero` | Default false; only count zero is hidden |
| `overflowCount` | Default 99; 100 displays `99+`; text is not overflow-formatted |
| `status` | `default`, `processing`, `success`, `warning`, `error` |
| `statusText` | Visible status label and accessible name |
| `placement` | Default `top-right`; all four corners supported |
| `offset` | Finite logical `[x,y]`; positive values move right/down |

Attached decoration is outside content flow and ignores pointer/focus input. Borrowed content keeps its own interaction. Standalone badges participate in normal layout. `setOptions` validates before merging, and unchanged visible text does not invalidate paint. `style` applies to the badge decoration; processing has static status semantics without a timer.

## Collapse

`GuiCollapse` exposes `element`, `setItems`, `setExpandedKeys`, `getExpandedKeys`, `toggle` and `dispose()`. It exports `GuiCollapseItem` and `GuiCollapseOptions`. Items use stable unique keys, title/icon configuration, borrowed `content`, optional borrowed `extra`, and a disabled flag. Content and extra nodes must be distinct and unattached to another owner.

Panels default to all closed and multiple expansion. Accordion accepts at most one expanded key. Unknown or duplicate keys reject before mutation. Programmatic changes can expand disabled panels; disabled only blocks user toggles. `setExpandedKeys` and `toggle` default to `notify=false`; real interactions notify once. Callback keys are readonly and ordered by items. Setting the same state does not notify.

`toggleArea` is `header` by default or `icon`. `expandIconPosition` is left by default or right. Extra actions do not toggle the panel. Closing moves focus through the existing input domain before hiding; uncommitted composition follows the original editor policy. Hidden content remains owned by the application, with no drawing or hit testing. Reordering preserves sections and content state. Dispose nested controllers explicitly; removing a parent never destroys borrowed children.

See the [assembly guide](../engine-guide/gui-controls.md) and [runnable example](../../examples/gui-controls/index.html). Real keyboard/IME/gamepad and Mac/iPhone qualifications are bound to the final candidate by G11.
