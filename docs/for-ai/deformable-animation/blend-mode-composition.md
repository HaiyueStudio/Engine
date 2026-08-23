# Deformable 2D blend-mode composition semantics

Status: G11 complete candidate. Synthetic normal/additive/multiplicative parity, licensed Rice additive parity, and caller-supplied official Niziiro Mao multiplicative parity pass.

## Frozen oracle

G01 pins `CubismWebSamples` tag `5-r.5` and `CubismWebFramework` revision `d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b`. G11 uses the official premultiplied-alpha WebGL shader and blend-state selection at that revision:

- <https://github.com/Live2D/CubismWebFramework/blob/d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b/src/rendering/cubismshader_webgl.ts>
- <https://github.com/Live2D/CubismWebFramework/blob/d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b/Shaders/WebGL/fragshadersrcpremultipliedalpha.frag>
- <https://docs.live2d.com/en/cubism-editor-manual/blend-mode/>
- <https://www.live2d.com/en/sdk/download/web/>
- <https://docs.live2d.com/en/cubism-sdk-manual/cubism-core/>

This contract covers Cubism 5.2-and-earlier drawable `normal`, `additive`, and `multiplicative` composition. It does not cover state-machine additive layers, drawable multiply/screen tint colors, or Cubism 5.3 advanced blend modes.

## Source-neutral equations

Let `C` be the straight authored texture RGB, `At` the texture alpha, `O` the drawable opacity, `M` the resolved mask coverage, `Cd/Ad` the current destination, and:

```text
A = At * O * M
P = C * At * O * M
```

`P` is the premultiplied source color submitted to the blend unit. The frozen results are:

| Mode | WebGPU color factors | WebGPU alpha factors | Result |
| --- | --- | --- | --- |
| normal | `one`, `one-minus-src-alpha` | `one`, `one-minus-src-alpha` | `Co = P + Cd(1-A)`, `Ao = A + Ad(1-A)` |
| additive | `one`, `one` | `zero`, `one` | `Co = P + Cd`, `Ao = Ad` |
| multiplicative | `dst`, `one-minus-src-alpha` | `zero`, `one` | `Co = P*Cd + Cd(1-A)`, `Ao = Ad` |

The normalized `rgba8unorm` target clamps the result. An unknown blend flag is a conversion error and never falls back to normal. A cross-frame blend-mode change that the HYA contract cannot express is also classified at its capture source path.

## Texture and color configuration

Premultiplication must happen before linear filtering. Sampling a straight-alpha texture and multiplying afterward produces different edge colors across alpha gradients. The deformable runtime therefore:

- decodes with `createImageBitmap({ colorSpaceConversion: 'none', premultiplyAlpha: 'none' })`;
- uploads to `rgba8unorm` with WebGPU destination `premultipliedAlpha: true`;
- marks the visual as `textureAlphaMode: 'premultiplied'` and uses the matching fragment entry point;
- includes both drawable blend mode and texture alpha mode in the render-pipeline cache key;
- applies drawable opacity and mask coverage after sampling the already-premultiplied texel.

The generic image-texture API keeps straight alpha as its default. Straight and premultiplied uploads have distinct cache identities and recovery descriptors. The comparison page creates a premultiplied ImageBitmap for the WebGL reference, uses the same bytes, clear color, paused time, fit transform, viewport, and disables WebGL antialiasing so both sides use one sample.

Mask setup remains the fixed normal alpha-union pass frozen by G10. A mask source's main-pass blend mode must not change mask-target accumulation.

## Runtime and lifecycle

Mode selection only chooses an existing cached render pipeline. Action switches retain the player, textures, model owner, and GPU buffers. Texture cache entries retain their alpha representation across device recovery. Renderer recovery releases pipelines, bind groups, composite targets, and texture GPU state, then rebuilds them from the stored descriptors; destroy and replacement remain idempotent.

## Replayable evidence

The MIT `blend-parity` fixture in `examples/live2d-hya-compare/samples/manifest.json` contains five drawables, two textures, two mask references, one additive drawable, one multiplicative drawable, opacity, foreground/background ordering, and action switching. Its strict converter report has zero diagnostics.

The direct WebGPU readback fixture covers 15 cases across all three modes, transparent and colored backgrounds, half-transparent source texels, mask coverage `0`, partial, and `1`, three texture bindings, opacity, and both draw orders. It reads `rgba8unorm` bytes with `copyTextureToBuffer`; the accepted maximum byte error is one. It also decodes and uploads a generated PNG and verifies the authored straight texel bytes before composition.

Run:

```bash
node examples/live2d-hya-compare/generate-assets.mjs
npm run build:target -- example:live2d-hya-compare
node scripts/verify-deformable-blend-composition.mjs
node scripts/verify-animation-compare-examples.mjs
node scripts/verify-live2d-local-corpus.mjs --model <licensed-runtime-directory> --core <official-sdk-live2dcubismcore.min.js>
```

Chrome 151 on native D3D11 reports maximum channel error `2`, mean absolute error `0.013899`, and zero pixels above the configured mismatch threshold for the synthetic official/HYA surface comparison. The direct WebGPU gate reports maximum byte error `1` across 15 cases. Action switching retains one player installation and device recovery passes.

The caller-supplied official **Rice Glassfield - PRO** runtime is local-only; no licensed bytes are committed. Frozen capture observes 178 drawables, 19 mask references, five inverted-mask consumers, 21 additive drawables, and zero multiplicative drawables. At one second the latest successful paired readback reports maximum channel error `179`, mean absolute error `0.183182`, mismatch count `3377`, mismatch ratio `0.006768`, stable-interior maximum error `2`, and zero unclassified failures. Rice therefore satisfies the real additive requirement but not the real multiplicative requirement.

The caller-supplied official **Niziiro Mao** runtime is also local-only. Frozen capture observes 262 drawables, 65 mask-reference contributions, 10 inverted consumers, 15 additive drawables, and eight multiplicative drawables. The official Core mask-index storage is bounded by `drawables.maskCounts`; repeated references inside that count are retained because Cubism renders every contribution. To keep the parity artifact below the 64 MiB HYDM input budget, the evidence profile bakes the first motion only at `0s`, `1s`, and its end time; the official and HYA surfaces are both sampled exactly at `1s`. Chrome 151/D3D11 reports maximum channel error `180`, mean absolute error `0.346908`, mismatch count `6506`, mismatch ratio `0.013038`, stable-interior maximum error `8`, and zero unclassified failures. This satisfies the real multiplicative requirement without committing model or Core bytes.

The evidence is recorded in `review/candidates/live2d-blend-mode-candidate.json`. It remains a dirty-worktree candidate, not a promoted pixel baseline. The local-corpus verifier accepts `--core` for a caller-supplied `live2dcubismcore.min.js` from the official SDK. It exposes that file only through the test server's same-origin mount, records its hash and byte length, excludes it from project provenance, and never copies it into the repository. Without `--core`, the comparison page retains its official CDN default; CDN unavailability is classified as infrastructure failure before model evaluation.

## G12 handoff

G12 may rely on the frozen formulas, premultiplied texture upload, alpha-aware cache identity, mask-pass isolation, synthetic evidence, Rice additive evidence, and Mao multiplicative evidence. G11 is complete; G12 receives positive real observations for normal, additive, multiplicative, alpha mask, and inverted mask with zero unclassified failures.
