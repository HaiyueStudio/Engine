# G04 → G05 handoff

2026-09-28. G04 is complete and G05 is ready, not activated. Final acceptance is recorded in the [compatibility audit](g04-compatibility-audit.md).

## Preserve

- Complete opaque/transparent PBR light lists, original shadow slots, proxy winner mask and batch object indices.
- AO before lighting, applied to ambient/IBL only; direct, emissive and transmitted radiance remain protected. Default Forward and AO debug display keep existing behavior.
- Per-view and pending-encoder ownership, explicit unsupported-instance/material/helper/mirror fallback, zero resource residue, and current G02/G03 correctness oracles.
- Approved shader limits remain 570,000 bytes / 75 WGSL files / 67 variants and pipelines. Current implementation consumes 560,954 bytes. Public API, package versions and consumer policies remain unchanged.

## Performance work still required

Follow the frozen G01 case populations, timing channels, device classes, host-idle checks and cohort protocol. G04 correctness captures are not performance baselines. Re-run the current complete runtime; old G03 timing captures do not include all G04 material/effect work.

The prior high-overlap absolute frame/GPU gaps remain open. Qualify the selected desktop-discrete 60 FPS and integrated 30 FPS targets and the separate four-view/1080p budgets without weakening quality, deleting slow samples or replacing complete lights with the eight-light Forward output.

Report AO auxiliary/occlusion/denoise/upscale/copy costs separately from light resolve and whole-frame timing. One AO visibility target plus row-aligned storage copy adds about 16 bytes/pixel before existing scratch; chained AO uses two targets. Fragment-stage layered PBR now needs five storage bindings, within the core eight-binding limit, while retaining at most sixteen sampled textures. Device-limit and visibility-buffer-capacity failures must remain explicit.

Include CPU prepare/record, GPU stage/frame time, queue wait, frameWall, upload count/bytes, draws/passes, allocations, cold pipeline compilation and residual resources. Confirm no new steady-state GPU buffer/texture creation and no Deferred resource allocations in default Forward. Existing CPU/external-GPU instances use explicit whole-view Forward fallback and cannot substantiate hundred-light instance performance.

G06 owns example/diagnostic product integration. G07 owns same-clean-revision package, API, release gates and candidate preparation. Publishing, pushing and tagging remain unauthorized by this handoff.
