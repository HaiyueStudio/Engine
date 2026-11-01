# @haiyue/extensions

0.2.3 development: `@haiyue/extensions/audio` adds game volume profiles, caller-driven linear fades and up to 128 2D emitters over an existing Engine mixer. It owns no decoder, context, poller or HYA clock. See [audio ownership and usage](../docs/api/audio.md) and [the executable example](../examples/game-audio/index.html).

Optional runtime capabilities for `@haiyue/engine`.

`@haiyue/extensions/controls` adds configurable fixed/floating virtual joystick input,
per-frame events, Entity movement/heading and optional Engine GUI presentation.
See the [guide](../docs/engine-guide/virtual-joystick.md) and
[runnable example](../examples/virtual-joystick/index.html). It is part of the
reviewed stable surface of the current 0.2.x candidate.

## Stable entrypoints

- `@haiyue/extensions/gltf` — glTF loading, runtime components, compatibility reports, materials, and the engine plugin.
- `@haiyue/extensions/animation3d` — source-independent 3D clips, mixers, pose buffers, layers, masks, events, state machines, and the HYA adapter.
- `@haiyue/extensions/gltf-animation3d` — adapts glTF clips to the source-independent Animation3D runtime.
- `@haiyue/extensions/animation` — HYA Animation2D components, systems, loading, rendering, and state-machine integration.
- `@haiyue/extensions/deformable-animation` — source-neutral HYA deformable-mesh sampling, dynamic geometry, texture and alpha-mask runtime; it has no Live2D/Cubism dependency.
- `@haiyue/extensions/hya-state-machine` — the focused HYA 2D state-machine runtime.
- `@haiyue/extensions/spine` — Spine component, render system, plugin, and the stable worker interface seam.
- `@haiyue/extensions/tilemap` — Tilemap2D component, render system, and plugin.
- `@haiyue/extensions/canvas-text` — Canvas text component and render system.
- `@haiyue/extensions/tween` — Tween2D component and update system.
- `@haiyue/extensions/grid` — Grid2D component contract.
- `@haiyue/extensions/controls` — virtual joystick input, movement and optional GUI presentation.
- `@haiyue/extensions/i18n` — language packs, text/plural formatting and optional GUI bindings.
- `@haiyue/extensions/narrative` — branching stories, save/restore, host actions and optional GUI presentation.

```ts
import { HaiyueEngine } from '@haiyue/engine';
import { createGltfPlugin } from '@haiyue/extensions/gltf';
import { Animation3DMixer } from '@haiyue/extensions/animation3d';
import { createGltfAnimation3DRuntime } from '@haiyue/extensions/gltf-animation3d';

const engine = new HaiyueEngine({ canvas: '#app' });
engine.installPlugin(createGltfPlugin());
```

The package root remains a minimal experimental authoring base. Worker transport and low-level parsing are explicitly available from `@haiyue/extensions/experimental/gltf-worker` and `@haiyue/extensions/experimental/spine-worker`; they may change without stable-API compatibility guarantees.

`@haiyue/extensions/ray-tracing` is also experimental despite its unprefixed name.
Private samplers, renderers and resource owners are implementation details of the
focused runtimes, not additional stable entrypoints. Import the capability you
need; headless narrative consumers can use `NarrativeRuntime` without retaining
`NarrativeGui` in a tree-shaken bundle.

The glTF, Spine and Tilemap plugin factories own the systems they create. Scene
uninstall, installation rollback and scene destruction release those systems;
one plugin object can serve independent scenes. Editor viewport contributions
destroy systems they create and leave borrowed systems under their existing owner.

The source-neutral indexed-sprite renderer is available from `@haiyue/extensions/experimental/indexed-sprite`. It stores index planes and palette rows separately, so changing a palette does not duplicate sprite pixels. It also accepts RGB/RGBA planes, batches atlas pages, supports nearest or palette-aware linear filtering, and owns bounded upload/recovery/disposal:

