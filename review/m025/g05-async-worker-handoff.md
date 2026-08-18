# M2.5 G05 async/Worker/asset handoff

- Goal / source revision / candidate revision: `g05-async-worker-asset-substrate`; source `d21688a`; candidate is the clean commit containing this handoff.
- Changed owners:
  - Request identity, version validation, unknown response validation, transferables, AbortSignal, latest-wins, bounded pending work, `error`/`messageerror`, fault retirement and idempotent termination: Asset/KTX2/glTF/Spine client copies -> `engine/src/async/WorkerChannel.ts`.
  - AbortError, priority normalization and monotonic time: per-asset/extension helpers -> `engine/src/async/AsyncPrimitives.ts`.
  - Worker-first/fallback orchestration: KTX2, glTF and Spine local try/catch state machines -> `parseAssetWorkerFirst`; an allowed infrastructure fallback always emits a structured diagnostic.
  - Asset phase and terminal state: `AssetManager.record.jobState` mirror -> the `AssetJob` transition table and methods.
  - KTX2 worker execution: inline source importing the assets facade -> dedicated `@haiyue/engine/experimental/ktx2-worker-runtime` entry.
- Deleted duplicate state machines/files/branches:
  - Removed pending maps, request counters, abort listeners, response dispatch and dispose loops from AssetWorkerClient, Ktx2TextureWorkerClient, GltfAssetWorkerClient and SpineAssetWorkerClient.
  - Removed duplicated glTF/Spine/KTX2 AbortError, priority and monotonic-clock helpers.
  - Removed direct `jobState` storage/writes from AssetManager and the KTX2/glTF/Spine worker-first branches.
  - Removed the KTX2 inline worker's dynamic self-import of the experimental assets facade.
- Public API / format / package diff:
  - Stable API and glTF/Spine/KTX2 payload semantics: unchanged.
  - Intentional experimental additions: `@haiyue/engine/experimental/async` and the side-effect-only `@haiyue/engine/experimental/ktx2-worker-runtime` entry. The compatibility experimental aggregate also exposes the small async contract.
  - G08 must promote the reviewed API snapshot; G05 did not run `api:update` and did not modify the API baseline.

## Consumer migration matrix

| Consumer | Payload owner | Shared channel behavior | Fallback policy |
| --- | --- | --- | --- |
| AssetWorkerClient | fetch URL/init and result type validator | version, transfer body, abort, fault retirement, dispose | none |
| Ktx2TextureWorkerClient | KTX2 buffer/features/options and payload validator | version, transferable input/output, fault retirement | explicit infrastructure-only main-thread parser through `parseAssetWorkerFirst` |
| GltfAssetWorkerClient | source/Draco config and parsed-asset validator | version, abort, malformed payload retirement | explicit infrastructure-only production parser through `parseAssetWorkerFirst` |
| SpineAssetWorkerClient | JSON/atlas URLs and parsed-asset validator | version, abort, error/messageerror retirement | explicit infrastructure-only production parser through `parseAssetWorkerFirst` |

The KTX2 pool remains the capability-owned concurrency dispatcher. It is bounded to 64 queued jobs per worker and emits `ktx2.workerPool.queue` instead of growing without limit.

## Fault, abort and dispose trace

| Injection | Required classification/result | Result |
| --- | --- | --- |
| abort before send | AbortError; messages `0` | passed |
| abort in flight / source replacement | versioned cancel; late reply ignored | passed |
| out-of-order replies | resolve by request identity | passed |
| latest-wins replacement | stale generation rejects AbortError | passed |
| channel/KTX2 queue overflow | structured WorkerProtocolInvalid diagnostic | passed |
| response version mismatch / invalid unknown | channel faults, pending work retires | passed |
| worker `error` / `messageerror` | structured path, all pending reject, terminate once | passed |
| repeated dispose | listeners/pending `0`, terminate once | passed |
| AssetJob illegal phase | structured `E_ASSET_INVALID_DATA`, no state mutation | passed |
| real worker teardown/device recovery | GPU/CPU resource residual `0` | passed real WebGPU gate |

## Validation

- `npm run typecheck -w ./engine`; full engine test: 530 passed; engine build: passed.
- `npm run typecheck -w ./extensions`; full extensions test: 159 passed; extensions build: passed.
- Focused Worker/Asset/KTX2/glTF/Spine suite: 86 passed.
- `npm run asset-script:check`; `npm run modules:check` (409 modules); `npm run responsibilities:check`; `npm run lifecycle:check`; `npm run check:boundaries`: passed.
- `npm run verify:gltf-asset`: 3 production tiers passed in real WebGPU; GPU validation/resource residual failures `0`.
- Packed consumers resolved every public export and stayed within their bundle closures after moving extension imports to `experimental/async`: glTF `78,621 B` gzip, glTF Animation3D `45,913 B`, Spine `69,112 B`.
- The package verifier's only remaining failure is cumulative engine/tarball file count `547 > 535`; no unexpected consumer closure, missing export or runtime import failure remains. G08 owns the integrated file-count review because G04 and G05 both add legitimate source/entry files.
- `npm run api:check` reports only the intentional experimental contract additions; API snapshot promotion is reserved for G08.

## Worker URL / base-path evidence

- The KTX2 inline factory now generates only `import "<explicit worker entry URL>";`; parser/transcoder code lives in the dedicated module-worker entry.
- Both real glTF fixture import maps explicitly map `@haiyue/engine/experimental/async`; the KTX2 worker URL resolves `/engine/dist/experimental/ktx2-worker-runtime.js` relative to the served base.
- Packed all-export import is Node-safe; the worker entry installs its handler only when the worker messaging globals exist.
- The packed-engine verifier confirmed the new exports and all real consumer bundles. This diagnostic run is not formal release evidence.

- Deferred or blocked items: API snapshot and cumulative tarball file-count budget promotion require G08's integrated review. No runtime implementation item is deferred.
- Follow-up required from G08: review/promote the intentional experimental API diff, set the integrated package file-count budget to the final post-G07 value, then replay packed consumers and the real WebGPU glTF gate from the clean integration revision.
