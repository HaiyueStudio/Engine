import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { validateInspectorCapture, findSequentialPoolReuses } from './webgpu-gate/framegraph-inspector-policy.mjs';
import { decodePng } from './visual-regression/png.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { loadFrameGraphQualification, frameGraphBrowserPath, assertFrameGraphQualificationUnchanged } from './webgpu-gate/framegraph-qualification.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './webgpu-gate/framegraph-qualification-policy.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const qualification = await loadFrameGraphQualification(root);
const out = resolve(root, `artifacts/engine-0.2.1/g09/inspector-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(out, { recursive: true });
const files = ['examples/deferred-lighting/main.ts', 'examples/deferred-lighting/framegraph.ts', 'examples/deferred-lighting/model.ts', 'examples/deferred-lighting/index.html', 'examples/deferred-lighting/bundle.js', 'examples/shared/engine.js', 'scripts/verify-framegraph-example.mjs', 'scripts/webgpu-gate/framegraph-inspector-policy.mjs', 'scripts/webgpu-gate/chrome-runner.mjs'];
const hashes = () => Object.fromEntries(files.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
const evidence = { schemaVersion: 1, status: 'running', scope: 'one-shot-observer-correctness-not-formal-performance', generatedAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), inputs: hashes(), sourceFingerprint: createPerformanceSourceFingerprint(root, root), devices: [] };
try {
  evidence.schemaVersion = 2; evidence.qualification = qualification;
  for (const job of qualification.targets) {
    const { powerPreference } = job;
    const result = { ...job, cases: [] }; evidence.devices.push(result);
    const browser = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(job.browserId), fixture: 'examples/deferred-lighting/index.html', query: { regression: 1, powerPreference }, timeoutMs: 120000, visualCapture: { viewportWidth: 1280, viewportHeight: 800 }, navigateAwayAfterResult: true, interact: async cdp => {
      const evaluate = async expression => { const response = (await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result; if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text); return response.result?.value; };
      const ready = async () => wait(async () => { const s = await evaluate(`window.__deferredExample?.snapshot()`); if (s?.status === 'failed') throw Error(JSON.stringify(s)); const path = await evaluate(`document.getElementById('path').value`); return s?.lifecycle === 'ready' && s.frames > 3 && (path === 'forward' ? !s.stats : s.stats?.effective === `deferred-${path}`) ? s : null; });
      const set = async (id, value) => evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});${typeof value === 'boolean' ? 'e.checked' : 'e.value'}=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      let captureIndex = 0;
      const capture = async () => { await evaluate(`document.getElementById('fg-capture').click()`); const s = await wait(() => evaluate(`window.__deferredExample.framegraph.snapshot()`)); writeFileSync(resolve(out, `${job.browserId}-capture-${++captureIndex}.json`), JSON.stringify(s, null, 2)); assert.deepEqual(validateInspectorCapture(s), []); return s; };
      const picture = async name => { const shot = (await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).result.data; writeFileSync(resolve(out, `${job.browserId}-${name}.png`), Buffer.from(shot, 'base64')); };
      const pixels = async name => { await evaluate(`window.__deferredExample.whenSubmittedWorkDone()`); await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`); const clip = await evaluate(`(()=>{const r=document.getElementById('canvas').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()`); const png = Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png', clip })).result.data, 'base64'); writeFileSync(resolve(out, `${job.browserId}-${name}.png`), png); return decodePng(png); };
      const difference = (a, b) => { let changed = 0, sum = 0; assert.equal(a.data.length, b.data.length); for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) { const delta = Math.abs(a.data[i + c] - b.data[i + c]); sum += delta; if (delta) changed++; } return { changed, mean: sum / (a.width * a.height * 3) }; };
      const downloadDirectory = resolve(out, `${job.browserId}-downloads`); mkdirSync(downloadDirectory);
      await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
      result.adapter = (await ready()).adapter;
      assert.equal(await evaluate(`window.__deferredExample.framegraph.snapshot()`), null);
      await set('helpers', false); await evaluate(`document.getElementById('status').hidden=true;document.getElementById('hint').hidden=true`);
      for (const path of ['forward', 'reference', 'tiled']) {
        await set('path', path); await ready();
        const baseline = await pixels(`${path}-unarmed-1`), before = await pixels(`${path}-unarmed-2`);
        const unarmed = difference(baseline, before);
        result.cases.push({ name: `${path}-unarmed-presentation-stability`, ...unarmed });
        assert.equal(unarmed.mean, 0, `${path} pixels changed while the observer was unarmed`);
        const snapshot = await capture(), after = await pixels(`${path}-captured`);
        const { mean, changed } = difference(before, after);
        result.cases.push({ name: `${path}-capture-pixel-parity`, mean, changed, work: snapshot.work });
        assert.equal(mean, 0, `${path} capture changed pixels`);
        assert.equal(snapshot.status, 'submitted'); assert.equal(snapshot.work.submissions, 1); assert.ok(snapshot.work.renderPasses > 0); assert.ok(snapshot.plans.length > 0);
        assert.deepEqual([snapshot.overhead.gpuReadbacks, snapshot.overhead.extraPasses, snapshot.overhead.retainedGpuBytes], [0, 0, 0]);
        if (path !== 'forward') assert.ok(snapshot.allocations.some(a => a.owner === 'deferred-mrt'));
        assert.ok(snapshot.plans.some(p => p.cache.lastReason === 'hit'));
        writeFileSync(resolve(out, `${job.browserId}-${path}.json`), JSON.stringify(snapshot, null, 2));
      }
      await set('fg-effects', 'ao-blur'); await ready();
      const reuse = await capture();
      assert.ok(reuse.allocations.some(a => a.owner === 'deferred-ao')); const physicalReuses = findSequentialPoolReuses(reuse, 'postprocess'); assert.ok(physicalReuses.length > 0, 'sequential blur leases must reuse a pool texture');
      assert.ok(reuse.pools.every(p => p.counters.pendingPeakBytes >= p.counters.pendingBytes));
      writeFileSync(resolve(out, `${job.browserId}-reuse.json`), JSON.stringify(reuse, null, 2));
      result.cases.push({ name: 'ao-and-blur-physical-mapping', physicalReuses, pools: reuse.pools });
      await set('fg-effects', 'cull'); await ready(); const culled = await capture();
      assert.ok(culled.plans.some(p => p.nodes.some(n => !n.live && n.reason === 'color-output-unconsumed')));
      assert.ok(culled.plans.some(p => p.nodes.some(n => n.dependsOn.length > 0)));
      writeFileSync(resolve(out, `${job.browserId}-culling.json`), JSON.stringify(culled, null, 2));
      // Frozen data remains unchanged while the scene renders; UI export only reads that data.
      const frozen = JSON.stringify(culled); await set('count', '256'); await ready();
      assert.equal(JSON.stringify(await evaluate(`window.__deferredExample.framegraph.snapshot()`)), frozen);
      await evaluate(`document.getElementById('fg-json').click();document.getElementById('fg-png').click()`);
      const jsonFile = resolve(downloadDirectory, `framegraph-${culled.frame}.json`), pngFile = resolve(downloadDirectory, `framegraph-${culled.frame}.png`);
      await wait(() => existsSync(jsonFile) && existsSync(pngFile));
      assert.deepEqual(JSON.parse(readFileSync(jsonFile, 'utf8')), culled);
      assert.equal(decodePng(readFileSync(pngFile)).width, 1200);
      await evaluate(`document.querySelector('.fg-panel').scrollIntoView()`); await picture('graph');
      result.cases.push({ name: 'culled-dependencies-frozen-json-and-png-export' });
      await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await new Promise(r => setTimeout(r, 500)); await ready(); assert.ok(await evaluate(`document.documentElement.scrollWidth<=document.documentElement.clientWidth`)); await picture('mobile');
      await evaluate(`window.__deferredExample.framegraph.request();window.__deferredExample.dispose()`);
      await new Promise(r => setTimeout(r, 400)); const disposed = await evaluate(`window.__deferredExample.snapshot()`);
      assert.equal(disposed.resources.resources, 0, JSON.stringify(disposed.resources)); assert.equal(disposed.errors.length, 0);
      result.cases.push({ name: 'mobile-and-pending-capture-disposal', resources: disposed.resources });
      await evaluate(`(()=>{const e=document.getElementById('result');e.dataset.status='passed';e.textContent=JSON.stringify({status:'passed'});})()`);
    } });
    result.browser = browser;
    validateFrameGraphAdapter(result.adapter, qualification);
    validateFrameGraphBrowser(browser, job, qualification);
  }
  validateFrameGraphAdapterConsistency(evidence.devices.map(row => row.adapter));
  await assertFrameGraphQualificationUnchanged(root, qualification);
  assert.equal(createPerformanceSourceFingerprint(root, root), evidence.sourceFingerprint, 'runtime changed during verification');
  assert.deepEqual(hashes(), evidence.inputs, 'example inputs changed during verification');
  evidence.status = 'passed';
} catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
finally { evidence.finishedAt = new Date().toISOString(); writeFileSync(resolve(out, 'native.json'), JSON.stringify(evidence, null, 2) + '\n'); }
console.log(`[framegraph-example] ${qualification.path.id} capture, pixels, culling, mapping and cleanup passed: ${out}`);
async function wait(fn) { const deadline = Date.now() + 60000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw Error('Timed out waiting for FrameGraph example.'); }
