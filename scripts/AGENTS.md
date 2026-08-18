# Scripts and gates instructions

## Gate design

- Scripts are release infrastructure. Keep them deterministic, non-interactive by default, path-safe, and explicit about prerequisites, selected tier/profile, target IDs, output path, and failure cause.
- A gate validates an existing contract; do not weaken thresholds, remove cases, skip unsupported failures, or change metric populations merely to restore green.
- Policy/config parsing and artifact validation belong in importable side-effect-free modules with `node:test` coverage. CLI wrappers orchestrate and report.
- Reuse `build-rollup-once.mjs`, shared Chrome/server helpers, shared GPU audit device, and existing validators instead of adding one-off process/build/mock implementations.

## Evidence and browser rules

- Bind artifacts to schema, revision, dirty state, source/config fingerprints, runner/device identity, workload, sample settings, and generation time as required by policy.
- Smoke/diagnostic execution cannot overwrite formal full evidence. Formal CPU/GPU evidence is promoted only from the registered clean runner and then revalidated.
- Browser fixtures are served over HTTP(S), verify expected byte length/hash/provenance for real assets, collect validation errors, and close pages, servers, and Chrome processes in `finally` paths.
- `timestamp-query` or another optional device feature may report a structured unavailable reason only when policy permits it; absence must not erase other correctness checks.
- CPU benchmark cases use the shared versioned `MockGpuDeviceCapabilities`/audit device and include setup smoke so new runtime API requirements fail locally and clearly.
- Preserve separate CPU runtime, GPU timing, queue wait, upload, draw/pass, allocation, and residual-resource channels. Do not combine them into a number that hides the failing owner.

## CI/content routing

- Content sets come from `examples/manifest.json` and `games/manifest.json`: PR/main uses smoke; nightly and local/global release use full (including smoke); manual targets are never automatically consumed.
- Keep logs and artifacts actionable: exact tier, target count/IDs, adapter/profile, case, metric, budget, observed value, and unavailable/failed classification.

## Validation

- Run the focused `node --test` policy file for every changed gate or validator.
- Gate orchestration changes require `npm run fast-gate-policy:test`, `npm run benchmark:policy:test`, or the matching release/WebGPU policy tests.
- Finish with the narrow command the script owns before using `check:fast` or slow tiers.

