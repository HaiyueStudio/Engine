# HTML-in-Canvas versus Haiyue native GUI

This experiment compares two WebGPU GUI presentation paths under the same viewport, widget count, and mutation ratio:

- `html`: browser HTML/CSS layout in a single `drawable` subtree, uploaded with `GPUQueue.drawElementImageToTexture()`, then sampled by a WebGPU fullscreen pass.
- `native`: Haiyue `GuiRoot`, `GuiElement`, `GuiLabel`, `GuiProgress`, and `GuiRenderer` rendered directly with the engine's retained WebGPU GUI path.

The default matrix covers 256, 1,024, and 4,096 widgets with 0%, 10%, and 100% of widgets changed per frame. Every mode/case runs in a fresh Chrome process so JS heaps, DOM nodes, browser process CPU time, and GPU resources do not leak between cases.

## Run

```powershell
node experiments/html-in-canvas-gui/run.mjs
```

Use `--smoke` for a short functional pass. Set `CHROME_PATH` or pass `--browser=<path>` to pin the exact Chrome build. The runner enables `CanvasDrawElement` explicitly so it can also characterize pre-stable Chromium builds that contain the implementation behind the flag.

Results are written to `artifacts/performance/html-in-canvas-gui-comparison.json` and a sibling Markdown report.

See [RESULTS.md](./RESULTS.md) for the checked-in Chrome 157 comparison and recommendations.

After rerunning an optimized native bundle, generate the three-way HTML/native-before/native-after report with:

```powershell
node experiments/html-in-canvas-gui/compare-optimization.mjs
```

The original Chrome 157 baseline is retained in `baselines/chrome-157-2026-11-01.json` so this comparison does not depend on ignored `artifacts/` contents.

## Reported channels

- rAF frame interval, effective FPS, and missed-frame ratio.
- Page update CPU, native layout/rebuild CPU, HTML texture-upload call CPU, and WebGPU encode/submit CPU.
- Chrome renderer/browser/GPU-process CPU-time deltas via CDP.
- Style recalculation, layout, script, task, and JS heap deltas via CDP performance metrics.
- User-agent-specific memory when Chrome exposes `measureUserAgentSpecificMemory()`.
- GPU render-pass timestamps when the adapter exposes `timestamp-query`.
- End-to-end queue completion latency in an isolated probe.
- Explicit WebGPU texture bytes and native retained CPU geometry bytes.

GPU timestamps cover the WebGPU render pass. Chromium's DOM rasterization and `drawElementImageToTexture()` upload are not enclosed by a WebGPU timestamp query, so their impact is represented by end-to-end queue latency, process CPU, layout/style time, and frame cadence rather than mislabeled as shader time. Browser APIs do not expose total VRAM use or hardware GPU utilization; the report therefore records explicit resource bytes and GPU time instead.

## Interpretation boundaries

This is a GUI stress comparison, not a claim that the two renderers provide identical typography or accessibility. HTML-in-Canvas retains DOM semantics and browser layout; the native path keeps engine-owned layout and rendering. Static and highly dynamic cases should be interpreted separately because both implementations have different cache invalidation boundaries.

Primary API references:

- [Chrome for Developers: HTML-in-Canvas overview](https://developer.chrome.com/docs/web-platform/html-in-canvas)
- [Chrome for Developers: HTML in WebGPU canvas](https://developer.chrome.com/docs/web-platform/html-in-canvas/webgpu)
- [WICG HTML-in-Canvas explainer](https://github.com/WICG/html-in-canvas)
