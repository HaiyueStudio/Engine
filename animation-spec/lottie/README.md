# Lottie adapter area

This directory owns Lottie-specific build tooling and sample routing. Runtime-neutral TypeScript lives in `../src/lottie/`; the stable public facade remains `@haiyue/animation-spec/lottie`.

- `bin/hya-lottie-convert.mjs` — Lottie JSON to HYA CLI (`hya-convert` remains a compatibility alias).
- `samples/` — points to publicly testable, license-declared comparison fixtures.

No Lottie player code is imported by the HYA parser or playback runtime.
