import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { loadFrameGraphQualification, frameGraphBrowserPath, assertFrameGraphQualificationUnchanged } from './webgpu-gate/framegraph-qualification.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './webgpu-gate/framegraph-qualification-policy.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const qualification = await loadFrameGraphQualification(root);
const files = ['engine/dist/experimental.js','engine/dist/postprocess.js','engine/src/postprocess/PostProcessGraph.ts','engine/src/systems/Render3DFramePlan.ts','engine/src/renderer/DeferredReferenceBackend.ts','scripts/webgpu-gate/framegraph-culling-fixture.mjs','scripts/verify-framegraph-culling.mjs'];
const hashes = () => Object.fromEntries(files.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
const inputs = hashes(), sourceFingerprint = createPerformanceSourceFingerprint(root, root), results = [];
const directory = resolve(root, `artifacts/engine-0.2.1/g09/culling-${new Date().toISOString().replaceAll(':','-')}`);
mkdirSync(directory, { recursive: true });
const evidence = { schemaVersion: 2, qualification, status: 'running', generatedAt: new Date().toISOString(),
  revision: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), dirty: !!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),
  scope: 'structural-and-pixel-verification; not formal CPU/GPU performance', inputs, sourceFingerprint, results };
try {
  for (const job of qualification.targets) {
    const result = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(job.browserId), fixture: 'scripts/webgpu-gate/framegraph-culling-fixture.html', query: { powerPreference: job.powerPreference }, timeoutMs: 120000 });
    results.push({ ...job, result });
    validateFrameGraphAdapter(result.adapter, qualification);
    validateFrameGraphBrowser(result, job, qualification);
  }
  validateFrameGraphAdapterConsistency(results.map(row => row.result.adapter));
  await assertFrameGraphQualificationUnchanged(root, qualification);
  if (sourceFingerprint !== createPerformanceSourceFingerprint(root, root)) throw Error('Runtime changed during verification');
  if (JSON.stringify(inputs) !== JSON.stringify(hashes())) throw Error('FrameGraph inputs changed during verification');
  evidence.status = 'passed';
} catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
finally { writeFileSync(resolve(directory,'native.json'), JSON.stringify(evidence, null, 2)+'\n'); }
console.log(`[framegraph-culling] native parity and real pass reduction passed: ${directory}`);
