# M02 G01 release scope and API refreeze

Freeze input revision: `aa31a21328cea068ee4d269ac19e135274407ead`
Freeze date: 2026-08-17  
Working tree at verification: clean

## Decision

The 0.1.0 release contract is refrozen after M2.5 runtime convergence. The
single machine-readable scope remains `review/api/release-manifest.json` and
contains nine independently recoverable release units:

- public npm: `@haiyue/engine`, `@haiyue/animation-spec`,
  `@haiyue/extensions`;
- applications/catalogs: Scene Editor static, AnimationEditor static, Voxel
  Editor PWA, unsigned Windows Electron preview, examples catalog, games
  catalog.

`@haiyue/ui`, `@haiyue/shader-language`, and all editor workspaces remain
private. The feature freeze remains active; only P0/P1 release blockers may
change behavior before G07.

## API and format classification

- `npm run api:check` reports no unclassified diff.
- The M2.5 public-surface changes were reviewed as intentional in
  `review/m025/g08-api-format-review.md`; accidental/private leaks were removed
  before this freeze.
- Engine root remains the exact golden path. Stable domain subpaths,
  experimental focused subpaths, and private package files retain the accepted
  stability split.
- HYA core/container, AnimationEditor project, GUI persistence and Shader
  Artifact versions remain independent from npm/app version 0.1.0.
- Windows browser support begins at Windows 10 22H2. Rendering performance uses
  the portable same-host comparison and does not require a named GPU model;
  browser correctness and the Windows discrete hardware boundary remain required.

## Verification

| Command | Result |
| --- | --- |
| `npm run api:check` | passed |
| `npm run check:boundaries` | passed; 412 engine modules, no workspace boundary violations |
| `npm run release:scope:check` | passed; three public packages and six app/catalog artifacts |
| `npm run docs:check` | passed |
| `npm run release:artifact:check` | passed immediately before the documentation-only M2.5 completion commit; package/API/runtime inputs are unchanged |

G02–G06 may consume this scope as a read-only input. Formal browser,
performance, screenshot, HYA and RC evidence is intentionally not claimed by
G01 and must bind the later G07 frozen revision.

## Freeze amendment

The initial refreeze at `f4e36f8` was reopened only for the P1 browser
correctness fix `aa31a21`. Final G02 replay found that AnimationEditor kept the
previous READY marker while a 2D/3D template preview was rebuilding, allowing
automation and assistive status consumers to read a stale frame. The fix makes
queued/rebuilding previews enter LOADING synchronously and makes the designer
acceptance wait for template activation before editing history. It changes no
public package/API, release unit, data format, support tier or baseline.

On 2026-08-18, ADR 0080 amended only the hardware support matrix: Apple and
Windows integrated GPUs are no longer independent 0.1 correctness targets,
while Chrome/macOS, Windows 10 Chrome/Edge, native hardware WebGPU and the
Windows discrete boundary remain required. This changes no release unit or API.

ADR 0081 then amended the browser support tier: 0.1 required browser coverage
is Windows 10 Chrome/Edge, while Chrome/macOS is extended. Native hardware
WebGPU and the Windows discrete boundary remain required. The final release
evidence must be replayed after this support-contract commit.
