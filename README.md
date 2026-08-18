# HaiyueStudio Engine

WebGPU-first Engine repository. It owns the runtime, optional extensions, HYA animation specification,
the build-time shader language, and manifest-backed engine examples.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Editor, Games, and other repositories consume packed or published package exports. They must not import
this repository's private `src/` paths.
