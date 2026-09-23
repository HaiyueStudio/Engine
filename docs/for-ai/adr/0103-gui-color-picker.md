# ADR 0103: Engine GUI RGB color picker

Status: local development candidate requested for the GUI component playground.

Add `GuiColorPicker` and `GuiColorPickerOptions` to the focused `/gui` entrypoint.
The scene-rendering GUI allocation grows from 75 to 77 symbols for this component
and its options; the reserve formula and root exports stay unchanged. This local
candidate follows the reviewed minor publication requirement in
[API stability](../api-stability.md) and does not authorize publication.

The picker composes engine GUI elements: a swatch, a HEX input, and three RGB
sliders. It requires no native browser color dialog, new GPU renderer, shader, or
texture allocation. Values normalize to opaque lowercase `#rrggbb`; alpha and
arbitrary CSS color syntax are outside this component's contract. Incomplete HEX
input remains editable without replacing the last valid color. Enter restores
invalid input. Programmatic updates are silent by default, while user changes and
commits have separate callbacks.

GUI serialization version 1 gains the additive `color-picker` tag with a `value`
property. Internal controls are reconstructed instead of serialized as children.
Existing documents remain valid; old readers reject the unknown new tag.

The [GUI runtime example](../../../examples/gui-runtime/main.ts) presents this
component and uses it to edit supported preview styles and image tint. The
[API reference](../../api/gui-controls.md) documents the contract. Focused tests
cover normalization, invalid drafts, controlled input, commit events, layout,
disabling and serialization. Browser checks cover RGB/HEX synchronization and
live preview color changes.
