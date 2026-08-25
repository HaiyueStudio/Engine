# HYA Live2D corpus dashboard

This dashboard is the license-safe Live2D counterpart to `hya-lottie-corpus-dashboard`.
It renders the checked-in HaiYue-owned MIT drawable-capture fixture through the
source-neutral HYA + HYDM runtime. Its capability table consumes the G16
validator-generated `samples/feature-status.json` and keeps implementation
status separate from licensed-corpus coverage.

Official Live2D sample models are intentionally not copied into the repository.
The manifest keeps them as license-gated links: users must accept the applicable
Live2D license and run the local capture workflow before such a model can become
corpus evidence. The checked-in status contains only hashes, counts, browser
metrics, and license links; it does not contain model, texture, Core, or pixel
reference bytes.

Replay the licensed feature candidate after building the comparison example:

```bash
node scripts/verify-live2d-local-corpus.mjs \
  --model niziiro-mao=<mao-runtime-directory> \
  --evidence-action niziiro-mao=Idle:0 \
  --evidence-time niziiro-mao=1 \
  --model rice-glassfield-pro=<rice-runtime-directory> \
  --evidence-action rice-glassfield-pro=Tap%40Body:0 \
  --evidence-time rice-glassfield-pro=0.75 \
  --out review/candidates/live2d-drawable-color-culling-local-report.json
node scripts/verify-live2d-drawable-fidelity-corpus.mjs \
  --manifest animation-spec/corpus/deformable2d/drawable-color-culling-corpus-manifest.json \
  --report review/candidates/live2d-drawable-color-culling-local-report.json \
  --out review/candidates/live2d-drawable-color-culling-corpus-candidate.json \
  --dashboard-out examples/hya-live2d-corpus-dashboard/samples/feature-status.json
```

Regenerate the checked-in HYA/HYDM delivery assets after building
`@haiyue/animation-spec`:

```bash
node examples/hya-live2d-corpus-dashboard/generate-assets.mjs
```
