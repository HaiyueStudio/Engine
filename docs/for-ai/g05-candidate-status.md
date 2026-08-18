# G05 documentation candidate status

## State

- Candidate state: `ready-for-integration`.
- Scope: G05 documentation, manifest-backed samples, tutorials, support boundaries, and release-note candidate.
- Source base: `ddc9073bb57488586f6da6bd252c916c7ca7862e` plus the staged G05 patch.
- This is not a formal RC result. G07 must freeze a clean revision and replay required gates.
- No formal baseline, milestone status, release manifest, tag, push, or publication was changed.

## Delivered candidate

- Root and public-package READMEs now cover install, minimal usage, entry selection, browser/Node requirements, lifecycle, structured errors, license, and repository metadata.
- Engine, Editor, AnimationEditor, and HYA docs now identify the stable/experimental boundary and match current public exports and required native-3D HYA types.
- Manifest targets cover the release golden paths for 2D, 3D, glTF animation, HYA Tween/SpriteSheet/Path/Particle, HYA state machines, and complete games.
- `example:consumer-walkthrough` is the public Engine install → render → load asset → animate → dispose tutorial and verification fixture.
- Known limitations and troubleshooting explicitly cover WebGPU-only support, light/shadow capacities, NavMesh, HYA 2D/3D scope, unsupported diagnostics, HTTPS/LAN, adapter selection, worker/asset base paths, device loss, performance capture, and issue-report inputs.
- CHANGELOG, 0.1.0 release-note candidate, from-source verification, and contribution instructions are linked from the documentation indexes.

## Candidate verification

| Command | Result |
| --- | --- |
| `npm run docs:check` | passed |
| `npm run api:check` | passed; public API matches the frozen baseline |
| `npm run examples:catalog:check` | passed, 5/5 |
| `npm run examples:freshness:check` | passed, 84/84 targets fresh |
| `npm run build:examples` | passed, 84/84 targets built |
| `npm run build:games` | passed, all manifest games built |
| `npm run typecheck -w ./engine` | passed |
| `npm run typecheck -w ./animation-spec` | passed |
| `npm run typecheck -w ./AnimationEditor` | passed |
| `npm run typecheck -w ./examples` | passed |
| `npm run typecheck -w ./games` | passed |
| `npm run verify:engine-package` | passed; deterministic tarballs, offline install inputs, Node/TypeScript/export checks, and package provenance validated |
| `node examples/consumer-walkthrough/verify-browser.mjs` | passed over real HTTP in Chrome 150 on native WebGPU/Metal; 8 frames rendered and asset load, animation, disposal, HTTP provenance, and visual capture were verified |
| `node examples/consumer-walkthrough/verify-packed-consumer.mjs` | passed; a temporary clean consumer installed the packed `@haiyue/engine@0.1.0` tarball offline and completed the same lifecycle |

The in-app Browser backend reported no available browser. The repository's dedicated Chrome runner was therefore used for candidate proof; it exercised the built HTTP files and native WebGPU backend instead of substituting a synthetic DOM-only check.

## Deliberately pending evidence

- Windows Chrome/Edge and Windows integrated/discrete GPU evidence remain unchecked. They are G02/G04/G07 device-matrix work and are not claimed by this G05 candidate.
- G07 must replay browser and device evidence from the same clean, frozen revision. Missing Windows evidence remains a release no-go, but does not block integration of the G05 documentation candidate.
- `npm run check:fast` reaches the release-gate policy tests and then reports one expected cross-scope manifest-count assertion: the new smoke tutorial changes the smoke target count from 44 to 45. G05 cannot edit `scripts/release-gate-policy.test.mjs`; G07 must reconcile that shared policy after integrating the manifest change. The target must not be dropped or relabeled merely to preserve a static count.

> 2026-08-18：以上是 G05 handoff 时的历史状态。ADR 0080 随后取消 Apple/Windows 集显的独立 required correctness 类别；当前 required 集合以 `config/release-matrix.json` 为准。

## G07 integration handoff

1. Integrate G05 after G02 and G03, following `milestones/m02-first-public-release/integration.md`.
2. Reconcile the release content-policy count with the added manifest target, then rerun `npm run check:fast` without weakening target enrollment.
3. Freeze a clean revision and rerun docs/API/catalog/freshness, workspace typecheck, example/game builds, packed-consumer verification, and required macOS/Windows browser/device gates.
4. Rebuild the packed consumer from the frozen tarball; do not reuse this worktree's candidate artifact as formal evidence.
5. Review and freeze the release note only after the required evidence matrix is complete. Formal baseline promotion and final go/no-go remain G07-only actions.
