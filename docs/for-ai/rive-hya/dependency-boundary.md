# Dependency, package and ownership boundary

## Allowed dependency flow

```text
untrusted bytes/assets
        │
        ▼
@haiyue/animation-spec/rive        build-time adapter, frozen Rive knowledge
        │ emits NeutralAnimationIR@1
        ▼
@haiyue/animation-spec/*           source-neutral schemas/codecs/compiler
        │
        ├──────────────► @haiyue/extensions/animation-*   optional runtime capabilities
        │
        └──────────────► packed candidate ───────────────► AnimationEditor

official @rive-app/webgl2@2.40.0 ─► test oracle only
                                    ✕ no edge to browser HYA player
```

`animation-spec` remains an independent foundation and cannot import extensions、Engine、Editor、Games or AIStudio. Extensions consume public focused subpaths. Editor consumes published/packed packages only.

## Public surface decisions

- no change to `@haiyue/engine` root exports or its golden path。
- future Rive reader/evaluator entry is the focused `@haiyue/animation-spec/rive` subpath；it does not re-export official Rive classes, type keys or WASM handles。
- neutral IR is build-time and versioned；runtime public contracts are the neutral extension majors in the compatibility tuple。
- optional layout/data/interaction/audio/script runtimes live under focused `@haiyue/extensions/*` subpaths, never engine core merely because Rive needs them。
- provenance containing Rive keys is a conversion report only and cannot be required to play HYA。

## Packed-candidate and version policy

Cross-repository integration uses this serial protocol：

1. Engine candidate is built from a clean revision with Node 22+。
2. `npm pack` each changed public package；record package name/version、tarball SHA-256、`exports` and declaration hashes。
3. Editor installs exact package versions/tarballs for validation；no `file:`、workspace source path、GitHub branch or semver range is accepted as integration evidence。
4. packed consumer runs typecheck/build/import/save/reopen/export E2E against the candidate。
5. publication/version promotion happens only in G13 after API、boundary、bundle and closure checks。

The build-time oracle is separately content-addressed and is not a package dependency of any released HaiYue package。

## Lifecycle ownership

| Resource | Unique owner | Required terminal behavior |
| --- | --- | --- |
| import job/reader/evaluator | Editor/CLI import generation | abort and dispose idempotent；no partial HYA rename/commit |
| external fetch/decode | import asset resolver | abort fetch/decode；drop late result；release buffers |
| native/WASM evaluator | disposable worker/process job | terminate on budget/abort；no inherited credential or global cache |
| Neutral IR chunks | import generation | validate before accept；free on failure；cannot write after generation changes |
| Artboard/layout/list instances | runtime scene/asset instance | bounded recursion/list；reverse-order dispose |
| font/image/audio handles | HYA asset owner | ref-count only within owner tree；stop/release on close/reimport |
| Luau VM/program | sandbox program owner | kill/abort on capability or budget failure；clear promises/events |
| WGSL module/pipeline/GPU objects | sandbox GPU owner | separate cache namespace；release on device loss/dispose |
| oracle canvas/audio/semantic overlay | evidence run | reset between cases；no state leakage across traces |

Every async result carries owner id and generation。`destroy`、`dispose`、`release` and `abort` are idempotent；owner destruction makes late results unobservable except bounded diagnostics/metrics。

## Browser closure

G13 scans packed tarballs, final bundles, chunks, source maps, static strings and browser network against [`browser-runtime-deny-list.json`](./browser-runtime-deny-list.json)。Required result：

- forbidden package/file/static/network count = 0；
- raw `.riv` payload count = 0；
- Rive object/property dispatch in player = 0；
- official Rive/Luau runtime bytes in player = 0；
- HYA neutral runtime continues to work with build-time adapter/oracle removed。

