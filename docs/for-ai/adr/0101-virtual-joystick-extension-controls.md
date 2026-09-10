# ADR 0101: Virtual joystick in extensions controls

Status: implemented local development candidate; no npm publication requested.

## Decision and API review

The user requested a reusable configurable virtual joystick in Engine/extensions.
Add `@haiyue/extensions/controls`, exporting one system class and eight public
contract types (nine symbols). Keep the extensions root unchanged. Attribute its
budget to a dedicated virtual-joystick-controls capability, using the existing
15% / two-symbol growth-reserve rule. This is a new capability allocation, not
a response to an exceeded existing budget. Future stable publication requires
the reviewed minor release described in API stability; do not publish it as a
0.1.x patch or change the frozen first-release artifact manifest.

The input surface is structural and host-neutral: Pointer Events and logical
bounds/capture methods. Engine dependencies use declared ecs, components, core
and gui exports only. Engine never imports this extension; no Games, Native,
Editor or UI dependency enters the package.

`VirtualJoystickControls` is a non-render System with explicit millisecond
step(), immutable state and typed Engine EventEmitter events. Fixed-center and
press-centered activation share one exclusive pointer owner. Direction is
unit screen-space direction; distance is reported both unclamped and clamped;
strength removes the configurable radial dead zone continuously. The frame
event retains actual elapsed time while built-in movement may cap integration
after a stalled frame. No RAF, timer, document shim or global input singleton
is introduced.

Optional parent-local XZ CartesianTransform3D and XY Transform2D binding handles
speed, analog strength, heading correction, movement basis and bounded angular
velocity. Collision/navigation remains the caller's responsibility; event-only
consumption avoids competing transform owners. Destroyed, missing or disabled
targets are not updated. Optional GUI discs reuse a caller-owned full-surface
GuiRoot; they own only their generated nodes and never consume GUI hits.

Cancellation, lost capture, blur, hidden pages, resize, configuration, disable
and destroy reset input. World destruction removes listeners and GUI nodes via
the ordinary System lifecycle. Native hosts call cancel on suspend, rather
than importing native platform APIs here.

## Validation and consumer

The manifest-backed [Virtual Joystick](../../../examples/virtual-joystick/main.ts)
consumer uses public imports, a rendered Entity and Engine GUI. The focused
Node suite covers input ownership, distance/dead-zone math, exact frame dt,
2D/3D movement and direction, finite turning, frame-rate independence,
configuration, resize and World disposal. A public-package type test verifies
the declaration entrypoint and typed readonly frame events. Browser validation
exercises fixed and GUI-selected floating input, translation/heading, multitouch,
release, cancellation and owned GUI cleanup in portrait and landscape.

Reviewable public contract: [Controls API](../../api/controls.md).
Runtime evidence and final checks: `review/api/virtual-joystick-validation.md`.
