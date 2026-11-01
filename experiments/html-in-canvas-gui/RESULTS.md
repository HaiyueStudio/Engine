# Chrome HTML-in-Canvas and optimized Haiyue GUI stress results

Baseline: 2026-11-01  
Optimized native rerun: 2026-11-02  
Browser: Chrome for Testing 157.0.8103.15  
WebGPU adapter: NVIDIA / Pascal through ANGLE D3D11  
Viewport: 1280 × 720 at device scale factor 1

The browser was launched with `CanvasDrawElement` forced on so the executable configuration is explicit and repeatable. Each row used a fresh Chrome process. All cases passed WebGPU validation.

| Widgets | Changed per frame | HTML FPS | Native before FPS | Native optimized FPS | Native FPS gain | HTML frame p95 | Native before frame p95 | Native optimized frame p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 256 | 0% | 60.0 | 60.0 | 60.0 | 1.00× | 16.84 ms | 16.85 ms | 16.85 ms |
| 256 | 10% | 60.0 | 59.0 | 60.0 | 1.02× | 16.73 ms | 16.82 ms | 16.83 ms |
| 256 | 100% | 59.5 | 50.3 | 59.0 | 1.17× | 16.74 ms | 33.39 ms | 16.84 ms |
| 1,024 | 0% | 59.5 | 60.0 | 60.0 | 1.00× | 16.76 ms | 16.81 ms | 16.84 ms |
| 1,024 | 10% | 18.2 | 22.4 | 59.5 | 2.66× | 66.67 ms | 50.05 ms | 16.86 ms |
| 1,024 | 100% | 17.2 | 4.3 | 58.5 | 13.47× | 66.72 ms | 250.03 ms | 16.83 ms |
| 4,096 | 0% | 60.0 | 60.0 | 60.0 | 1.00× | 16.81 ms | 16.80 ms | 16.84 ms |
| 4,096 | 10% | 4.2 | 2.1 | 34.5 | 16.22× | 449.97 ms | 500.02 ms | 33.42 ms |
| 4,096 | 100% | 3.9 | 0.2 | 16.0 | 64.38× | 366.64 ms | 4,149.89 ms | 66.74 ms |

| Widgets | Changed per frame | Native update p95 before | Native update p95 optimized | Update speedup | Native task CPU/frame before | Native task CPU/frame optimized | CPU/frame speedup | Native setup memory before | Native setup memory optimized |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 256 | 0% | 0.01 ms | 0.01 ms | — | 3.03 ms | 3.21 ms | 0.94× | 7.7 MiB | 8.6 MiB |
| 256 | 10% | 4.59 ms | 0.75 ms | 6.11× | 16.87 ms | 11.29 ms | 1.49× | 8.4 MiB | 8.9 MiB |
| 256 | 100% | 15.54 ms | 4.61 ms | 3.37× | 27.89 ms | 16.42 ms | 1.70× | 8.4 MiB | 8.7 MiB |
| 1,024 | 0% | 0.01 ms | 0.01 ms | — | 6.54 ms | 7.88 ms | 0.83× | 12.3 MiB | 15.0 MiB |
| 1,024 | 10% | 23.46 ms | 1.50 ms | 15.64× | 62.44 ms | 16.65 ms | 3.75× | 14.6 MiB | 15.4 MiB |
| 1,024 | 100% | 228.04 ms | 6.28 ms | 36.28× | 306.15 ms | 25.32 ms | 12.09× | 14.6 MiB | 14.5 MiB |
| 4,096 | 0% | 0.01 ms | 0.01 ms | — | 33.28 ms | 15.56 ms | 2.14× | 26.6 MiB | 35.5 MiB |
| 4,096 | 10% | 419.74 ms | 2.55 ms | 164.60× | 643.79 ms | 42.80 ms | 15.04× | 31.2 MiB | 36.2 MiB |
| 4,096 | 100% | 4,069.71 ms | 22.15 ms | 183.73× | 9,106.00 ms | 86.06 ms | 105.81× | n/a | n/a |

The optimized 4,096-widget 100% case completed all 120 measured frames. The baseline exceeded ten minutes at 120 frames and used 30 measured frames; CPU comparisons are normalized per measured frame. Chrome's user-agent-specific memory API remains disabled for this heaviest case because attribution did not complete, but optimized JS heap setup measured 28.49 MiB and retained CPU geometry remained 12 MiB.

## Findings

### Static content is cheap when it is actually cached

