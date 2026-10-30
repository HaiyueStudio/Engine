# Shared layout and GUI composition (0.2.2 candidate)

`@haiyue/extensions/layout` is a CPU-only border-box layout engine. It supports the admitted Flex and Grid subset, explicit measurement, minimum/maximum sizes, percentages, padding, gaps, absolute placement and logical LTR/RTL. It has no DOM, GPU, GUI or OpenType initialization. It is not a complete CSS implementation: baseline alignment, arbitrary CSS selectors, ordering and automatic margins are not admitted.

```ts
import {createLayoutSession, type LayoutNode} from '@haiyue/extensions/layout';

const tree: LayoutNode = {
  id: 'toolbar', contentVersion: 1,
  style: {display: 'flex', direction: 'row', columnGap: 8},
  children: [
    {id: 'save', contentVersion: 1, style: {width: 80, height: 32}},
    {id: 'help', contentVersion: 1, style: {width: 80, height: 32}},
  ],
};
const session = createLayoutSession();
const result = session.update(tree, {
  width: {mode: 'exact', value: 320}, height: {mode: 'exact', value: 40},
}, () => ({width: 0, height: 0, minWidth: 0, minHeight: 0}), {metricsVersion: 0});
console.log(result.rects.get('help'));
session.dispose();
```

For measured content, the callback receives content-box constraints and returns content size and intrinsic minimums. Increment `contentVersion` when content changes and `metricsVersion` when the measuring font or provider changes. A failed or aborted update leaves the last published result valid. Dispose the session when its owner is destroyed.

GUI connects through `@haiyue/extensions/gui-layout`, using the same core as HYA:

```ts
import {attachGuiLayout, createGuiContainer} from '@haiyue/extensions/gui-layout';

const binding = attachGuiLayout(root);
const toolbar = root.add(createGuiContainer('row'));
binding.setStyle(toolbar, {width: 'auto', height: 40, columnGap: 8});
// Add existing GuiButton/GuiInput controls to toolbar.
// On teardown, dispose the binding before discarding its root.
binding.dispose();
```

Only one layout binding owns a root. `GuiSplitPanel` and `GuiTabContainer` use this binding; they do not install another solver. Tab page IDs stay stable, inactive content stays application-owned, and switching back restores accumulated invalidation. The `gui-runtime` example offers original coordinates, Flex/Grid, themes, panels/tabs and drag/drop profiles.

Region scheduling belongs to the scene's `renderView`, not to the layout core. A retained region skips static producer drawing; its cached pixels can still require composition while another region animates. All-idle presentation stops, and invalidation wakes the appropriate region. The retained cache limit remains eight regions / 64 MiB; ordinary frame attachments and retiring generations count separately in total GPU resources.

Existing synchronous Engine scene creation remains compatible and still includes GUI assembly. Explicit `@haiyue/engine/gui` consumers can use a separate `import()` boundary; the Engine root is not claimed to defer all GUI code. Cursor selection follows the existing GUI input owner (`text` for editable text and `pointer` for buttons); `style.cursor` can override it.

The candidate and device boundaries are tracked in [0.2.2 qualification](../../review/engine-0.2.2/README.md). New package entrypoints do not imply npm publication or physical-device acceptance.
