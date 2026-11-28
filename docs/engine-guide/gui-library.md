# Composing the GUI component library

Development workspace additions for a subsequent minor release. Install matching Engine and extensions candidates; published 0.2.4 packages do not supply these additions. The runnable [GUI Library](../../examples/gui-library/index.html) is declared in the examples manifest.

Use one `GuiSystem`, its existing focus manager and one `attachGuiLayout(root)` binding. Display components compose ordinary GUI elements; overlays share the original modal, positioning and input owners.

```ts
import {GuiInput} from '@haiyue/engine/gui';
import {GuiCard} from '@haiyue/extensions/gui-display';
import {GuiDialog} from '@haiyue/extensions/gui-overlays';

// root and gui belong to the caller's scene, with attachGuiLayout(root) installed.
const editor = new GuiInput({width: 280, value: 'My project'});
const card = new GuiCard({
  root, focusManager: gui.focus, title: 'Project', content: editor,
  width: 320, height: 180,
  style: {parts: {title: {color: '#b96935'}, body: {backgroundColor: '#fff5e8'}}}
});
root.add(card.element);
const dialog = new GuiDialog({
  root, focusManager: gui.focus, title: 'Rename',
  content: new GuiInput({width: 300, value: 'Untitled'})
});
dialog.open();
// On teardown: dialog.dispose(); card.dispose(); then the layout binding/scene.
```

## Focused entries

P2 adds [data, forms and content](gui-data-content.md) through `gui-forms`, `gui-data` and `gui-content`. These optional entries reuse the same runtime owners and style precedence.

`gui-display` supplies Card, Divider, Tag, ImageView, Avatar, Alert, Empty, Spin, Skeleton, ButtonGroup and Segmented. `gui-overlays` supplies Menu, Dropdown, ContextMenu, Popover, Popconfirm, Dialog, Drawer and NotificationCenter. Neither is aggregated into the extensions root.

Use ImageView for borrowed source loading/error state and `GuiImage.fit` for drawing alone. Neither fetches images or destroys textures. Spin and Skeleton may wrap a borrowed subtree; the application keeps ownership of async cancellation and latest-result decisions.

## Keep your styles and content

Defaults use semantic light/dark tokens through the original skin resolver. Theme resources, named parts and explicit instance fields retain field-by-field precedence. Display components expose `setStyle`; overlays accept `style` and expose `element.setStyle`. Borrowed slots keep their explicit styles. [Theme and rendering](./gui.md) covers density, fonts, gradients, clips and painters.

Set `root.theme = GuiThemeResource.createTheme('light')` to switch defaults without rebuilding controllers. `GuiElement.setDefaultSkin` supplies extension defaults below application resources and parts; `getTheme()` returns a frozen token snapshot.

Slots require distinct, unattached elements. `dispose()` releases bindings, activity and listeners and returns borrowed content; it does not destroy images or remove application listeners. Dispose nested controllers explicitly. Display components may receive `root` for automatic root-destruction cleanup; without it, the caller owns disposal. Overlays always require a live root and its original `focusManager`.

Virtual List/Tree edits must update the application's keyed model through `onChange`. Optional `row.setState` updates selected/depth/expanded/leaf presentation without rebinding an active editor.

## Menus, motion and timers

Dropdown/Popover support click, hover or manual triggers. ContextMenu supports right-click and touch long-press with movement cancellation. Nested menus share one modal host; Escape, outside dismissal and unavailable anchors return focus through the existing manager. Notifications do not take focus; their keyed updates reset the timeout and visible queue length is bounded.

Hover/notification delays use the original clock with `{motion:false}`. They continue under reduced motion and pause while hidden, disabled or clipped offscreen. They measure visible elapsed time, not wall-clock deadlines. Spin/Skeleton visual motion follows reduced-motion settings.

## Updated controls

Tabs add placement and line/card/pill variants. Collapse adds bordered/ghost variants and `animationMs` (0–500, default 0): explicit or previously measured heights animate; unknown heights expand immediately. Expandable delegates to Collapse.

Image supports fill/contain/cover/none. Progress adds circle/status/indeterminate presentation. Slider adds vertical orientation, two-thumb ranges, up to 100 marks and value tooltips. Range Tab traversal visits both thumbs before leaving the original domain. Presentation fields use existing serialization; callbacks/transient state are not serialized.

See the [API index](../api/gui-library.md) for parts and bounds. Native automated checks cover keyboard/mouse/touch and original gamepad actions. Physical-device and release qualification remain separate from these development checks.