Both paths remain around 60 FPS at 4,096 widgets when no values change. The HTML path uploads the `drawable` root once and reuses the WebGPU texture; the native path reuses retained GUI geometry. Re-uploading an unchanged DOM texture every frame was deliberately rejected as an unrealistic static baseline.

### HTML-in-Canvas cost sits outside the sampled WebGPU pass

The HTML WebGPU sampling pass remains below 0.2 ms p95, but that does not mean HTML rendering is free. At 4,096 dynamic widgets, the DOM-to-texture callback reaches roughly 160–300 ms p95, end-to-end queue completion reaches roughly 418–528 ms p95, and Chrome's GPU-process CPU time grows sharply. Chromium layout, paint, rasterization, and texture upload are not enclosed by a WebGPU timestamp query.

### Incremental native invalidation fixes the original bottleneck

The optimization changes the dominant native cost from repeated whole-tree work to bounded incremental updates:

- 1,024 widgets at 100% changes improve from 4.3 to 58.5 FPS; mutation p95 falls from 228.04 to 6.28 ms.
- 4,096 widgets at 10% changes improve from 2.1 to 34.5 FPS; mutation p95 falls from 419.74 to 2.55 ms.
- 4,096 widgets at 100% changes improve from 0.2 to 16.0 FPS; mutation p95 falls from 4.07 seconds to 22.15 ms.

The heaviest case now completes 120 measured frames instead of exceeding ten minutes. GPU pass p95 also falls from about 2.75 to 0.73 ms, showing that partial geometry and upload work reached the renderer rather than stopping at the public mutation API.

### The optimized native path now wins dynamic workloads

- At 256 widgets both paths remain effectively real-time.
- At 1,024 widgets and 10% or 100% updates, optimized native sustains about 59 FPS while HTML falls to 18 and 17 FPS.
- At 4,096 widgets and 10% updates, optimized native reaches 34.5 FPS versus HTML's 4.2 FPS.
- At 4,096 widgets and 100% updates, optimized native reaches 16.0 FPS versus HTML's 3.9 FPS. Neither is 60 FPS, so virtualization remains appropriate at this extreme.

### Incremental caches trade some memory for CPU scalability

The optimized native setup memory is slightly higher in most static/sparse cases. At 4,096 widgets it grows from 26.6 to 35.5 MiB for static content and from 31.2 to 36.2 MiB at 10% updates. Retained CPU geometry remains 12 MiB. The extra metadata/cache cost is justified by 15–106× lower task CPU per measured frame in the large dynamic cases, but it should receive a separate memory budget.

## Recommended engine direction

1. Keep the native renderer as the portable, deterministic default for game HUDs and frequently rendered engine-owned controls.
2. Prototype HTML-in-Canvas as an optional Chrome capability for rich text, forms, accessibility-heavy panels, and HTML-authored surfaces in 3D.
3. Never upload an unchanged HTML root. Drive uploads from the `paint` event and keep sampling the cached texture between changes.
4. Split large HTML GUI trees into independently drawable regions or a texture atlas so a small change does not upload the full 1280 × 720 root.
5. Keep the new incremental invalidation, retained command, and partial geometry/upload paths under regression budgets. The 1,024-control dynamic cases should remain near 60 FPS on this reference device.
6. Add a memory budget for incremental metadata and cached geometry; the 4,096-control setup delta should not grow silently beyond the current 35–36 MiB range.
7. Continue to treat 4,000 fully changing controls as a virtualization workload. Optimization makes it usable, but 16 FPS is still below a real-time GUI target.

## Measurement boundaries

- The HTML case uses one `drawable` root and one full-size texture. It does not yet test regional/atlas uploads.
- WebGPU timestamps cover only the render pass. Total hardware GPU utilization and total VRAM are not exposed through portable browser APIs.
- Chrome GPU-process CPU is recorded separately from hardware GPU time.
- Headless Chrome, ANGLE backend choice, GPU model, thermal state, and display refresh rate can change absolute numbers. Compare trends and rerun on target hardware before setting budgets.
- The HTML-in-Canvas API and `paint`/`changedElements` model follow the Chrome 157 documentation and the WICG proposal.

References:

- [HTML-in-Canvas in Chrome 157](https://developer.chrome.com/blog/html-in-canvas)
- [HTML in a WebGPU canvas](https://developer.chrome.com/docs/web-platform/html-in-canvas/webgpu)
- [HTML-in-Canvas technical concepts](https://developer.chrome.com/docs/web-platform/html-in-canvas/concepts)
- [WICG HTML-in-Canvas explainer](https://github.com/WICG/html-in-canvas)
