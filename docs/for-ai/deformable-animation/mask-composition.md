# Deformable 2D mask composition semantics

Status: G10 complete; synthetic and licensed real-model browser parity are replayable.

## Frozen oracle

G01 pins `CubismWebSamples` tag `5-r.5` and its `CubismWebFramework` submodule revision `d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b`. The semantic oracle is the official WebGL renderer and its setup-mask, normal-mask, and inverted-mask fragment shaders at that revision:

- <https://github.com/Live2D/CubismWebSamples/tree/5-r.5>
- <https://github.com/Live2D/CubismWebFramework/blob/d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b/src/rendering/cubismrenderer_webgl.ts>
- <https://github.com/Live2D/CubismWebFramework/blob/d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b/Shaders/WebGL/fragshadersrcsetupmask.frag>
- <https://github.com/Live2D/CubismWebFramework/blob/d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b/Shaders/WebGL/fragshadersrcmaskpremultipliedalpha.frag>
- <https://github.com/Live2D/CubismWebFramework/blob/d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b/Shaders/WebGL/fragshadersrcmaskinvertedpremultipliedalpha.frag>

## Source-neutral rule

For texture-alpha samples `a1..an`, official Cubism clears the clipping channel to one and multiplicatively retains uncovered area. HaiYue clears a group target to zero and accumulates ordinary premultiplied alpha. The stored values are complements, but the consumer coverage is identical:

```text
official remaining coverage = product(1 - ai)
HaiYue stored union         = 1 - product(1 - ai)
normal consumer coverage   = union
inverted consumer coverage = 1 - union
```

Consequences:

- All source drawables in one mask list render into one stable group target; inversion is applied once by the consumer after the union.
- Group identity is the deterministic, length-delimited, sorted set of source-neutral drawable ids. Consumers with the same source set reuse a target even when their list order differs.
- The setup-mask pass uses sampled geometry, UVs, and texture alpha. It ignores drawable/model opacity, the source drawable's dynamic main-pass visibility, and the source drawable's own clipping context.
- A mask source remains a normal main-pass drawable. Its opacity, visibility, render order, and blend mode still apply there.
- Mask targets use viewport coordinates and `rgba8unorm`; the runtime clear value is transparent zero. The source-only pass always uses the normal alpha-union pipeline, independent of the source drawable's main-pass blend mode.
- Core bottom-left UV captures are normalized once during conversion. Runtime mask and main passes then share the same normalized UVs and sampled geometry.

## Validation and budgets

Capture validation runs before HYDM encoding and classifies missing references, self references, cycles, reference overflow, invalid dynamic visibility, and cross-frame identity/topology changes. Inverted masks without a source are invalid. A mask list is an ordered contribution list rather than a set: repeated references are preserved because the official renderer composites each occurrence and antialiased coverage is therefore not idempotent. Capture reads only the first `drawables.maskCounts[index]` entries from the Core mask-index view.

At the Cubism Core adapter boundary, bounded opacity overshoot from Core interpolation is clamped into `[0, 1]` before HYDM encoding. The official Rice initial pose exposes `1.0000499486923218`; the accepted bound is `1e-4`, while material drift such as `1.001` remains invalid. Old Core data may also retain an inverted-mask constant bit on a drawable with no mask references. The adapter omits that semantically inactive bit; the source-neutral capture validator continues to reject an inverted mask without a source.

Runtime allocation is classified before any GPU target is created:

- group count over `maxMaskTargets`: `E_ANIMATION_LIMIT_EXCEEDED` at `$runtime.views[...].maskGroups`;
- target width/height over `maxTextureDimension2D`: `E_ANIMATION_LIMIT_EXCEEDED` at `$runtime.views[...].maskTexture`;
- aggregate targets over 64 Mi pixels / 256 MiB rgba8: `E_ANIMATION_LIMIT_EXCEEDED` at `$runtime.views[...].maskPixels`;
- a missing composite target: `E_ANIMATION_INVALID_FORMAT` at `$runtime.visuals[...].composite`.

Targets are scoped by view key and source group, recreated on size change, swept after inactivity, released during renderer recovery, and destroyed idempotently with the renderer. Deformable geometry is sampled once per drawable and shared by its main and source-only visuals.

## Replayable evidence

`examples/live2d-hya-compare/samples/manifest.json` declares the MIT `mask-composition-parity` fixture. It covers single-source, shared multi-source, normal and inverted consumers, dynamic mask vertices, dynamic source opacity and visibility, visible mask sources, render order, and texture alpha. Its conversion report contains five mask references and zero conversion diagnostics.

Run:

```bash
node examples/live2d-hya-compare/generate-assets.mjs
npm run build:target -- example:lottie-hya-compare example:live2d-hya-compare
node scripts/verify-animation-compare-examples.mjs
node scripts/webgpu-gate/verify-deformable-mask-composition.mjs
```

The browser gate switches both mask actions without replacing the player, crosses a loop boundary, resizes the viewport, rebuilds renderer GPU owners, and then fixes time at 1 second, where `mask-a` is hidden in the main pass but must still contribute to clipping. Chrome surface readback compares the WebGPU HYA canvas with the WebGL reference at the same viewport and transform. A separate strict-validation WebGPU gate writes eight semantic cases into an `rgba8unorm` texture and verifies `copyTextureToBuffer` bytes for single/multi/inverted, clear, dynamic-inside, opacity, and visibility behavior. The candidate result is recorded in `review/candidates/live2d-mask-composition-candidate.json`; it is not a promoted pixel baseline.

The licensed real-model acceptance uses the caller-supplied official **Rice Glassfield - PRO** runtime locally; raw model bytes are not committed. The package `ReadMe.txt` identifies Live2D Inc. as illustrator/modeler and describes the model as an inverted-mask learning sample. Official terms and download evidence are:

- <https://www.live2d.com/en/learn/sample/rice-glassfield/>
- <https://www.live2d.com/eula/live2d-sample-model-terms_en.html>

Frozen Core capture observes 178 drawables, 19 mask references, five inverted-mask consumers, eight mask targets, and zero unclassified browser failures. Both renderers are paused at one second before capture. Paired Chrome surface readback at the same viewport reports mean absolute error `0.21977` and mismatch ratio `0.00692`, below the candidate limits of `1` and `0.025`. Replay without copying the licensed asset into the repository:

```bash
node scripts/verify-live2d-local-corpus.mjs --model <path-to-rice-runtime> --out review/candidates/live2d-local-corpus-candidate.json
```

## G11 handoff

G10 freezes mask group identity, source-only opacity semantics, the fixed mask alpha-union pass, inversion timing, target clear value, target lifecycle, and budget diagnostics. G11 may change main-pass normal/additive/multiplicative pipeline formulas and cache keys, but must not apply a source drawable's main-pass blend mode to setup-mask rendering or change the mask target color configuration.

No unclassified mask implementation failure remains. Rice supplies the required real mask/inverted-mask acceptance, so G10 hands the frozen mask pipeline to G11 without unresolved code paths.
