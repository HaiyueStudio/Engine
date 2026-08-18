# Cross-engine performance comparison instructions

- This directory is a portable, same-machine comparison suite. It does not replace focused engine regression benchmarks or correctness gates.
- Keep scene semantics in `scene-contract.mjs`; adapters may use each engine's normal optimized path, but must report backend, object/triangle/material/light counts and any implementation-specific draw count that is available.
- Ranked results require native WebGPU, exact viewport/DPR parity, successful visual sanity checks, the same workload, and all required WebGPU adapters in the same run. WebGL results are informative and never enter the WebGPU ranking.
- Never check local result JSON into Git. Candidate reports belong in `data/local/`; formal promotion remains a reviewed G07 operation from a clean revision.
- Dependency versions are pinned exactly in the root lockfile. Do not load benchmark engines from a CDN.

