export const ENGINE_021_EVIDENCE_KINDS = Object.freeze(['correctness', 'production', 'resources', 'ablation', 'rooms', 'instances', 'forward']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (condition, message) => { if (!condition) throw Error(message); };
const g05Kinds = ['rooms', 'instances', 'forward'];
const policyFiles = new Set(['scripts/engine-021-evidence-policy.mjs', 'scripts/engine-021-evidence-policy.test.mjs',
  'scripts/check-engine-021-evidence.mjs']);

/** ADR 0126 permits only prose/acceptance edits, in addition to exact measurement and binary hashes. */
export function validateEngine021RevisionReuse(captureRevision, current) {
  check(/^[a-f0-9]{40}$/.test(captureRevision), 'Missing clean capture revision');
  if (captureRevision === current.revision) return;
  const paths = current.reuseChanges?.[captureRevision];
  check(Array.isArray(paths), 'Missing verified Git comparison for capture revision');
  for (const path of paths) {
    check(typeof path === 'string' && !path.split('/').some(p => !p || p === '..' || p === '.') &&
      !path.includes('\\') && (policyFiles.has(path) || ['README.md', 'CHANGELOG.md'].includes(path) ||
        /^(docs|review)\/.+\.md$/.test(path)), `Evidence reuse requires new sampling after non-acceptance change: ${path}`);
  }
}

/** Identity checks precede independent raw-artifact audits; summary status alone never qualifies a bundle. */
export function validateEngine021EvidenceBindings(manifest, reports, current) {
  check(manifest?.schemaVersion === 2 && manifest.contractId === 'engine-021-evidence-v2', 'Unknown qualification manifest');
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
    validateEngine021RevisionReuse(report.revision, current);
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
  for (const c of audit.checks) check(c.passed === true && Number.isFinite(c.observed) && c.observed >= 0 &&
    Number.isFinite(c.limit) && c.limit > 0 && c.observed <= c.limit && (kind !== 'forward' || c.limit === 1.05),
    `${kind}: original performance budget failed`);
  for (const m of audit.memory) check(m.status === 'passed' && m.checks?.length > 0 && m.checks.every(c =>
    c.passed === true && Number.isFinite(c.observed) && c.observed >= 0 && Number.isFinite(c.limit) && c.limit > 0 && c.observed <= c.limit),
    `${kind}: original resource budget failed`);
  for (const s of audit.stability) check(typeof s.stable === 'boolean' && s.passed === s.stable &&
    s.cohortP95?.length === 3 && s.cohortP95.every(n => Number.isFinite(n) && n > 0) &&
    Number.isFinite(s.relativeSpread) && s.relativeSpread >= 0 && Number.isFinite(s.cv) && s.cv >= 0,
    `${kind}: incomplete stability evidence`);
  const warnings = audit.stability.filter(s => !s.stable);
  check(audit.status === (warnings.length ? 'failed' : 'passed'), `${kind}: inconsistent original audit status`);
  return { status: 'passed', originalStatus: audit.status, performanceChecks: audit.checks.length,
    stabilityChecks: audit.stability.length, warnings,
    scope: 'ADR 0126 timing-budget prerequisite only. Cohort variation is investigated; complete production, resource, correctness and release evidence remains required.' };
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