```ts
import { IndexedSpriteRenderer } from '@haiyue/extensions/experimental/indexed-sprite';

const renderer = new IndexedSpriteRenderer(device, [{
  id: 'idle-0', width: 2, height: 2, format: 'indexed8',
  pixels: new Uint8Array([0, 1, 1, 0]),
}], [{
  id: 'default', colorCount: 2,
  rgba: new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]),
}], { targetFormat: navigator.gpu.getPreferredCanvasFormat() });

renderer.uploadAll();
renderer.render(pass, [{ spriteId: 'idle-0', paletteId: 'default', x: 320, y: 180 }], 1280, 720);
renderer.dispose();
```

WebGPU is required by the runtime; there is no WebGL fallback.

## Animation text fonts

Animation2D and HYA state machines load the OpenType parser only when preparing a
materialized text component's font resource. Importing the animation entrypoints,
playing animations without text, or using only system fonts does not request it.
Keep ES module code splitting enabled and deploy the complete output directory;
single-file builds using `inlineDynamicImports` still include the parser.

Font preparation is included in `runtimeStats.pendingResourceCount`. Check
`failedResourceCount` as well: a failed parser download is a resource failure.
Browser-loadable font containers unsupported by OpenType retain Canvas shaping.
Removing the player during preparation prevents late font registration and releases
its asset handles. See the [asset lifecycle guide](../docs/engine-guide/asset-lifecycle.md#动画文本字体准备).

## Internationalization

`@haiyue/extensions/i18n` provides portable JSON language packs, text/plural formatting and optional GUI text/image bindings. See the [guide](../docs/engine-guide/i18n.md) and [example](../examples/i18n/README.md).

## Narrative

`@haiyue/extensions/narrative` provides JSON branching stories, transactional execution, save/restore, GPU GUI presentation and host-state action adapters. See the [guide](../docs/engine-guide/narrative.md) and [example](../examples/narrative/README.md).

## Share content

`@haiyue/extensions/share-content` generates localized score cards, PNG/JPEG captures and versioned challenge links. It produces plain data for a platform share adapter, without depending on Native or social SDKs. See the [guide](../docs/engine-guide/share-content.md) and [example](../examples/share-content/README.md).

## Achievements

`@haiyue/extensions/achievements` provides persistent event rules, bounded deduplication and optional localized GPU GUI. Inject a platform port; the extension imports no SDK. See the [guide](../docs/engine-guide/achievements.md) and [example](../examples/achievements/README.md).

## HYA composition (0.2.2)

The focused `hya-player`, `hya-text`, `hya-layout`, `hya-data`, and `hya-audio` subpaths share the original runtime owners. They keep host resources borrowed and publish a complete frame after data, text/layout and drawing are ready. See the [API guide](../docs/api/hya.md) and [public-package example](../examples/hya-production/index.html). The package root remains lightweight.

## Scene flow (0.2.3 candidate)

`@haiyue/extensions/scene-flow` prepares a fresh Scene with bounded concurrent loads, then activates it. It reuses Scene asset ownership, AssetManager deduplication and the existing synchronous scene host. The package root stays unchanged.

```ts
import { createSceneFlow } from '@haiyue/extensions/scene-flow';

const flow = createSceneFlow({ engine, concurrency: 4, onProgress: updateLoading });
await flow.transition({
  id: 'level-1',
  create: () => engine.createScene('2d'),
  assets: [{ url: '/level.json', type: 'level', assign: (level, scene) => buildLevel(scene, level) }],
});
// At application teardown:
flow.dispose();
```

`prepare()` returns a single-use `PreparedScene`; `commit()` is synchronous. Assignment callbacks run in request order after all resources succeed, and should bind only to the new scene. `cancel()` cancels only the pending transaction. `PreparedScene.dispose()` is a no-op after commit. `flow.dispose()` releases every flow-owned scene, including the active one; borrowed scenes, GUI, audio hosts and independent asset handles remain application-owned. `previous: 'retain'` keeps prior owned scenes until disposal, while the default destroys them after a successful switch.

At most one prepared generation is live. A replacement or cancellation rejects promptly and retires late factory results. Flow and per-asset signals are combined. A prepared scene is invalidated on device loss; the application may create another request after the engine recovers. Progress snapshots are immutable; observer exceptions are reported to the console without changing transaction ownership. The original `Scene.loadMany()` retains its sequential assignment behavior.

An activation failure restores the previous scene. If the host also refuses rollback, the flow reports `E_SCENE_INVALID_STATE` and releases the new scene's resources; the application must recover its host. Defaults and limits: concurrency 4 / maximum 16; requests 256 / maximum 4096. See [error codes](../docs/api/errors.md) and the [executable example](../examples/scene-flow/index.html). This candidate entry is not part of the published 0.2.2 packages.

## Character 2D (0.2.3 candidate)

`@haiyue/extensions/character2d` borrows an existing kinematic box/circle body and the original Physics2DSystem. The verified Box2D driver supplies real shape casts. Gravity, jumping rules and input remain application logic; `setVelocity()` accepts requested motion in render units per second, while the original physics velocity API remains meters per second.

```ts
import { createCharacter2D } from '@haiyue/extensions/character2d';

// Add the system and kinematic body entity to the same World first.
const character = createCharacter2D({ physics, entity });
character.setVelocity([180, -120]);
// Read character.state and physics.interpolationAlpha for presentation.
// Application teardown releases only the controller/listener:
character.dispose();
```

Motion uses bounded slide projections, ground/wall classification, slope limits, explicit initial-overlap reporting and optional constant-velocity translating-platform carry. Defaults: up `[0, 1]`, four slides (maximum 16), slope angle π/4, floor snap 4 render units, and clearance equal to the verified backend's 0.008 meter linear slop converted to render units. Query-only shape expansion applies clearance; native hull geometry and numerical tolerance stay in the backend. Zero snap retains contact detection without moving the character toward an airborne floor. Capsule, arbitrary polygon and rotating/deforming-platform behavior is outside this subset.

`state` is an immutable last-step snapshot. Its velocity is actual displacement per second, including platform motion. `teleport()` resets both pose snapshots. Physics `onFixedStep()` emits before → native step/contact drain → after once per actual tick; original `loadMany` and other scene APIs are unrelated. The private 2D/3D clock keeps the original finite-frame clamp, fractional remainder and cap reset. Disabling physics or skipping World time clears the old tail; interpolation presents the current pose until the next tick. Invalid step/max-substep settings reject before allocating a world, preserving RangeError for constructor validation. This policy is distinct from the experimental simulation clock's retained backlog.

Interpolate a separate drawing entity so presentation cannot overwrite physical transforms. Dispose the controller when removing its owner; automatic fixed-step detachment also handles replacement, disable and removal. The body, World and engine remain borrowed. See the [public-package example](../examples/character2d/index.html) and [error codes](../docs/api/errors.md). This candidate entry is not part of the published 0.2.2 packages.

## Camera 2D (0.2.3 candidate)

`@haiyue/extensions/camera2d` borrows an entity with the original `Camera2D` and `Transform2D` components. Add a `Transform2D` to a default 2D scene camera before creating the controller. This entry has no GUI or physics backend dependency, and creates no update loop, listeners or physics clock.

```ts
import { createCamera2DController } from '@haiyue/extensions/camera2d';

const follow = createCamera2DController({
  camera: cameraEntity,
  target: () => character.state.position,
  damping: 8,
  deadZone: { width: 100, height: 60 },
  bounds: { x: -1200, y: -500, width: 2400, height: 1000 },
  interpolation: () => ({ previous: character.state.previousPosition,
    current: character.state.position, alpha: physics.interpolationAlpha }),
});
// After updating the target and resizing the original camera:
follow.update(Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : deltaMs);
// After a level teleport, engine stop/resume or an application-owned recovery:
follow.reset();
// At application teardown:
follow.dispose();
```

Target, bounds, dead-zone dimensions, `state.position` and `state.offset` use world/render units. The controller preserves rotation, scale, design resolution and viewport mode. Parented cameras use the existing ECS transform store and must belong to the same World as an invertible planar parent. A second 3D transform on the controlled camera is rejected because the original renderer would prefer it over Transform2D.

Smoothing is exponential with default damping 8 per second; zero disables smoothing. `update()` requires finite nonnegative milliseconds; zero performs no sampling or advancement. The application remains the sole time owner. Optional interpolation directly consumes its previous/current pose and alpha in [0,1], without advancing or inferring another clock. `reset()` jumps to the authoritative target, clamps to bounds and cancels shake; it intentionally ignores an old interpolation pair. A closure may switch targets without a new controller.

The existing engine FrameLoop can emit a small negative first-frame delta when the RAF timestamp precedes its start-time reading. At that adapter boundary the example clamps finite negative deltas to zero, matching the original physics policy. It retains raw/applied frame deltas; nonfinite values still reach the controller's validation.

Bounds include the viewport footprint at the original camera's current width, height and zoom, including planar rotation/scale. A level smaller than the viewport fixes that axis at its center. Call the original `camera.resize()` before controller update when the display changes; no resize policy is copied. Shake is a single replaceable, decaying effect sampled by elapsed time and integer seed (default 0); amplitude bounds each world axis. Zero amplitude/duration cancels it. The effective offset stays within bounds and never feeds back into the logical target, physics or GUI.

Disabled camera/entity/transform/World pauses sampling and shake progress; the first resumed update resets to the current target. If the application stops calling `update()`, it must call `reset()` when it resumes. Disposal is idempotent, removes only the controller's own presentation offset, releases target/interpolation callbacks and preserves borrowed entities/components. Later updates are inert; `reset()`/`shake()` require a live controller. See the [character and cached-GUI example](../examples/camera2d/index.html). This entry is a local candidate, not the published 0.2.2 implementation.

## Input profiles (0.2.3 candidate)

`@haiyue/engine/input` exposes the original `InputActionMap`. Its experimental import keeps the same class identity. The original `BrowserMultiplayerInput` remains in `experimental/simulation`; it accepts an existing map in `players[].bindings` as well as the previous descriptor form. Borrow a map to apply rebinding without replacing the sampler or its GUI routes.

```ts
import { InputActionMap } from '@haiyue/engine/input';
import { BrowserMultiplayerInput } from '@haiyue/engine/experimental/simulation';
import { createInputBindingProfile } from '@haiyue/extensions/input-actions';

const map = InputActionMap.standardGameplay();
const input = new BrowserMultiplayerInput({
  players: [{ id: 'player', gamepadIndex: 0, bindings: map }],
});
const profile = createInputBindingProfile({ map });
profile.beginRebind('MoveX', 'negative');
// Feed the original host's release/down events or gamepad snapshots to offer().
// The host retains GUI consumption and capture-until-neutral ownership.
const data = profile.exportData(); // persist through the application's save service
profile.restore(data);
profile.dispose(); // the borrowed map and input sampler remain alive
```

Default keyboard axes use left/A = -1, right/D = +1, up/W = -1 and down/S = +1, matching browser gamepad axes. Each keyboard-axis pair cancels when both sides are held. Existing `keys` bindings retain boolean +1 semantics. Alternatives merge by greatest absolute value, retaining the earlier alternative on ties; the sampler merges keyboard, pointer and gamepad in that order. Original immutable snapshots remain valid after later samples or mapping changes.

Capture starts after a button release or a per-device neutral gamepad snapshot. Gamepad capture uses threshold 0.5 by default, with a fixed 0.15 neutral threshold; held controls and low stick noise do not become a fresh binding. The caller forwards samples from its existing host, filters keyboard autorepeat, and cancels pending capture on blur or player-context changes. The [settings example](../examples/input-actions/index.html) also demonstrates capture masking through the original gamepad layers, GUI ownership, and the existing `GameSaveService`. The factory creates no listeners, polling, clock, storage or action-state owner.

`button` captures a key, pointer button or gamepad button; `negative`/`positive` captures a keyboard direction or physical gamepad half-axis. Axis rebinding can invert a physical direction through signed scale; old positive-scale directional GUI bindings keep their magnitude semantics. Rebinding replaces the selected device/side, preserves unrelated alternatives, and prevents a physical control from occupying both sides of the same action. Default conflict handling reports [E_INPUT_BINDING_CONFLICT](../docs/api/errors/E_INPUT_BINDING_CONFLICT.md) without writing; explicit `share` or `replace` may share or remove only conflicting controls from other actions.

Profiles use format `haiyue-input-profile`, version 1, with default maximum 256 actions (configurable 1–4096). Restore validates the whole descriptor before committing. Capture commits preserve existing action order. `onChange` runs after commit; observer exceptions do not roll back accepted input. A borrowed sampler observes map replacements, emits old release edges once and quarantines held controls until neutral. Cancel/dispose release callbacks and borrowed references; disposed operations report [E_INPUT_PROFILE_INVALID](../docs/api/errors/E_INPUT_PROFILE_INVALID.md). This local candidate does not change published 0.2.2 packages; G11 owns 0.2.3 version integration and physical-input qualification.

## GUI collections (0.2.3 development)

The separate `@haiyue/extensions/gui-controls` candidate adds Breadcrumb, Badge and Collapse using original GUI elements. Existing `GuiTabContainer` gains per-page left/right icons and `setPageHeader`; the original shared GuiContent owns geometry. Content, images and focus remain borrowed; hidden panels keep state, while disposal detaches content and releases bindings. See [the GUI assembly guide](../docs/engine-guide/gui-controls.md) and [the public options](../docs/api/gui-controls.md). G11 owns final device/version qualification.

`@haiyue/extensions/gui-collections` provides fixed-height virtual lists and trees using the original Engine GUI. Supply stable nonempty keys and fresh original GUI rows. `bind(item,key,index)` returns the cleanup for that binding; `dispose()` releases the row once. Only the visible window plus bounded overscan owns rows. Tree expansion, selection and scroll anchors use keys, including navigation to offscreen items. The existing GUI input owner cancels composition, drag and capture before reuse. Keep persistent edits in the application model and restore them in bind. The collection owns the created rows; external data and the supplied focus manager remain borrowed.

Defaults: 100,000 logical items, overscan 2 per side; configured maxima 1,000,000 items, overscan 32 and 256 window rows. Geometry and unknown/duplicate keys reject before model changes. Row lifecycle callbacks must not mutate the same collection. Dispose before removing its owning GUI system. No additional input sampler, editor, renderer or DOM tree is created. See `examples/gui-collections` for editable rows and a keyboard/gamepad-navigable tree. Physical device qualification belongs to G11.

## Chunked Tilemap (0.2.3 development)

The existing `@haiyue/extensions/tilemap` keeps its palette, `Int16Array` cells, version cache and plugin. `setCell()` rebuilds only affected visible chunks; direct cell or palette mutations still require `markDirty()` to invalidate the whole map. The optional `atlas` borrows a `SampleableTextureSource`: supply integer `sourceWidth`, `sourceHeight`, `tileWidth`, `tileHeight`, and optional nonnegative `margin`/`spacing`. Tiles are row-major and 1-based; 0 is empty. Supply premultiplied RGBA through the original AssetManager (`premultipliedAlpha: true`); nearest sampling uses the first and last texel centers. The map never destroys its borrowed texture. Use a recoverable source wrapper around the original asset handle, and retain/release that handle in the application.

`setAtlas(null)` returns to palette colors. `setCellTransform(column,row,value)` accepts `none`, `flip-x`, `flip-y`, `rotate-90`, `rotate-180` or `rotate-270`; these are alternatives, not bit flags. `resize()` and `clone()` preserve transforms by cell coordinates. Atlas sources are runtime GPU handles and cannot be serialized; save the application asset identifier separately and rebind after loading. Palette serialization stays compatible, including the original cell-array format.

Chunks default to 32 cells per side (maximum 64); `maxResidentChunks` defaults to 64 (maximum 256), per rendered entity. Atlas or explicitly configured chunk maps allow at most 1,048,576 cells; old plain-color dimensions remain compatible. An axis-aligned camera culls outside chunks. Rotation or an unsafe projection conservatively renders the full map. A full cache uses a separate working stream so visible tiles are never dropped; account for that stream, uniforms and retiring buffers separately from residency. At most 32 simultaneous outstanding recording snapshots are retained; submit or cancel recordings before exhausting that bound. Ordinary static frames neither upload vertices nor wait for GPU completion. Scene destruction and device recovery reuse the original submission hooks and GPUResourceTracker. See [the terrain example](../examples/tilemap/index.html).
