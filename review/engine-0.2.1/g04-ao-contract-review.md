# G04 AO compatibility decision

2026-09-28. **Resolved by implementation and acceptance.** The user selected option 1 (the frozen lighting AO contract); the final native and repository checks pass. The observation and alternatives below preserve the original decision context.

## Observed conflict

The current production `shader-language/src/postprocess/builtin-wgsl.ts` AO upscale function returns `vec4<f32>(base.rgb * shaped, base.a)`. `Render3DFrameCoordinator` executes scene lighting, auxiliary surfaces, then postprocessing. GTAO/SAO/SSAO therefore darken the composed scene, including direct illumination and emission, in both original Forward and current Deferred. Two native adapters pass the legacy pixel comparison; that comparison does not prove indirect-only AO.

[ADR 0109](../../docs/for-ai/adr/0109-deferred-lighting-021-contract.md#材质与-pass-图) instead freezes auxiliary/AO before resolve, with AO consumed by lighting. The milestone [contract](../../../milestones/milestones/m18-engine-0.2.1/contracts.md) explicitly says “AO 不无条件乘全部自发光与直接光”. The same milestone also requires preservation of existing effect semantics. These two requirements produce different images for the current production AO.

## Concrete alternatives

1. **Implement the frozen lighting AO contract.** Keep default Forward compatibility, but add a private Deferred AO visibility path before lighting, apply it to the intended indirect contribution, and remove the duplicate post composite. Cover standard PBR, opaque extension proxies and transparent/transmissive full-list PBR; keep their shared auxiliary coverage and 16 sampled-texture limit. Add analytic direct-only, emission-only and indirect-only pixel oracles. This is additional rendering implementation; the existing Forward AO image is not an oracle for the intentionally different contribution semantics. Re-run affected generation/cost, effects/material, lifecycle and native gates before completion.
2. **Preserve the existing AO appearance for 0.2.1.** Keep the already-tested post composite, explicitly document whole-scene modulation, and supersede the incompatible AO section with a reviewed ADR and milestone contract amendment. Do not claim physically selective AO or mark the old requirement satisfied. A later iteration can add a separate lighting AO feature with migration guidance.

No threshold, test population, frozen contract or generated AO shader has been changed to hide this difference. Shader budget remains 570,000 bytes / 75 files / 67 variants and pipelines. G04 must remain active/validating until one policy is selected and its required implementation/review is complete.

## Implementation follow-up — 2026-09-28

Option 1 is implemented. A private storage-buffer visibility path feeds ambient/environment terms before resolve/full-list shading, without adding a sampled texture. Native contribution tests cover each AO algorithm, Reference/Tiled, direct, emission, ambient, IBL and transmissive scenes. Legacy Forward remains unchanged; final acceptance and evidence are recorded in the [compatibility audit](g04-compatibility-audit.md). The conflict is resolved by implementation, with no frozen-contract amendment.
