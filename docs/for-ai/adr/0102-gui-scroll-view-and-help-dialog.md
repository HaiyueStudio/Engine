# ADR 0102: GUI scroll viewport and dismissible help

Status: local development candidate requested by the LED Sudoku UI integration.

Add `GuiScrollView` / `GuiScrollViewOptions` and `GuiHelpDialog` /
`GuiHelpDialogOptions` to the focused stable `/gui` entrypoint. The reviewed GUI
symbol allocation grows from 71 to 75 for these two controls and their options;
the growth reserve formula is unchanged. The exact root and frozen experimental
aggregate export counts remain unchanged. Stable publication requires the
reviewed minor release described in [API stability](../api-stability.md); this
local candidate does not authorize an npm release.

The viewport owns vertical offsets, clamping and content layout. GuiSystem owns
touch drag versus click arbitration and wheel routing. GuiRenderer intersects
nested viewport clips for shapes, images and text without changing shader ABI.
Modal overlays remain outside viewport clips. Help composes the existing modal
and viewport, wraps text with engine font metrics, and closes on its close button
or an actual backdrop click, never on blank space inside the dialog.

`GuiButton.variant = 'outline'` adds a transparent stroked shape, tessellated on
CPU only when the GUI batch changes. No background-colored disk simulates a hole.
The version-1 GUI document gains additive `scroll-view` / `help-dialog` tags and
`outline` variant; old readers reject these unknown tags, existing documents are
unchanged. Help internal controls are reconstructed rather than serialized twice.

The concrete runnable consumer is Games/games/led-sudoku, shared with Native.
Focused tests cover drag cancellation, clamping, hit/render clipping, dismissing,
serialization, and outline geometry. See [GUI guide](../../engine-guide/gui.md)
for minimal usage. Device checks additionally cover scrolling without changing a
rule, persistent tap help, and both dismissal paths.
