# @haiyue/extensions

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
