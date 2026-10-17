export const ENGINE_021_EVIDENCE_KINDS = Object.freeze(['correctness', 'production', 'resources', 'ablation', 'rooms', 'instances', 'forward']);

/** User-approved single repair case, ADR 0129. Digests identify complete immutable populations. */
export const ENGINE_021_READBACK_REUSE = Object.freeze({
  decision: 'ADR0129-readback-cache-history',
  captureRevision: '384ad34d7007b0618cdd0408f3968d5085461130',
  sourceFiles: Object.freeze({
  "scripts/webgpu-gate/readback-churn-fixture.mjs": "6f5f5d9949121c5bfb4f2cbd93845acf70438cfd20cadafba3814a565d9a4782",
  "scripts/webgpu-gate/readback-churn-cache-history.mjs": "103863f243f1218f8fd6143ffe53a0b907be054008777403daeea19f0c6d4a3b",
  "scripts/webgpu-gate/readback-churn-contract.test.mjs": "68db10095316c7382b2a024b8aafd6d9055959b022e2b9c87203072f39aace62"
}),
  reports: Object.freeze(Object.fromEntries(Object.entries({
  "resources": {
    "file": "artifacts/engine-0.2.1/g09/study-resources-2026-10-17T01-26-17.345Z/report.json",
    "sha256": "fe4e6a7579546ef237c0a8b7b7da716028f4b275833ce204c0e863e8c960fd86"
  },
  "rooms": {
    "file": "artifacts/engine-0.2.1/g05/continuous-rooms-2026-10-17T02-15-12.689Z/report.json",
    "sha256": "155bbd1b426fa7470061581b591c7b49460d28b0eba250865b0f7e1bce9aec91"
  },
  "instances": {
    "file": "artifacts/engine-0.2.1/g05/continuous-instances-2026-10-17T03-02-39.220Z/report.json",
    "sha256": "35b76ee7dd7b3fccdf932ad0421e6cb3474ad04982c94eb4982afadba5b2e6f1"
  },
  "forward": {
    "file": "artifacts/engine-0.2.1/g05/continuous-forward-2026-10-17T03-17-41.282Z/report.json",
    "sha256": "f45d42558354f73de3e2532f9469c2d48a23f9db18e4579f5360016d4815a03a"
  },
  "production": {
    "file": "artifacts/engine-0.2.1/g09/production-local-2026-10-17T03-21-01.698Z/report.json",
    "sha256": "1a78ec905affb2c072bc3b382b96c096b0a0763da1f8625fbe857133f5ac05cd"
  },
  "ablation": {
    "file": "artifacts/engine-0.2.1/g09/study-ablation-2026-10-17T03-47-40.696Z/report.json",
    "sha256": "2ad1239926d8a6d5a2267d1b7afba8c6120784aa6de94e2704c75c7ef5c6e920"
  }
}).map(([kind, value]) => [kind, Object.freeze(value)]))),
});
/** User-approved isolated Windows PBR reference case, ADR 0130; never a generic fixture exemption. */
export const ENGINE_021_PBR_REUSE = Object.freeze({
  decision: 'ADR0130-pbr-windows-reference',
  sourceFiles: Object.freeze({
  "scripts/verify-pbr-example.mjs": "dc554daf0283bc780f7c17940bef5e269bb3733bdf71df7d03708bb853352580",
  "scripts/pbr-example-pixel-policy.mjs": "a5a6812e42409d9716261b56d0cb72b8994f848bd781d8b9b7c3e99c8f38e37d",
  "scripts/pbr-example-pixel-policy.test.mjs": "8725c333f3bc99afd26b57e0f2a1596346f4c2f17884b2522a8739c729d0477f",
  "review/baselines/render-pixels-stage9-pbr-example.win32.json": "79da741390ae3516bcd4a7fb19bec47386e0394efb9625040c4605fc3593bb64"
}),
  reports: Object.freeze(Object.fromEntries(Object.entries({
  "resources": {
    "file": "artifacts/engine-0.2.1/g09/study-resources-2026-10-17T01-26-17.345Z/report.json",
    "sha256": "fe4e6a7579546ef237c0a8b7b7da716028f4b275833ce204c0e863e8c960fd86",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "rooms": {
    "file": "artifacts/engine-0.2.1/g05/continuous-rooms-2026-10-17T02-15-12.689Z/report.json",
    "sha256": "155bbd1b426fa7470061581b591c7b49460d28b0eba250865b0f7e1bce9aec91",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "instances": {
    "file": "artifacts/engine-0.2.1/g05/continuous-instances-2026-10-17T03-02-39.220Z/report.json",
    "sha256": "35b76ee7dd7b3fccdf932ad0421e6cb3474ad04982c94eb4982afadba5b2e6f1",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "forward": {
    "file": "artifacts/engine-0.2.1/g05/continuous-forward-2026-10-17T03-17-41.282Z/report.json",
    "sha256": "f45d42558354f73de3e2532f9469c2d48a23f9db18e4579f5360016d4815a03a",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "production": {
    "file": "artifacts/engine-0.2.1/g09/production-local-2026-10-17T03-21-01.698Z/report.json",
    "sha256": "1a78ec905affb2c072bc3b382b96c096b0a0763da1f8625fbe857133f5ac05cd",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "ablation": {
    "file": "artifacts/engine-0.2.1/g09/study-ablation-2026-10-17T03-47-40.696Z/report.json",
    "sha256": "2ad1239926d8a6d5a2267d1b7afba8c6120784aa6de94e2704c75c7ef5c6e920",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "correctness": {
    "file": "artifacts/engine-0.2.1/g09/acceptance-full-2026-10-17T05-32-37.989Z/report.json",
    "sha256": "5011f738c412e25fff19694cd71a8fb5448c3f13b8d068ff045ea9fccb36194b",
    "captureRevision": "1260d9b521b19c686794ad2f92056fe47662fb5a"
  }
}).map(([kind, value]) => [kind, Object.freeze(value)]))),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (condition, message) => { if (!condition) throw Error(message); };
const g05Kinds = ['rooms', 'instances', 'forward'];
const policyFiles = new Set(['scripts/engine-021-evidence-policy.mjs', 'scripts/engine-021-evidence-policy.test.mjs',
  'scripts/check-engine-021-evidence.mjs']);

export function isEngine021ReadbackReuseBinding(kind, binding) {
  const pinned = ENGINE_021_READBACK_REUSE.reports[kind];
  return !!pinned && binding?.captureRevision === ENGINE_021_READBACK_REUSE.captureRevision &&
    binding.file === pinned.file && binding.sha256 === pinned.sha256;
}

export function isEngine021PbrReuseBinding(kind, binding) {
  const pinned = ENGINE_021_PBR_REUSE.reports[kind];
  return !!pinned && binding?.captureRevision === pinned.captureRevision && binding.file === pinned.file && binding.sha256 === pinned.sha256;
}

const safePath = path => typeof path === 'string' && !path.split('/').some(p => !p || p === '..' || p === '.') && !path.includes('\\');
const acceptancePath = path => safePath(path) && (policyFiles.has(path) || ['README.md', 'CHANGELOG.md'].includes(path) || /^(docs|review)\/.+\.md$/.test(path));

/** ADR 0126 remains the default; ADRs 0129 and 0130 are separate, byte-pinned repair cases. */
export function validateEngine021RevisionReuse(captureRevision, current, kind, binding, reuseDecision) {
  check(/^[a-f0-9]{40}$/.test(captureRevision), 'Missing clean capture revision');
  if (reuseDecision === ENGINE_021_PBR_REUSE.decision) {
    check(captureRevision !== current.revision && isEngine021PbrReuseBinding(kind, binding),
      'ADR 0130 requires its exact seven pinned populations');
    const paths = current.reuseChanges?.[captureRevision];
    check(Array.isArray(paths), 'ADR 0130 requires a verified Git comparison for every capture revision');
    const fixedFiles = Object.entries(ENGINE_021_PBR_REUSE.sourceFiles);
    check(fixedFiles.every(([path, hash]) => paths.includes(path) && current.pbrFixFiles?.[path] === hash),
      'ADR 0130 requires the exact reviewed PBR repair and Windows reference bytes');
    const readbackFiles = Object.entries(ENGINE_021_READBACK_REUSE.sourceFiles);
    check(readbackFiles.every(([path, hash]) => current.readbackFixFiles?.[path] === hash),
      'ADR 0130 retains the exact ADR 0129 readback repair');
    const originalSix = captureRevision === ENGINE_021_READBACK_REUSE.captureRevision;
    if (originalSix) check(readbackFiles.every(([path]) => paths.includes(path)), 'ADR 0130 original six require the readback repair comparison');
    const allowed = new Set([...fixedFiles.map(([path]) => path), ...(originalSix ? readbackFiles.map(([path]) => path) : []),
      'scripts/engine-021-candidate-policy.mjs', 'scripts/engine-021-candidate-policy.test.mjs',
      'review/engine-0.2.1/release-candidate.json']);
    check(paths.every(path => acceptancePath(path) || safePath(path) && allowed.has(path)),
      'ADR 0130 requires new sampling after another non-acceptance change');
    return;
  }
  if (captureRevision === current.revision) return;
  const paths = current.reuseChanges?.[captureRevision];
  check(Array.isArray(paths), 'Missing verified Git comparison for capture revision');
  if (paths.every(acceptancePath)) return;
  check(captureRevision === ENGINE_021_READBACK_REUSE.captureRevision && isEngine021ReadbackReuseBinding(kind, binding),
    'Evidence reuse requires new sampling after non-acceptance change; this is not an ADR 0129 pinned population');
  check(reuseDecision === ENGINE_021_READBACK_REUSE.decision, 'ADR 0129 requires its explicit manifest decision');
  const fixedFiles = Object.entries(ENGINE_021_READBACK_REUSE.sourceFiles);
  check(fixedFiles.every(([path, hash]) => paths.includes(path) && current.readbackFixFiles?.[path] === hash),
    'ADR 0129 requires the exact reviewed readback repair bytes');
  const allowed = new Set([...fixedFiles.map(([path]) => path),
    'scripts/engine-021-candidate-policy.mjs', 'scripts/engine-021-candidate-policy.test.mjs',
    'review/engine-0.2.1/release-candidate.json']);
  check(paths.every(path => acceptancePath(path) || safePath(path) && allowed.has(path)),
    'Evidence reuse requires new sampling after another non-acceptance change');
}

/** Identity checks precede independent raw-artifact audits; summary status alone never qualifies a bundle. */
export function validateEngine021EvidenceBindings(manifest, reports, current) {
  check(manifest?.schemaVersion === 2 && manifest.contractId === 'engine-021-evidence-v2', 'Unknown qualification manifest');
  check(manifest.reuseDecision === undefined || [ENGINE_021_READBACK_REUSE.decision, ENGINE_021_PBR_REUSE.decision].includes(manifest.reuseDecision), 'Unknown evidence reuse decision');
  check(/^[a-f0-9]{40}$/.test(current.revision) && current.dirty === false && manifest.revision === current.revision,
    'Qualification requires the current clean revision');
  check(same(Object.keys(manifest.reports ?? {}).sort(), [...ENGINE_021_EVIDENCE_KINDS].sort()) &&
    same(Object.keys(reports).sort(), [...ENGINE_021_EVIDENCE_KINDS].sort()), 'All seven complete reports are required');
  const paths = new Set(), hosts = new Set();
  for (const kind of ENGINE_021_EVIDENCE_KINDS) {
    const binding = manifest.reports[kind], report = reports[kind];
    check(typeof binding?.file === 'string' && binding.file.startsWith('artifacts/') && !binding.file.split('/').some(p => !p || p === '..' || p === '.') &&
      !binding.file.includes('\\') && /^[a-f0-9]{64}$/.test(binding.sha256) && !paths.has(binding.file), `Invalid/duplicate ${kind} report binding`);
    paths.add(binding.file);
    check(binding.captureRevision === report?.revision && report.dirty === false &&
      (report.status === 'passed' || g05Kinds.includes(kind) && report.status === 'failed'), `${kind}: not a complete clean capture`);
    validateEngine021RevisionReuse(report.revision, current, kind, binding, manifest.reuseDecision);
    check(Number.isFinite(Date.parse(report.generatedAt)) && Number.isFinite(Date.parse(report.finishedAt)) &&
      Date.parse(report.finishedAt) >= Date.parse(report.generatedAt), `${kind}: missing capture completion`);
    if (kind === 'correctness') {
      check(report.tier === 'full' && same(report.inputs, current.runtime), 'Correctness inputs/tier differ');
      check(report.baseline?.revision === current.framegraphBaselineRevision, 'Incorrect FrameGraph baseline');
      check(same(report.qualification, current.qualification), 'Correctness qualification path/host differs');
      hosts.add(report.qualification.hostname);
    } else {
      const continuous = ['rooms', 'instances', 'forward'].includes(kind);
      check(report.tier === (kind === 'production' ? 'production-local' : 'local-full'), `${kind}: smoke/diagnostic tier cannot qualify`);
      check(same(report.config, continuous ? current.lightingConfig : current.productionConfig), `${kind}: current config differs`);
      check(same(report.inputs, current.inputs[kind]), `${kind}: current runtime/harness differs`);
      if (continuous) check(report.suite === kind, `${kind}: wrong continuous suite`);
      if (kind === 'resources' || kind === 'ablation') check(report.mode === kind, `${kind}: wrong study mode`);
      const host = continuous ? report.hostBefore : report.host;
      check(typeof host?.hostname === 'string' && host.hostname.length > 0, `${kind}: missing host identity`);
      hosts.add(host.hostname);
    }
  }
  check(hosts.size === 1, 'Evidence must come from the same host');
}

/** Compare every emitted candidate chunk to a fresh build under the acceptance revision. */
export function validateEngine021CompiledEvidence(reports, builds) {
  const normalize = files => {
    check(Array.isArray(files) && files.some(f => f.file === 'fixture.js') && new Set(files.map(f => f.file)).size === files.length,
      'Missing/duplicate compiled candidate chunks');
    check(files.every(f => typeof f.file === 'string' && /^[a-f0-9]{64}$/.test(f.sha256)), 'Invalid compiled chunk digest');
    return files.map(({ file, sha256 }) => ({ file, sha256 })).sort((a, b) => a.file.localeCompare(b.file));
  };
  for (const kind of ENGINE_021_EVIDENCE_KINDS) {
    const captured = kind === 'correctness' ? reports[kind]?.build?.outputs : reports[kind]?.build;
    const rebuilt = builds[g05Kinds.includes(kind) || kind === 'correctness' ? 'common' : kind];
    check(same(normalize(captured), normalize(rebuilt)), `${kind}: rebuilt candidate bytes differ; new sampling required`);
  }
}

/** Consume only a complete independent raw audit; original measurement status remains unchanged. */
export function assessEngine021G05Audit(kind, audit) {
  const shape = { rooms: [156, 60, 156, 156], instances: [96, 96, 192, 0], forward: [24, 8, 16, 0] }[kind];
  check(shape && ['passed', 'failed'].includes(audit?.status) && audit.cleanCandidate === true && audit.captures === shape[0] &&
    audit.checks?.length === shape[1] && audit.stability?.length === shape[2] && audit.memory?.length === shape[3],
    `${kind}: incomplete independent G05 audit`);
  const cpuRegressionInvestigations = [];
  for (const c of audit.checks) {
    check(Number.isFinite(c.observed) && c.observed >= 0 && Number.isFinite(c.limit) && c.limit > 0 &&
      c.passed === (c.observed <= c.limit) && (kind !== 'forward' || c.limit === 1.05),
      `${kind}: invalid original performance budget evidence`);
    if (kind === 'forward') check(['cpuP95Ratio', 'gpuP95Ratio'].includes(c.metric), 'forward: unknown timing metric');
    // ADR 0127 changes only interpretation of Forward CPU relative excess. The
    // original 1.05 line, measured values and failed checks remain in the audit.
    if (kind === 'forward' && c.metric === 'cpuP95Ratio') {
      if (!c.passed) cpuRegressionInvestigations.push(c);
    } else check(c.passed, `${kind}: original performance budget failed`);
  }
  if (kind === 'forward') check(audit.checks.filter(c => c.metric === 'cpuP95Ratio').length === 4 &&
    audit.checks.filter(c => c.metric === 'gpuP95Ratio').length === 4, 'forward: incomplete CPU/GPU coverage');
  for (const m of audit.memory) check(m.status === 'passed' && m.checks?.length > 0 && m.checks.every(c =>
    c.passed === true && Number.isFinite(c.observed) && c.observed >= 0 && Number.isFinite(c.limit) && c.limit > 0 && c.observed <= c.limit),
    `${kind}: original resource budget failed`);
  for (const s of audit.stability) check(typeof s.stable === 'boolean' && s.passed === s.stable &&
    s.cohortP95?.length === 3 && s.cohortP95.every(n => Number.isFinite(n) && n > 0) &&
    Number.isFinite(s.relativeSpread) && s.relativeSpread >= 0 && Number.isFinite(s.cv) && s.cv >= 0,
    `${kind}: incomplete stability evidence`);
  const warnings = audit.stability.filter(s => !s.stable);
  check(audit.status === (warnings.length || cpuRegressionInvestigations.length ? 'failed' : 'passed'), `${kind}: inconsistent original audit status`);
  return { status: 'passed', originalStatus: audit.status, performanceChecks: audit.checks.length,
    hardPerformanceChecks: kind === 'forward' ? 4 : audit.checks.length,
    stabilityChecks: audit.stability.length, warnings, cpuRegressionInvestigations,
    scope: 'ADR 0126/0127 prerequisite only. Cohort variation and Forward CPU 5% excess are investigated. GPU 5%, other budgets, complete production, resources, correctness and release evidence remain required.' };
}

export function completeEngine021EvidenceAudit(audits, reports) {
  check(same(Object.keys(audits).sort(), [...ENGINE_021_EVIDENCE_KINDS].sort()), 'Missing raw-artifact audit');
  const assessments = {};
  for (const kind of ENGINE_021_EVIDENCE_KINDS) {
    if (g05Kinds.includes(kind)) {
      check(reports?.[kind]?.status === audits[kind]?.status, `${kind}: stored and recalculated original status differ`);
      assessments[kind] = assessEngine021G05Audit(kind, audits[kind]);
    } else check(audits[kind]?.status === 'passed', `${kind}: independent raw-artifact audit did not pass`);
  }
  return { status: 'passed', audited: [...ENGINE_021_EVIDENCE_KINDS], assessments, g09Complete: false, releaseQualified: false,
    scope: 'Hash-matched candidate correctness, presented pacing, sustained resources, attribution and G05 timing prerequisites only; lifecycle, Shader, package and remaining release checks are separate.' };
}
