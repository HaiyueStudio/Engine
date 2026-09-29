# Editor dependency installation repair

2026-09-27. Resolved installation failure; consumer policy unchanged.

The Editor manifests already declared TypeScript (`^5.2.0`, lockfile `5.9.3`). Local `node_modules/typescript` was an empty/incomplete directory; other installed packages were also missing their package files. This was an incomplete installation, not a missing declared TypeScript dependency.

Reinstalled with `npm ci --include=dev --cache=/private/tmp/haiyue-editor-npm-cache --no-audit --no-fund`. The final installation restored all 401 lockfile packages. Editor `npm ls typescript --depth=0`, repository/workspace boundaries, dependency compatibility and minimum-version checks passed; Engine's aggregated `check:boundaries` also passed. No Editor manifest, lockfile or source changes remain (`git status --short` is empty).

A separate product typecheck revealed that the published `@haiyue/extensions@0.1.0` lacks the `./ray-tracing` export used by `RayTracingPreviewOwner.ts`. Locally built candidate tarballs with the same nominal version have a different export surface. A temporary no-save installation investigated that difference, then the original lockfile installation was restored. The user explicitly chose **installation repair only; continue Engine G04**. Engine/Extensions consumer constraints remain `>=0.1.0 <0.2.0`; no upgrade, candidate tarball substitution, Editor product compatibility qualification or release was performed.

Final checks and their hashed logs are indexed in the G04 compatibility audit evidence. The previously recorded missing-TypeScript failure in [the shader optimization report](g04-budget-import-application.md) remains historical and is now resolved by this repair. Engine release gates remain independent of Editor product acceptance.
