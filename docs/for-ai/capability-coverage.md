# Stable capability coverage

此矩阵与 `examples/manifest.json`、`games/manifest.json` 一起作为发布门禁；stable 核心能力必须有最小 example，关键 3D 能力还必须进入 game 或 editor workflow。

| Stable capability | Minimal example | Product workflow | Automated evidence |
| --- | --- | --- | --- |
| RenderProfile / fallback | `pbr-showcase`, `gpu-driven-megabatch` | editor diagnostics | `render-product-stage9.test.mjs` |
| metallic-roughness PBR | `pbr-showcase`, `gltf-viewer` | `billiards-3d`, editor PBR resource | stage 9 unit + pixel |
| PBR Clearcoat | `pbr-showcase`, `gltf-viewer` | editor PBR resource inspector/runtime export | on/off pixel baseline; required glTF fixture; pipeline/lifecycle/benchmark gates |
| PBR IOR / Specular / Sheen | `pbr-showcase`, `gltf-viewer` | editor PBR resource inspector/runtime export | extension codec tests; required glTF fixture; real WebGPU direct-light/IBL pixel baseline |
| directional shadow | `pbr-showcase` | `billiards-3d` | stage 9 pixel + lifecycle; off-camera caster/light-frustum; shared object table; real WebGPU static/morph/skinned/combined warmup |
| environment IBL | `pbr-showcase` | editor PBR preview | stage 9 pixel + fallback gate |
| distance / height Fog | `fog` | editor viewport scene environment | distance + height pixel baseline; Basic/PBR/Blinn/Instanced shader validation; Fog semantic tests |
| material variants | `pbr-showcase`, `gltf-viewer` | editor runtime import | glTF contract test |
| glTF / asset lifecycle | `gltf-viewer` | editor import/export | component tests |
| GPU-driven batching | `gpu-driven-megabatch` | `billiards-3d` | engine batch tests + benchmark |
| BVH mesh LOD | `bvh-lod` | large 3D scene content | level validation, hysteresis, spatial candidate, transform/revision and lifecycle tests |
| render pipeline / postprocess | `render-pipeline`, `postprocess` | editor viewport | pipeline tests |
| 2D | `shapes2d`, `mixed-scene` | `spider-solitaire` | engine/editor tests |
| GUI | `gui-runtime` | `pad-simulator`, editor shell | GUI tests |
| Spine | `spine-viewer` | component workflow | parser contract tests |
| tilemap | `wfc-map` | game `wfc-map` | manifest build |
| input / 3D physics | `interactive`, `box2d-collision` | `billiards-3d`, `sokoban-3d` | game smoke builds |
