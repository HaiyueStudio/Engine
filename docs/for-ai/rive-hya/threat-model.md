# Threat model：untrusted `.riv`、Luau、WGSL 与 assets

状态：Accepted for tuple `rive-7.3-webgl2-2.40.0`。

## Trust boundaries

不可信：`.riv` bytes、ToC、所有 object/property、embedded/referenced/hosted assets、font tables、image/audio/compressed texture、Luau source/bytecode、custom WGSL、URL/redirect/headers、Marketplace/user metadata 和 oracle output。

可信但仍校验：HaiYue converter/IR/compiler、固定哈希的 official oracle package、schema validators、worker/process protocol。用户在 Editor 中打开或拥有文件不提升其 trust level。

ADR 0013 只接受项目作者主动启用的 trusted-project JavaScript capability。Rive asset 可以来自第三方、Marketplace、下载或 hosted URL，因此不得进入该 realm，也不得继承 DOM、network、filesystem、storage、ambient credentials、main-thread JS 或 unrestricted GPU 权限。

## Assets at risk

- developer workstation、CI secret、Editor session/project 与用户文件；
- browser main thread、origin credentials、network and storage；
- CPU/heap/worker pool、GPU device/queue/memory、audio device；
- HYA output integrity、diagnostics/provenance、oracle evidence；
- hosted third-party services and licenses。

## Threats and required controls

| Threat | Example | Mandatory control | Stable failure |
| --- | --- | --- | --- |
| parser memory corruption/overflow | crafted varuint, truncated ToC, huge count | memory-safe reader or isolated native process; checked arithmetic; bounds before allocation | `E_RIVE_VARINT_OVERFLOW`, `E_RIVE_TOC_INVALID`, `E_RIVE_LIMIT_EXCEEDED` |
| decompression bomb | tiny PNG/font/audio expands to GiB | compressed and decoded byte/pixel/glyph/sample ceilings; streaming abort | `E_RIVE_ASSET_DECODE`, `E_RIVE_LIMIT_EXCEEDED` |
| graph explosion/cycle | recursive nested artboards, list/layout expansion | inventory pass before materialization; depth/count/instance budgets; typed cycle rules | `E_RIVE_REFERENCE_CYCLE`, `E_RIVE_LIMIT_EXCEEDED` |
| SSRF/credential leakage | hosted asset redirects to localhost/cloud metadata | default network off; explicit HTTPS origin allow-list; no cookies/auth/referrer; redirect/IP recheck; private/link-local/loopback deny | `E_RIVE_ASSET_URL_POLICY` |
| path traversal | asset name `../../...` | content-addressed resolver; no source-controlled filesystem path; normalized virtual IDs | `E_RIVE_ASSET_URL_POLICY` |
| Luau escape | request OS/network/DOM, VM bug | dedicated worker or process; minimal standard library; typed capability ports only; no dynamic native module loading | `E_RIVE_SCRIPT_CAPABILITY`, `E_RIVE_SCRIPT_PROTOCOL` |
| CPU/heap/event DoS | infinite loop, recursive event, list output | instruction hook, wall deadline, heap/call/output/event budgets; killable owner | `E_RIVE_SCRIPT_BUDGET` |
| nondeterminism | ambient time/random, promise race | injected integer-microsecond clock, seeded PRNG, ordered message queue, deterministic asset resolver | `E_RIVE_SCRIPT_PROTOCOL`, `E_RIVE_ORACLE_MISMATCH` |
| WGSL/device abuse | huge storage buffer, invalid binding, long shader | independent parser/validator; entry/binding/format/usage allow-list; source/resource ceilings; compilation timeout; disposable device owner | `E_RIVE_SHADER_INVALID`, `E_RIVE_SHADER_BINDING`, `E_RIVE_SHADER_BUDGET` |
| shader ABI injection | custom code concatenated with production WGSL | separate pipeline/module and bind groups; no textual concatenation; source-neutral typed protocol | `E_RIVE_SHADER_BINDING` |
| audio abuse | autoplay, ultrasonic/high gain, many voices | no playback during import; offline schedule oracle; user-gesture runtime resume; gain/voice/sample budgets; owner stop | `E_RIVE_LIMIT_EXCEEDED` |
| stale async writeback | reimport/close while fetch/decode/script runs | unique job token + AbortSignal; generation check on every result; idempotent dispose; late result dropped with accounting | `E_RIVE_ABORTED` |
| diagnostic exfiltration | secret URL/token/script in error | bounded/redacted context; hashes and virtual IDs; no raw source/headers/private path | `E_RIVE_INTERNAL` |
| supply-chain drift | mutable source branch/package | tuple hashes, npm integrity/signature/provenance, offline cache, no semver range | `E_RIVE_ASSET_INTEGRITY` |

## Required isolation architecture

```text
Editor/CLI owner
  ├─ validates manifest, tuple, rights and input byte limits
  ├─ launches disposable import worker/process
  │    ├─ bounded `.riv` reader/evaluator
  │    ├─ content-addressed asset resolver (network disabled by default)
  │    ├─ Luau sandbox owner (no ambient capabilities)
  │    └─ WGSL validator on a separate limited compilation path
  └─ accepts only versioned, validated NeutralAnimationIR chunks
       └─ HYA compiler writes only after complete success
```

Native official runtime code, if used rather than a memory-safe reader, must run in a killable process with no project filesystem, no inherited network credential, no child-process right, bounded job object memory/CPU, and a versioned byte protocol. A Worker alone is insufficient for memory-unsafe native/WASM escape assumptions; it is only the browser responsiveness/ownership boundary.

## Luau capability contract

- default-deny libraries; no `os`, `io`, `debug`, dynamic loading, HTTP, filesystem, clipboard, DOM, storage, crypto keys or host global access。
- host APIs are versioned typed ports for math, local data context, bounded geometry/paint command emission, deterministic event input and declared asset handles。
- every tick gets immutable clock/input/data snapshots and returns bounded commands; no direct mutation of Engine/ECS/renderer objects。
- promise/async completion is tied to owner generation and deterministic queue order。abort kills or discards the VM; `dispose` is idempotent。
- bytecode is not trusted merely because it was produced by Rive Editor; validate version and load only into the frozen VM revision。

## WGSL contract

- parse and validate complete modules; forbid textual injection, preprocessor-like includes and dynamic URL imports。
- allow only declared entry points and bind groups; forbid host production groups, external textures unless declared, timestamp queries, atomics/storage writes beyond protocol and unbounded workgroup/resource dimensions。
- custom output is composited through a source-neutral intermediate texture/mesh/paint command, not a pointer to internal GPU resources。
- pipeline/device loss/fence completion belongs to the sandbox program owner; timeout or device loss cannot leave cached pipelines/buffers in global registries。

## Verification

- adversarial corpus covers truncated/overflow/duplicate keys, cycles, decompression bombs, malicious font tables, redirect rebinding, infinite Luau, promise storms, output amplification, invalid/expensive WGSL, device loss, abort/reimport/close and late results。
- tests assert peak memory/CPU/output and owner residual, not only diagnostic text。
- browser closure scan confirms no Rive parser/runtime/Luau VM or raw `.riv` in shipped player。
- security review is reopened for any tuple, sandbox engine, decoder, network policy or GPU binding change。

