# @haiyue/extensions

Optional runtime capabilities for `@haiyue/engine`.

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

```ts
import { HaiyueEngine } from '@haiyue/engine';
import { createGltfPlugin } from '@haiyue/extensions/gltf';
import { Animation3DMixer } from '@haiyue/extensions/animation3d';
import { createGltfAnimation3DRuntime } from '@haiyue/extensions/gltf-animation3d';

const engine = new HaiyueEngine({ canvas: '#app' });
engine.installPlugin(createGltfPlugin());
```

The package root remains a minimal experimental authoring base. Worker transport and low-level parsing are explicitly available from `@haiyue/extensions/experimental/gltf-worker` and `@haiyue/extensions/experimental/spine-worker`; they may change without stable-API compatibility guarantees.

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
