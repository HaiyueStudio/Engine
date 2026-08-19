# HYA Live2D corpus dashboard

This dashboard is the license-safe Live2D counterpart to `hya-lottie-corpus-dashboard`.
It renders the checked-in HaiYue-owned MIT drawable-capture fixture through the
source-neutral HYA + HYDM runtime and reports the capabilities exercised by that
fixture.

Official Live2D sample models are intentionally not copied into the repository.
The manifest keeps them as license-gated links: users must accept the applicable
Live2D license and run the local capture workflow before such a model can become
corpus evidence.

Regenerate the checked-in HYA/HYDM delivery assets after building
`@haiyue/animation-spec`:

```bash
node examples/hya-live2d-corpus-dashboard/generate-assets.mjs
```
