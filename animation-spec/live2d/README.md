# Live2D adapter area

This directory owns Live2D/Cubism-specific build tooling and license-isolated capture support. TypeScript adapters live in `../src/live2d/`; the preferred public facade is `@haiyue/animation-spec/live2d`. The legacy `./cubism` facade remains compatible.

- `bin/hya-live2d-convert.mjs` — drawable capture to HYA/HYDM CLI.
- `tools/capture-cubism.mjs` — headless build-time capture using a caller-supplied licensed Core/model.
- `samples/` — sample and license routing; Core, `.moc3`, and official models are not vendored.
