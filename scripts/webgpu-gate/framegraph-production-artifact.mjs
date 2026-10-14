import { sha256 } from './deferred-fixture-policy.mjs';
import { productionPlan, assessProductionCapture, validateProductionScreenshot } from './framegraph-production-policy.mjs';

export async function auditProductionReport(report, readBound) {
  if (report.schemaVersion !== 1 || report.tier !== 'production-local' || report.configSha256 !== sha256(JSON.stringify(report.config)) ||
      report.inputsAfter !== report.inputs || !/^[a-f0-9]{64}$/.test(report.inputs) ||
      report.buildSha256 !== sha256(JSON.stringify(report.build)) ||
      JSON.stringify(report.plan) !== JSON.stringify(productionPlan(report.config)) || report.entries.length !== report.plan.length) throw Error('Incomplete/unregistered production report');
  const registration = await readBound(report.registration.file);
  if (sha256(registration) !== report.registration.sha256) throw Error('Registration changed');
  const registered = JSON.parse(registration);
  if (!Number.isFinite(Date.parse(registered.registeredAt))) throw Error('Missing registration timestamp');
  if (registered.configSha256 !== report.configSha256 || registered.inputs !== report.inputs || registered.buildSha256 !== report.buildSha256 ||
      JSON.stringify(registered.plan) !== JSON.stringify(report.plan)) throw Error('Registration identity changed');
  for (const output of report.build) if (sha256(await readBound(`runtime/${output.file}`)) !== output.sha256) throw Error('Registered runtime changed');
  const assessed = [];
  for (const [i, entry] of report.entries.entries()) {
    if (JSON.stringify(entry.job) !== JSON.stringify(report.plan[i])) throw Error('Reordered capture');
    if (!entry.raw) { assessed.push({ ...entry.job, status: 'invalid', error: entry.error }); continue; }
    const bytes = await readBound(entry.raw.file);
    if (sha256(bytes) !== entry.raw.sha256) throw Error('Raw capture changed');
    const raw = JSON.parse(bytes);
    if (!Number.isFinite(Date.parse(raw.startedAt)) || Date.parse(raw.startedAt) <= Date.parse(registered.registeredAt)) throw Error('Profile registered after capture');
    if (!entry.screenshot || sha256(await readBound(entry.screenshot.file)) !== entry.screenshot.sha256) throw Error('Missing/changed presentation screenshot');
    validateProductionScreenshot(await readBound(entry.screenshot.file));
    for (const output of report.build) {
      const served = raw.httpProvenance?.files?.find(f => f.sourcePath === `production-runtime/${output.file}`);
      // Dynamic chunks are required only when fetched; the entry is mandatory.
      if ((!served && output.file === 'fixture.js') || served && served.sha256 !== output.sha256) throw Error('Served runtime differs from registered build');
    }
    try { assessed.push({ ...entry.job, ...assessProductionCapture(raw, report.config, entry.job) }); }
    catch (error) { assessed.push({ ...entry.job, status: 'invalid', error: error.message }); }
  }
  return { status: assessed.some(e => e.status === 'invalid') ? 'invalid' : assessed.some(e => e.status === 'inconclusive') ? 'inconclusive' :
    assessed.some(e => e.class === 'normal' && e.status !== 'passed') ? 'failed' : 'passed', entries: assessed,
    g09Complete: false, releaseQualified: false, scope: report.config.scope };
}
