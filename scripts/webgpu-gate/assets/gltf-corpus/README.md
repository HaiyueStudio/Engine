# Production glTF first-visible corpus

The files in this directory are pinned copies from KhronosGroup/glTF-Sample-Assets
at commit `2bac6f8c57bf471df0d2a1e8a8ec023c7801dddf`. The manifest records the
upstream path, license, attribution, byte length, and SHA-256 digest of every
fixture file.

The three tiers deliberately exercise different production paths:

- `small`: CC0 Animated Morph Cube (`morph`, `animation`).
- `medium`: Cesium CC BY 4.0 Rigged Figure (`KHR_draco_mesh_compression`,
  `skin`, `animation`).
- `large`: Wayfair CC BY 4.0 Stained Glass Lamp (`KHR_texture_basisu`,
  ETC1S/UASTC KTX2, 8 meshes, 13 materials, and 19 textures).

The license notice copied beside each model is authoritative for that model.
Do not replace a fixture without updating the upstream commit, per-file hashes,
feature expectations, and first-visible characterization together.
