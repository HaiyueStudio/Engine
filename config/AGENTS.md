# Configuration and budget instructions

## Policy ownership

- Files here are machine-readable release and architecture policy, not convenient defaults. Keep schemas/version fields explicit and parse them through shared validators.
- `architecture-boundaries.json` is the dependency contract. Workspace/package moves update manifests, exports, source imports, docs, and boundary tests atomically.
- `release-matrix.json` owns device/browser requirements and content/release routing. Do not mark unavailable evidence optional merely to pass a local machine.
- Performance, package, editor-memory, lighting, and capability-admission budgets require representative evidence and reviewer-visible rationale.

## Changes

- Never raise a limit or narrow a scenario as the first response to a failing gate. Confirm implementation, measurement identity, workload, and validator before proposing a policy change.
- Adding a metric/scenario requires schema validation, a producing runner, an artifact validator, policy tests, and release wiring where the metric is release-critical.
- Keep device profiles honest. Do not record SwiftShader or one physical adapter as another device class.
- Capability decisions move from hold to prototype only through the evidence workflow in `docs/for-ai/capability-admission.md`.
- Shared Rollup configuration must preserve deterministic one-shot builds, output cleanup, and dynamic chunk boundaries across consumers.

## Validation

- Run the policy tests named by the consuming script, then `npm run performance-budget:test`, `npm run check:boundaries`, or `npm run release:artifact:check` as applicable.
- Budget/evidence policy changes require checking existing artifacts with the new validator; do not assume schema compatibility.

