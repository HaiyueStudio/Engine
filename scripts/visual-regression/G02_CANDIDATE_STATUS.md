# G02 browser regression candidate

Candidate evidence HEAD: `58f00e44e3b490a2dd7a354b69d93f3cc8911053`

## Current state

- `chrome-macos`: extended under ADR 0081; no 0.1 release pass is claimed.
- `chrome-windows`: passed on Chrome 151 with native D3D11 WebGPU on Windows 10 22H2 and an NVIDIA Pascal discrete GPU.
- `edge-windows`: passed on Edge 151 with native D3D11 WebGPU on the same Windows 10 host.
- `windows-discrete`: passed through both required Windows browsers.
- ADR 0080 removes Apple/Windows integrated GPU classes from the 0.1 required correctness matrix; historical diagnostic profiles remain available but are not release handoffs.
- Unclassified failures: 0.
- GPU validation errors: 0.
- Owner residuals: 0.
- Formal baseline updates: none.

The Windows candidate passed `check:fast`, slow smoke/full, the nine AnimationEditor browser fixtures, the VoxelEditor browser smoke, and the Scene Editor release lifecycle browser E2E. Chrome and Edge product replay reported zero unclassified failures, GPU validation errors, and owner residuals. All browser fixtures use HTTP and candidate evidence records current source byte lengths and SHA-256 hashes.

## Candidate pixel diff

The HTTP Fog candidate now matches `review/baselines/render-pixels-fog.json` with no mismatch. The current replay remains under `artifacts/webgpu/fog-http-candidate/`; no file under `review/baselines/` was changed.

## G07 handoff state

The 0.1 required browser/device matrix has no remaining handoff. Verify it with:

```text
node scripts/verify-m02-g02-candidate.mjs --require-all-devices
```

The current candidate passes both normal and strict G02 validation. Windows discrete correctness is represented by the passed Chrome/Edge evidence; macOS remains extended and is not represented as passed.
