import { createHash } from 'node:crypto';
import { sha256 } from './deferred-fixture-policy.mjs';
import { validateG05ContinuousConfig, createG05ContinuousPlan, validateG05ContinuousHost, evaluateG05ContinuousBudgets } from './deferred-g05-continuous-policy.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The caller supplies a path-bounded reader; summaries are always recalculated from raw artifacts. */
export async function auditG05ContinuousReport(report, readBound, frozenBudgetBytes) {
  const config = validateG05ContinuousConfig(report.config), plan = createG05ContinuousPlan(config, report.suite);
  if (report.schemaVersion !== 1 || report.protocolId !== config.protocolId || report.tier !== 'local-full' ||
      !same(report.plan, plan) || report.entries?.length !== plan.length || !same(report.inputs, report.inputsAfter) ||
      sha256(frozenBudgetBytes) !== config.frozenBudget.sha256 || !/^[a-f0-9]{64}$/.test(report.inputs?.runtime?.sha256 ?? '') ||
      !/^[a-f0-9]{40}$/.test(report.revision ?? '') || typeof report.dirty !== 'boolean') throw Error('Incomplete or unbound G05 report');
  validateG05ContinuousHost(report.hostBefore, config); validateG05ContinuousHost(report.hostAfter, config);
  if (report.hostBefore.hostname !== report.hostAfter.hostname || !same(report.hostBefore.hardware, report.hostAfter.hardware)) throw Error('Host identity/power changed');
  const registeredBytes = await readBound(report.registration.file);
  if (sha256(registeredBytes) !== report.registration.sha256) throw Error('Registration changed');
  const registered = JSON.parse(registeredBytes);
  for (const key of ['config', 'plan', 'inputs', 'revision', 'dirty', 'build', 'baseline', 'hostBefore']) {
    if (!same(registered[key], report[key])) throw Error(`Registration ${key} differs`);
  }
  if (!Number.isFinite(Date.parse(registered.registeredAt))) throw Error('Missing registration timestamp');
  if (sha256(JSON.stringify(report.inputs.files)) !== report.inputs.harness) throw Error('Harness manifest hash differs');
  async function verifyBuild(prefix, outputs) {
    if (!Array.isArray(outputs) || !outputs.some(o => o.file === 'fixture.js')) throw Error('Missing compiled entry');
    for (const output of outputs) if (sha256(await readBound(`${prefix}/${output.file}`)) !== output.sha256) throw Error('Runtime output changed');
  }
  await verifyBuild('candidate', report.build);
  if (report.suite === 'forward') {
    const p = report.baseline;
    if (p?.revision !== config.forwardBaselineRevision || p.dirty !== false || sha256(JSON.stringify(p.files)) !== p.sourceSha256 ||
        sha256(await readBound('baseline/source.tar')) !== p.archiveSha256) throw Error('Frozen baseline provenance differs');
    for (const file of p.files) {
      const bytes = await readBound(`baseline/source/${file.path}`);
      if (sha256(bytes) !== file.sha256 || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.blob) throw Error('Frozen baseline source changed');
    }
    if (sha256(await readBound('baseline/runtime/bridge.mjs')) !== p.bridgeSha256) throw Error('Baseline bridge changed');
    await verifyBuild('baseline/runtime', p.outputs);
  }
  const captures = [];
  for (const [i, entry] of report.entries.entries()) {
    if (!same(entry.job, plan[i]) || !entry.raw) throw Error('Missing/reordered capture');
    const bytes = await readBound(entry.raw.file);
    if (sha256(bytes) !== entry.raw.sha256) throw Error('Raw capture changed');
    const e = JSON.parse(bytes), baseline = entry.job.arm === 'baseline';
    if (!same(e.job, entry.job) || e.inputs !== (baseline ? report.baseline.sourceSha256 : report.inputs.runtime.sha256) ||
        e.revision !== (baseline ? config.forwardBaselineRevision : report.revision) || e.dirty !== (baseline ? false : report.dirty) || e.harness !== report.inputs.harness ||
        !Number.isFinite(Date.parse(e.startedAt)) || Date.parse(e.startedAt) < Date.parse(registered.registeredAt)) throw Error('Capture identity or registration order differs');
    const prefix = report.suite === 'rooms' ? 'artifacts/engine-0.2.1/g03' : report.suite === 'instances' ? 'artifacts/engine-0.2.1/g05' : 'artifacts/engine-0.2.1/g09/oracle-runtime';
    for (const output of baseline ? report.baseline.outputs : report.build) {
      const served = e.result.httpProvenance?.files?.find(f => f.sourcePath === `${prefix}/${output.file}`);
      if ((!served && output.file === 'fixture.js') || served && served.sha256 !== output.sha256) throw Error('Served runtime differs');
    }
    captures.push(e);
  }
  return { ...evaluateG05ContinuousBudgets(captures, config, JSON.parse(frozenBudgetBytes), report.suite),
    releaseQualified: false, cleanCandidate: !report.dirty, captures: captures.length };
}
