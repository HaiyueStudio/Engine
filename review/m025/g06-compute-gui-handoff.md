# M2.5 G06 compute/GUI data and lifecycle handoff

- Goal / source revision / candidate revision: `g06-compute-gui-data-lifecycle`; source `c0e8fb7`; candidate is the clean commit containing this handoff.
- Changed owners:
  - Compute storage/read/indirect/render/copy ordering: implicit call order -> `ComputeResourceAccess` tokens and per-command-encoder validation with exact paths.
  - Compute stage flags: duplicated literals -> the typed precompiled-artifact stage map.
  - Texture convolution format, parameter size and workgroup contract: constructor literals -> Artifact V2 storage binding/uniform reflection plus the reviewed workgroup requirement.
  - GUI shape/image/text vertex stride and attributes: parallel packer/renderer literals -> `GuiVertexLayout` typed descriptors.
  - GUI image/text samplers: one sampler per image/font cache entry -> one renderer/device-owned sampler reference.
  - GUI persistence: trusted `GuiSerializedRoot` input -> `unknown` validation with `haiyue.gui@1`, exact path and structured serialization errors.

## Compute ordering and capability result

The validator rejects missing storage-write dependencies before command encoding, incompatible same-pass storage/indirect use, dependencies from another encoder and compute dispatch while a render pass is active. Production GPU-driven draw generation, culling, sorting, copy/readback and indirect consumption now declare the relevant tokens. WebGPU still provides command-order synchronization; no fictional barrier API was introduced.

`TextureConvolutionProcessor` remains intentionally restricted to the artifact-declared `rgba8unorm` storage format. Unsupported formats fail at `TextureConvolutionProcessor.options.format` with requested/supported context. The processor clears non-destroyable pipeline/layout references, destroys its uniform buffer idempotently and recreates all device-owned state after device replacement.

## GUI layout and serializer handoff

- Shape: 15 floats / 60 bytes; field offsets and GPU attributes are derived from one descriptor and match Artifact V2 reflection.
- Image and text: 12 floats / 48 bytes; both CPU packers and both renderers consume the same descriptor and match their artifact reflection.
- `GuiElement` layout fields and pointer handlers now have explicit types; no implicit-any geometry state remains.
- Serialized roots now contain `format: "haiyue.gui"` and integer `version: 1`. Missing/unknown format, non-integer/unsupported version, malformed layout/style/theme/props and nested control data fail as `E_SCENE_DATA_INVALID` in the serialization domain with an exact `$...` path.
- ADR 0005 applies: there is no legacy parser because no released user project format exists. Repository round-trip coverage was atomically moved to the versioned payload.

## Owner and fault inventory

| Owner | Owned device resources/references | Repeated destroy | Partial init | Device replacement |
| --- | --- | --- | --- | --- |
| TextureConvolutionProcessor | params buffer, pipeline/layout/module references | passed | reflected contract fails before use | passed, fresh device resources |
| GuiShapeRenderer | viewport buffer, bind group/layout/module/pipeline references, batch buffers | passed through GUI lifecycle | transactional rollback | passed |
| GuiImageRenderer | viewport/default texture, one sampler, bind groups, image/group caches | passed | sampler fault releases buffer/texture | passed, one sampler per device |
| GuiTextRenderer | viewport/default/font textures, one sampler, bind groups, font/batch caches | passed | transactional rollback | passed, one sampler per device |
| GuiRenderer | child renderers, root batches and generated font | passed | rolls back all prepared children | passed |

Pipeline, bind-group, layout, shader and sampler WebGPU objects have no explicit native destroy operation; destroy releases their owner references and clears caches. Destroyable buffer/texture residual is zero in the fault/recovery audit fixtures.

## Validation

- `npm run typecheck -w ./engine`; full engine test: 535 passed; engine build: passed.
- Focused compute/GUI/Render3D/readback suite: 32 passed before the full suite; focused contract suite covers ordering, layout, serializer and lifecycle faults.
- `npm run modules:check` (412 modules); `npm run responsibilities:check`; `npm run renderer-prepare:check`; `npm run lifecycle:check`; `npm run check:boundaries`: passed.
- Real WebGPU specialized-rendering gate: seven passes, convolution identity pixel `[25,50,75,255]`, validation errors `0`.
- Real WebGPU compute gate: five generated passes, three executed draw/sort/cull fixtures, side effects verified, validation errors `0`.
- GUI runtime example built and ran in the current WebGPU browser at 1280×720; engine button input changed the observed click count from `0` to `1`; browser warning/error log count `0`.
- Static search found no compute stage literal in compute sources and no parallel GUI `12/15` float or `arrayStride: 60` declaration.

## Integration notes

- Intentional pre-0.1 contract changes are the versioned GUI payload and compute ordering token/options used by the compute pass classes. G08 must review/promote the integrated API snapshot; G06 did not update the baseline.
- G08 retained `recordComputeResourcePass`, `GUI_SHAPE_VERTEX_LAYOUT`, and `GUI_TEXTURED_VERTEX_LAYOUT` as experimental ordering/layout parity seams. Their executable parity test consumes the aggregate boundary; none is added to a stable entrypoint.
- No pixel, performance, package-size or API baseline was modified. No runtime implementation item is deferred.
