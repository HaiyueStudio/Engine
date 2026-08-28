# Examples

Most simple and medium-complexity examples use the high-level `Scene` API. It creates the `World`, camera, `RenderPipeline`, and default render systems for you:

```ts
const engine = new HaiyueEngine({ canvas: 'canvas' });
await engine.init();
const scene = engine.createScene({ name: 'Demo' });
scene.add(new Entity('Box')
  .addComponent(new CartesianTransform3D())
  .addComponent(new Mesh3D(createBox3D(), new BasicMaterial())));
engine.switchScene(scene);
engine.run();
```

This is the ordinary-user lifecycle: initialize once, create and populate a scene, switch it active, then run. The engine updates only the active scene, exactly once per frame. Use `update` for mutations that must happen before systems render, and `after-update` for diagnostics or per-frame input cleanup; neither hook should call `scene.update()`.

## Scene API Quick Reference

Use `engine.createScene()` when the example or app needs the standard runtime loop, one main camera, and one shared render pass.

```ts
const scene = engine.createScene({
  name: 'My Scene',
  camera: {
    type: '3d',
    camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 },
    orbit: { radius: 8, theta: Math.PI / 4, phi: Math.PI / 3 },
  },
  render3D: { loadOp: 'clear' },
});
```

The returned object exposes the stable scene objects most examples need:

```ts
scene.world;          // ECS world
scene.cameraEntity;   // generated or user-provided camera entity
scene.render3DSystem; // default Render3DSystem, if enabled
```

Low-level scheduler diagnostics and overrides use the explicit `@haiyue/engine/experimental` accessors.

For 2D or GUI-only scenes, disable 3D and opt into the needed systems:

```ts
const scene2D = engine.createScene({ camera: { type: '2d' }, render3D: false, render2D: true });
const guiScene = engine.createScene({ render3D: false, gui: true });
```

Common presets are available for the standard setups:

```ts
const scene3D = engine.createScene('3d');
const scene2D = engine.createScene('2d');
const guiOnly = engine.createScene('gui');
const mixed = engine.createScene('mixed');
```

For custom render systems, disable the default system if needed and add the replacement through `scene.addSystem()`:

```ts
const scene = engine.createScene({ camera: cameraEntity, render3D: false });
scene.addSystem(new InstancedMesh3DRenderSystem(engine, cameraEntity, { loadOp: 'clear' }));
```

`scene.addSystem()` automatically registers systems with a `record()` method into the scene render pipeline. Pass `false` as the second argument for non-render systems that should only run through `World.update()`:

```ts
scene.addSystem(new SomeSimulationSystem(), false);
```

Plugins can be installed on a scene after engine initialization:

```ts
const scene = engine.createScene();
scene.installPlugin(createGltfPlugin());
```

Scene-level workflow helpers cover common app operations:

```ts
scene.remove(entity);          // remove an entity and its children
scene.clear();                 // clear scene entities but keep the scene camera
await scene.load('albedo.png'); // string requests load a texture and keep its handle alive
await scene.load({ type: 'texture/ktx2', url: 'normal.ktx2' });
scene.releaseAssets();         // release handles retained by scene.load/loadMany
```

Use `engine.switchScene(scene)` when the engine should update a scene automatically in `engine.run()`:

```ts
const menu = engine.createScene('gui');
const level = engine.createScene('mixed');
engine.switchScene(menu);
engine.switchScene(level, { destroyPrevious: true });
```

Call `engine.switchScene(null, { destroyPrevious: true })` to unload without activating a replacement, or `engine.destroy()` to stop the loop and release the active scene, retained assets, GPU owners, and engine listeners.

## When To Keep Low-Level Setup

Keep explicit `World` / `RenderPipeline` setup when an example teaches scheduling or owns unusual GPU pass lifetimes. Current low-level examples include:

- `render-pipeline`: explicit entry ordering and shared/isolated pass behavior.
- `rtt`: offscreen render target lifecycle.
- `postprocess`, `sobel-postprocess`, `outline-postprocess`: postprocess feature wiring.
- `game-of-life`: compute + render pipeline scheduling.
- `gpu-driven-instancing`: indirect draw and GPU culling instrumentation.
- `gpu-driven-megabatch`: ordinary Mesh3D direct draw, GPU-driven batch table, indirect draw, culling, and mega-batch performance instrumentation.
- `ktx2-matrix`: compressed texture format/device regression matrix.
- `viewport-scissor`: multiple cameras with explicit viewport/scissor render entries; OrbitControl uses a normalized `inputRegion` on the shared render canvas.

Everything else should prefer `engine.createScene()` unless the sample is intentionally demonstrating low-level API mechanics.

## First-release golden paths

The catalog remains manifest-driven; use target IDs instead of maintaining a second static example directory.

Example builds emit the Engine runtime once at `examples/shared/engine.js`. Each example keeps only its own
entry code and non-Engine capability code in `<example>/bundle.js`; the page loads the shared Engine bundle
first. `build:target` and the examples watcher create or refresh the shared bundle automatically.

- `consumer-walkthrough`: public Engine render, texture load, frame animation, and explicit disposal.
- `shapes2d` / `pbr-showcase`: representative 2D and 3D rendering paths.
- `gltf-animation3d-crossfade`: glTF skin/morph animation and cross-fade.
- `hya-samples`: manifest-backed Tween/transform, SpriteSheet, Path, and Particle HYA fixtures.
- `hya-state-machine`: one-asset clips, parameters, transitions, and cross-fade.
- `rive-hya-compare`: hash-pinned official Rive WebGL2 on the right and a report-bound HYA/WebGPU candidate on the left; no mock fallback.
- `rive-feature-corpus`: searchable 1,317-row projection of the frozen Rive object/property/asset/Luau census and current HYA support status.
- `game:sokoban-3d` and `game:billiards`: complete game workflows from `games/manifest.json`.

```bash
npm run build:target -- example:consumer-walkthrough example:hya-samples example:hya-state-machine
npm run build:target -- example:gltf-animation3d-crossfade game:sokoban-3d
npm run rive:examples:data
npm run build:target -- example:rive-feature-corpus example:rive-hya-compare
npm run rive:examples:verify
```
