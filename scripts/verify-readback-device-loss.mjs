import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { validateReadbackDeviceLoss } from './webgpu-gate/readback-device-loss-policy.mjs';
import { sha256, deferredRuntimeFingerprint } from './webgpu-gate/deferred-fixture-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { loadFrameGraphQualification, frameGraphBrowserPath, assertFrameGraphQualificationUnchanged } from './webgpu-gate/framegraph-qualification.mjs';
import { validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './webgpu-gate/framegraph-qualification-policy.mjs';
if (process.argv.length !== 2) throw Error('Readback device-loss regression accepts no options; the complete native qualification path is required.');
const root = fileURLToPath(new URL('..', import.meta.url));
const qualification = await loadFrameGraphQualification(root), adapters = [];
const directory = resolve(root, 'artifacts/engine-0.2.1/g09', `readback-device-loss-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true });
const report = { schemaVersion: 2, qualification, status: 'running', performanceQualified: false,
  generatedAt: new Date().toISOString(), runtime: await deferredRuntimeFingerprint(root),
  sourceFingerprint: createPerformanceSourceFingerprint(root, root),
  wrapperHash: sha256(await readFile(fileURLToPath(import.meta.url))), results: [] };
try {
  for (const job of qualification.targets) {
    const { powerPreference } = job;
    const entry = { ...job }; report.results.push(entry);
    try {
      const raw = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(job.browserId), fixture: 'scripts/webgpu-gate/readback-device-loss-fixture.html',
        query: { powerPreference }, acceptedStatuses: ['passed', 'failed'], timeoutMs: 60000 });
      const file = `${job.browserId}.json`; await writeFile(resolve(directory, file), JSON.stringify(raw, null, 2) + '\n');
      entry.raw = { file, sha256: sha256(await readFile(resolve(directory, file))) };
      validateReadbackDeviceLoss(raw, qualification); validateFrameGraphBrowser(raw, job, qualification);
      adapters.push(...raw.cases.map(row => row.adapter)); entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.stack; }
    console.log(`[readback-device-loss] ${powerPreference}: ${entry.status}`);
  }
  if (report.sourceFingerprint !== createPerformanceSourceFingerprint(root, root) ||
      report.runtime.sha256 !== (await deferredRuntimeFingerprint(root)).sha256 ||
      report.wrapperHash !== sha256(await readFile(fileURLToPath(import.meta.url)))) throw Error('Device-loss regression inputs changed');
  await assertFrameGraphQualificationUnchanged(root, qualification);
  validateFrameGraphAdapterConsistency(adapters);
  report.status = report.results.length === qualification.targets.length && report.results.every(r => r.status === 'passed') ? 'passed' : 'failed';
} catch (error) { report.status = 'failed'; report.error = error.stack; }
finally { report.finishedAt = new Date().toISOString(); await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(directory); }
if (report.status !== 'passed') process.exitCode = 1;
