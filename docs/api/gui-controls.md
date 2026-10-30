# GUI controls

## Toast notifications

`GuiToast` and `GuiToastOptions` are included in the 0.2.1 candidate through the
stable `@haiyue/engine/gui` entrypoint ([ADR 0128](../for-ai/adr/0128-toast-in-021-release.md)).
The candidate still requires its final release qualification; see the
[0.2.1 status](../../review/engine-0.2.1/README.md).

| Option / method | Behavior |
| --- | --- |
| `text` | Short, single-line text; overflow is clipped to the content rectangle. |
| `icon`, `iconKey` | Optional borrowed GuiImageSource and serialization key; caller owns its lifetime. |
| `iconSize`, `fontSize` | Logical pixels, defaults 22 and 15. |
| `durationMs` | Fully visible hold time, default 2200 ms. |
| `animationMs` | Each fade/slide transition, default 180 ms; 0 means instant. |
| `show({ text, icon, iconKey, durationMs, animationMs }?)` | Replace and restart one message; omitted values retain configuration. `icon: null` removes the icon. |
| `hide()` | Immediately cancel and hide. |
| `progress`, `animating` | Current visibility fraction and finite display lifecycle. |

Normal GUI layout and `style.backgroundColor`, `style.color`, `style.opacity`,
`style.padding`, `style.radius` apply. Toast starts hidden and never captures input.
It draws above ordinary content, below modals. Non-finite/negative timings behave
as zero. Include text glyphs in the GuiSystem font atlas. Serialization stores
configuration and resolves `iconKey` through `resolveImageSource`, not progress.
GuiSystem advances it automatically; use its existing `animating`/`stopAnimations`
contract for on-demand hosts and suspension. No timers or DOM nodes are created.

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

## Optional motion

Existing controls retain instant behavior unless motion is explicitly enabled.

| Configuration | Default | Behavior |
| --- | --- | --- |
| `GuiScrollViewOptions.inertia` / `view.inertia` | `false` | Continue a pointer drag after release with exponential deceleration. |
| `inertiaStrength` | `1` | Decay multiplier, clamped to 0–4. At 1, the velocity time constant is 325 ms; higher values coast farther, 0 stops momentum. |
| `GuiSwitchOptions.thumbTransitionMs` / `control.thumbTransitionMs` | `0` | Thumb movement duration in milliseconds, with ease-out interpolation. |
| `colorTransitionMs` | `0` | Independent track color transition duration in milliseconds. |

A list stops at its bounds, on a new touch, explicit `scrollTo`/`scrollBy`, or
when its extent changes. Holding before release or cancelling a gesture produces
no fling. A contact during momentum first stops scrolling without activating the
row beneath it. Wheel/trackpad events are applied directly so OS momentum is not
applied twice. Switch reversals start from the currently displayed position/color.
Non-positive or non-finite switch durations are instant. Initial checked state
is drawn without an entrance animation.

Ordinary World updates and RenderIntegration advance motion using the engine's
millisecond delta, exactly once per world frame even when multiple views record GUI. Demand-rendering hosts should request frames while
`guiSystem.animating` is true, and call `guiSystem.stopAnimations()` when
suspending. Hidden/disabled subtrees stop automatically on update. Device loss
also stops motion. Configurations serialize; transient speed/progress does not.

```ts
import { GuiScrollView, GuiSwitch } from '@haiyue/engine/gui';

const rules = new GuiScrollView({ inertia: true, inertiaStrength: 1 });
const toggle = rules.add(new GuiSwitch({
  thumbTransitionMs: 200,
  colorTransitionMs: 200,
}));
```

LED Sudoku uses these values for its lists and switches on browser and Native.

## RGB color picker

`GuiColorPicker` / `GuiColorPickerOptions` are available from
`@haiyue/engine/gui` (local candidate, [ADR 0103](../for-ai/adr/0103-gui-color-picker.md)).
The component uses engine GUI rendering and works without a native DOM color dialog.

| API | Behavior |
| --- | --- |
| `value?: string` | Initial opaque `#rgb` or `#rrggbb`, default `#2563eb`. Invalid initial values use the default. |
| `picker.value` | Read-only canonical lowercase `#rrggbb`. |
| `setValue(value, emit = false)` | Normalize a valid HEX value; ignore invalid input. Changed values emit only when requested. |
| `onChange?: (value: string) => void` | Fires for valid HEX edits and RGB slider changes. |
| `onCommit?: (value: string) => void` | Fires on valid HEX submission or slider release. |
| `width` / `height` | Standard GUI lengths, default 240 × 144. Allow at least 180 × 128 for comfortable editing. |
| `setDisabled(disabled)` | Disables the picker and its internal input/slider controls. |

HEX input accepts uppercase and surrounding whitespace. Incomplete/invalid drafts
show a red border and leave the last valid color unchanged; Enter restores that
color. Three-digit shorthand remains editable so six-digit input can be completed.
Alpha and other CSS color syntaxes are not supported. Serialization preserves
configuration/value; callbacks and transient input drafts are not serialized.

## Button hover colors (0.2.2 candidate)

`GuiButtonOptions.hoverTransition` / `button.hoverTransition` enables color transitions on pointer enter and leave (default `false`). `hoverTransitionMs` defaults to `180` milliseconds; zero, negative and non-finite values switch instantly. Background, text and border colors interpolate with ease-out cubic timing. Leaving or re-entering mid-transition continues from the current color. Theme-resource hover colors and local `style.hoverBackgroundColor` / `style.hoverColor` are supported. Nine-slice images switch normally without texture crossfades.

`GuiSystem` advances this finite animation through its existing frame loop and demand-rendering contract. Hidden/disabled controls and suspension stop the transition. Serialization saves only the two options. Changing either option during a transition immediately settles to the current hover state.

```ts
const button = root.add(new GuiButton({
  text: 'Continue',
  hoverTransition: true,
  hoverTransitionMs: 240,
  style: {backgroundColor: '#2563eb', hoverBackgroundColor: '#3b82f6'},
}));
```

The GUI Runtime playground exposes both settings in the GuiButton property panel.

## Input triple click

Three completed primary clicks/taps in the same input select its entire value, including all lines and complete emoji. Adjacent clicks must be within 500 ms and 6 logical pixels. Dragging, cancellation, focus loss, editing the committed value, or pressing the password eye resets the sequence. Read-only inputs may still select text; password clipboard protection remains in effect. The next ordinary click places the caret again.
