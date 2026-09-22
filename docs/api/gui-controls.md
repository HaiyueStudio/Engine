# GUI controls

Stable entrypoint: `@haiyue/engine/gui`. New controls are a local development
candidate requiring a reviewed minor release (ADR 0102).

| API | Behavior |
| --- | --- |
| `GuiScrollView(options?: GuiScrollViewOptions)` | Vertical clipped content viewport using ordinary GuiElement layout options. |
| `contentHeight?: number` | Content height in logical pixels, default 0. |
| `scrollY?: number` | Initial vertical offset, default 0; clamped by layout. |
| `showScrollbar?: boolean` | Show scroll indicator, default true. |
| `setContentHeight(height)` | Update extent and clamp offset. |
| `scrollTo(y)` / `scrollBy(delta)` | Set or adjust clamped offset. Non-finite values reset to 0. |
| `scrollY` / `maxScrollY` | Read-only current and maximum offsets. |
| `GuiHelpDialog(options?: GuiHelpDialogOptions)` | GuiModal with close button, backdrop dismissal, wrapped scrollable message. |
| `body: GuiScrollView` | Read-only viewport reference; text children are internally managed. |
| `GuiButtonOptions.variant: 'outline'` | Draw a transparent outline, respecting radius and border color. |

Help options inherit GuiModalOptions except action/close visibility and backdrop
behavior, which the component fixes. Inherited title, message, callbacks and
style options remain available. Defaults: width 420 and height 390, clamped by
viewport. Runtime does not require a browser DOM. See the [usage guide](../engine-guide/gui.md)
and [ADR 0102](../for-ai/adr/0102-gui-scroll-view-and-help-dialog.md).
