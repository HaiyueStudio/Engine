# Data, forms and content in GPU GUI

Development additions for the next minor release; the published 0.2.4 packages do not include these entries. Use matching Engine/extensions candidates and one original `GuiSystem`, `gui.focus` and `attachGuiLayout(root)`. The manifest-backed [data and content gallery](../../examples/gui-data-library/index.html) shows dark/light forms, large tables, trees, media and custom skins.

## Forms keep your model

```ts
import {GuiInput} from '@haiyue/engine/gui';
import {GuiForm, GuiFormItem} from '@haiyue/extensions/gui-forms';
const input = new GuiInput({value: 'Mira'});
const item = new GuiFormItem({root, label: 'Name', control: input, required: true});
const form = new GuiForm({root, focusManager: gui.focus, onSubmit: values => saveProfile(values)});
form.register({key: 'name', item,
  read: () => input.value, write: value => input.setValue(value),
  validate: async (value, signal) => {
    if (!value.trim()) return 'Please enter your name';
    return await checkName(value, signal);
  }
});
root.add(form.element);
// Await form.submit(); form.reset(); dispose form and item during teardown.
```

`required` displays the indicator; the caller supplies its validation rule. Form captures initial values by reference; use immutable values or clone them in your read/write adapter. Supply `subscribe(changed)` when a field changes so pending work aborts immediately. Without it, validation still compares captured values before publishing; callers must avoid mutating an object in place unnoticed. Unregister/reset/dispose cancel pending validation. A rejected validator becomes a field error. Submit-handler errors remain caller-visible.

InputNumber wraps the same GuiInput. It allows incomplete editing, commits finite decimal/exponent text at submit/blur, clamps/rounds only at commit, and leaves IME preedit alone. Up/down and step buttons share the same commit path. AutoComplete expands an inline, bounded suggestion list; this keeps its original input in the same focus scope. Suggestions receive `AbortSignal`; old results cannot replace new ones. Only committed edits trigger a request. Arrow keys choose enabled results, Enter selects and Escape closes; focus leaving the component or hiding its owner cancels publication. Loading, empty and failure feedback are visible.

## Large data stays data

```ts
import {GuiTable} from '@haiyue/extensions/gui-data';
const table = new GuiTable({root, focusManager: gui.focus, width: 600, height: 280,
  items: rows, keyOf: row => row.id,
  columns: [{key: 'name', title: 'Name', width: 360,
    text: row => row.name, compare: (a, b) => a.name.localeCompare(b.name),
    editable: true, onEdit: (row, value) => { row.name = value; }}]
});
root.add(table.element);
```

Table composes a fixed header and the original virtual list. Sorting/filtering are deliberate model operations; ordinary scrolling creates only viewport rows plus bounded overscan. Column widths are explicit; use a fitting column set for the available viewport. There is no second horizontal-scroll or automatic column-measurement engine. Use stable nonempty keys. Persist edits in `onEdit`; bind restores that model when the row returns. Layout/window changes cancel composition through the original collection owner before recycling. Do not synchronously mutate the same collection from row lifecycle callbacks.

Pagination is independent of data fetching; connect `onChange(page, pageSize)` to your own paging/load controller and then call setters with accepted state. TreeSelect uses the same virtual tree, shared Popover focus trap, committed-text search, single/multiple keyed selection and cancellable lazy children. A loader may use `isLeaf` to distinguish terminal nodes; `activate(key)` loads unknown children or chooses a leaf. Cascader shares the same list/overlay owners and drills through one active level; closing/backtracking/disposal abort the request. Business datasets and networking stay outside these controllers.

## Compose content and interactions

`gui-content` provides Steps, Timeline, Descriptions, Rate, Result, Ribbon, ImagePreview, Carousel, Draggable and Resizable. Timeline uses the original virtual list even for long histories; supply `createRow` for a custom row with the standard bind/unbind contract. Steps accepts borrowed item content, and Descriptions/Result/Ribbon/Carousel accept borrowed slots. ImagePreview borrows image sources, reuses Dialog, and supports pan/zoom/image switching without decoding or destroying caller textures. Carousel supports setters, indicators, swipe and optional autoplay; its original activity lease pauses when hidden/disabled/offscreen or reduced motion applies.

Draggable exposes a handle wired to the original `GuiDragSource`; application drop targets provide `canDrop` constraints and feedback through the existing protocol. It does not move scene nodes automatically. Resizable routes capture/cancel through the original input owner and exposes clamped size updates plus arrow/gamepad actions. Dispose wrappers to detach borrowed children and remove bindings; do not destroy caller-owned nodes or textures.

## Your styles stay authoritative

All controllers provide semantic defaults and `setStyle`/`element.setStyle`. Configure `style.parts` for internal parts, or apply an explicit style on a borrowed child. Application theme resources, named parts and explicit child styles remain above default skins; hot light/dark themes continue to work. See [the API parts and limits](../api/gui-data-content.md). Select search/multi mode and ColorPicker HSV/alpha remain separately optional enhancements from the original plan; TreeSelect already supports multiple selection.
