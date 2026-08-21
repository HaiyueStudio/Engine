# Live2D → HYA comparison

The bundled default is an MIT-licensed HaiYue capture fixture with two selectable playback ranges. It compares HaiYue WebGPU playback with an independent WebGL mesh reference, exercises instance-preserving action switching, and requires no Cubism runtime.

For an actual Live2D comparison, choose a local licensed runtime model directory containing `model3.json`, `moc3`, textures, and optionally Motion3. The page loads Cubism Core from the configurable official URL, lists every action declared by `FileReferences.Motions`, and bakes all Motion3 actions once into disjoint ranges of one HYA timeline. Changing the action only seeks the existing HYA player to another range; it does not recreate the player, drawable tree, or textures. Both views continue to run from one clock. Core and Live2D models are intentionally not committed.

The reference canvas uses official Cubism Core for parameter-to-vertex evaluation. Its small comparison renderer preserves Cubism UV orientation, premultiplied-alpha blending, normal/additive/multiplicative drawables, and alpha-mask composition. It remains a focused evaluator rather than a replacement for the full official Cubism Web Framework renderer.

Regenerate the bundled sample after building `animation-spec`:

```bash
node examples/live2d-hya-compare/generate-assets.mjs
```
