# Documentation instructions

## Audience and ownership

- Follow `for-ai/documentation-conventions.md`.
- `for-ai/` owns internal architecture, invariants, ADRs, performance and release contracts; `engine-guide/` and `editor-guide/` are task-oriented user guides; `api/` documents symbols, parameters, errors, and stability.
- Do not copy volatile progress into stable architecture pages. Put current measurements/status in the established evidence/review location and link to it.
- Public signatures are authoritative in built declarations and `package.json#exports`; docs must not invent APIs or show private-source imports.

## ADR and guide policy

- Accepted ADRs are historical decisions. Supersede them with a new ADR instead of rewriting the original decision; update the ADR index and cross-links.
- Architecture or package-boundary changes require an ADR. A routine implementation detail does not need one.
- Guides use stable APIs by default. Clearly label experimental APIs and link to a runnable manifest-backed example or game.
- Keep filenames lowercase kebab-case except existing product-standard files. Every documentation directory maintains a README/read order.
- Use repository-relative links and update moved links, indexes, error `docsPath`, examples, and code snippets atomically.
- Do not claim a feature, backend, performance result, or release state that current code and validated evidence do not support.

## Validation

```bash
npm run docs:check
npm run api:check
```

- Run the workspace typecheck/build for tutorial code affected by an API change.

