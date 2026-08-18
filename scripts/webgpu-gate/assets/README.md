# Stage 11 representative glTF asset

`stage11-dynamic-uv-character.gltf` is a checked-in, self-contained glTF 2.0
asset used by the real Chrome/WebGPU first-visible-frame gate. It is fetched
from the same static server as a production asset; it is not assembled inside
the benchmark.

The fixture was authored for Haiyue and is released under CC0-1.0. It contains
only the contract-bearing data needed by the gate: an indexed quad, ordinary
PNG base-color and normal textures, `TEXCOORD_2` and `TEXCOORD_5`, one morph
target, one skin joint, and one animation. Keeping the fixture minimal makes
baseline changes reviewable while still exercising fetch, parse, image decode,
mipmap generation, GPU upload, pipeline warmup, rendering, and teardown.
