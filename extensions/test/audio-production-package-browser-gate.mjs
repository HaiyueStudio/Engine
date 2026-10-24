import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
if (!process.argv[2]) throw new Error('Pass a successful G11 audio candidate result.json');
const candidatePath = resolve(process.argv[2]), candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
assert.equal(candidate.status, 'passed-private-audio-candidate');
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(sha(candidate.tarball.path), candidate.tarball.sha256);
for (const [path, hash] of Object.entries(candidate.runtimeSources)) assert.equal(sha(path), hash, path);
const consumer = resolve(candidatePath, '../consumer/node_modules/@haiyue');
const out = resolve(root, 'artifacts/engine-0.2.2/g11/audio-packed-native-' + Date.now()); mkdirSync(out);
const sources = ['audio-production-package-browser.html', 'audio-production-package-browser.mjs', 'audio-production-package-browser-gate.mjs'].map(name => 'extensions/test/' + name);
const inputs = Object.fromEntries(sources.map(path => [path, sha(resolve(root, path))])); let report;
try {
  report = await runChromeWebGpuFixture({root, fixture: 'extensions/test/audio-production-package-browser.html',
    mounts: [{prefix: '/g11-packed-audio', directory: resolve(consumer, 'extensions/dist')}, {prefix: '/g11-packed-format', directory: resolve(consumer, 'animation-spec/dist')}],
    timeoutMs: 60000, acceptedStatuses: ['passed', 'failed'], interact: async cdp => {
      const evaluate = async expression => {const value = await cdp.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}); if (value.result?.exceptionDetails) throw Error(JSON.stringify(value.result.exceptionDetails)); return value.result?.result?.value;};
      for (let index = 0; index < 500; index++) {
        if (await evaluate("document.querySelector('#result')?.dataset.status==='failed'")) return;
        if (await evaluate("document.querySelector('#result')?.dataset.ready==='true'")) {
          const point = await evaluate("(()=>{const r=document.querySelector('#unlock').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
          await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1});
          await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1}); return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw Error('packed native audio fixture did not prepare');
    }});
} catch (error) {report = {status: 'failed', error: String(error.stack ?? error), browserFailure: error.browserFailure};}
const reads = report.httpProvenance?.files ?? [], changed = sources.filter(path => inputs[path] !== sha(resolve(root, path)));
const mismatch = reads.filter(entry => {
  const path = entry.sourcePath.startsWith('g11-packed-audio/') ? resolve(consumer, 'extensions/dist', entry.sourcePath.slice('g11-packed-audio/'.length))
    : entry.sourcePath.startsWith('g11-packed-format/') ? resolve(consumer, 'animation-spec/dist', entry.sourcePath.slice('g11-packed-format/'.length)) : resolve(root, entry.sourcePath);
  return sha(path) !== entry.sha256;
});
if (!reads.length || changed.length || mismatch.length) report = {...report, status: 'failed', changed, mismatch};
writeFileSync(resolve(out, 'result.json'), JSON.stringify({schemaVersion: 1, candidate: {path: candidatePath, sha256: sha(candidatePath)}, inputs, ...report}, null, 2) + '\n');
console.log(JSON.stringify({out, status: report.status, cases: report.caseCount, error: report.error})); if (report.status !== 'passed') process.exitCode = 1;
