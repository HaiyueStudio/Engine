# Scrollable GUI and rule help

Use the stable `@haiyue/engine/gui` entrypoint. These controls render through
Haiyue GUI on both WebGPU browser and Native hosts; they do not create DOM views.
The new controls are a local development candidate (ADR 0102), pending a reviewed
minor release for public distribution.

```ts
import { GuiRoot, GuiScrollView, GuiButton, GuiHelpDialog } from '@haiyue/engine/gui';

const root = new GuiRoot();
const list = root.add(new GuiScrollView({
  x: 16, y: 80, width: 320, height: 240, contentHeight: 20 * 48,
}));
const help = root.add(new GuiHelpDialog({ width: '92%', height: 390 }));
for (let i = 0; i < 20; i++) {
  list.add(new GuiButton({
    x: 270, y: i * 48 + 7, width: 34, height: 34,
    text: '?', variant: 'outline', style: { radius: 17 },
    onClick: () => {
      help.setTitle(`Rule ${i + 1}`);
      help.setMessage('Describe the rule here. Long text wraps and can be scrolled.');
      help.show();
    },
  }));
}
// Attach root to the ordinary GuiSystem; layout uses logical viewport pixels.
```

`contentHeight` describes the complete vertical content, while the viewport uses
the ordinary width/height options. Call `setContentHeight` after content changes.
`scrollTo`, `scrollBy`, `scrollY` and `maxScrollY` use logical pixels. Offsets clamp
when content or viewport dimensions change. `showScrollbar` defaults to true.
Children are positioned relative to the scrolled content and clipped for drawing
and input, including nested views. Wheel and touch dragging are handled by
GuiSystem. Dragging suppresses button/switch clicks after a six-pixel threshold;
short taps still activate controls. A modal remains above its containing viewport.

Help stays open after a click. Its close button and outside backdrop dismiss it;
clicking inside the dialog does not. The inherited `setTitle`, `setMessage`,
`show`, `hide`, and `onClose` API applies. `body` is the read-only scroll viewport
reference; the dialog owns its generated text children. Configure colors with
`style` and `messageLabel.style`, and font size through `messageLabel.setFontSize`.
For non-Latin content, include those characters in the GuiSystem font options.

GUI serialization restores scroll offsets, contents, help text, and the outline
button variant. Do not send the new tags to older engine readers. The runnable
integration is [LED Sudoku](../../../Games/games/led-sudoku/README.md), shared by
its browser and Native app.

For touch lists that should coast after a quick swipe, set `inertia: true` on
`GuiScrollView`. Start with `inertiaStrength: 1`; increase it to coast farther or
reduce it for a shorter stop. A new contact stops momentum before activating a
row. The default is no inertia. Enable the same option on `help.body` for long
rule explanations.

To animate switches, pass `thumbTransitionMs: 200` and
`colorTransitionMs: 200` to `GuiSwitch`. Omit either value for its original
instant behavior. Both settings work independently, and rapid reversals remain
continuous. See [motion options](../api/gui-controls.md#optional-motion).
The regular `world.update(time, delta)` drives these animations. A host which
renders on demand should continue frames while `guiSystem.animating` is true
and stop animations on suspension with `guiSystem.stopAnimations()`.
