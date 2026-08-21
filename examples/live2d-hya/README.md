# Live2D Cubism to HYA (offline)

This example exercises the v1 clip-baked delivery path without shipping Live2D Cubism Core in the browser:

1. A Cubism-hosted build tool captures stable drawable topology and time-sampled vertices.
2. `hya-live2d-convert` lowers the capture JSON to a source-neutral `.hya` document and `.hydm` sidecar.
3. `@haiyue/extensions/deformable-animation` renders only the generic HYA representation.

The checked-in `mascot.capture.json` is a deterministic HaiYue-owned contract fixture, not a Live2D sample model. Regenerate its HYA outputs after building `animation-spec`:

```bash
npm run build -w ./animation-spec
node examples/live2d-hya/generate-assets.mjs
```

For a capture produced from a licensed Cubism model:

```bash
npm run cubism:capture -- --core /licensed/live2dcubismcore.min.js --model /project/model.model3.json --motion /project/idle.motion3.json --output build/model.capture.json
hya-live2d-convert --input build/model.capture.json --output build/model.hya --strict
```

V1 deliberately bakes one clip. Parameter inputs, physics, motion sync, multiply/screen color, and culling are reported as unsupported or approximated; normal/additive/multiplicative blend modes and alpha masks are preserved by the source-neutral runtime.
