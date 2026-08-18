# M2.5 G08 package file-count review

The integrated `@haiyue/engine` tarball contains 549 files, 1,793,911 packed bytes, and 7,929,542 unpacked bytes. The prior file-count ceiling was 535; packed and unpacked byte ceilings remain unchanged and pass.

The 14-file increase is an intentional generated-output consequence of the reviewed M2.5 owners and entrypoints, not leaked source or evidence:

- G04: `ParameterizedRendererCore` declaration ownership;
- G05: `AsyncPrimitives`, `WorkerChannel`, focused `experimental/async`, and the side-effect-only KTX2 worker runtime entry;
- G06: private `ComputeResourceAccess` and `GuiVertexLayout` declarations.

G08 removed both production SceneBatch declaration files after the candidate failed the performance threshold and its diagnostic-only integration breached the frozen editor bundle headroom. The reproducible candidate now lives under `scripts/benchmark/` and is excluded from every public package.

The package verifier confirmed that every tarball path still matches the existing `README/LICENSE/dist .js/.d.ts` allowlist, repeated pack hashes are deterministic, all exports load in Node and TypeScript, and real npm installation succeeds. Consumer closure remains below every unchanged gzip budget:

| Consumer | Observed gzip | Existing ceiling |
| --- | ---: | ---: |
| root golden path | 47,679 B | 60,000 B |
| FXAA only | 11,547 B | 14,000 B |
| geometry only | 12,886 B | 15,000 B |
| tween only | 4,442 B | 9,000 B |
| worker URL only | 2,867 B | 21,000 B |

The file-count ceiling is therefore reset to the exact reviewed integrated count, 549, in both the public-package and legacy tarball policy fields. No byte, consumer bundle, source allowlist, or forbidden-file limit is relaxed.
