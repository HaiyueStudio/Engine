import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(root, 'artifacts/engine-0.2.2/g11/audio-native-' + Date.now()), build = resolve(out, 'compiled');
mkdirSync(out, {recursive: true});
const paths = readdirSync(resolve(root, 'extensions/src/animation/audio')).filter(name => name.endsWith('.ts')).map(name => 'extensions/src/animation/audio/' + name);
paths.push('extensions/test/audio-production-browser.html', 'extensions/test/audio-production-browser.mjs', 'extensions/test/audio-production-browser-gate.mjs');
const sha = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const inputs = Object.fromEntries(paths.map(path => [path, sha(path)]));
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler',
  '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types', '--rootDir', 'extensions/src',
  '--outDir', build, 'extensions/src/animation/audio/BrowserProductionAudioHost.ts'], {cwd: root, stdio: 'pipe'});
let report;
try {report = await runChromeWebGpuFixture({root, fixture: 'extensions/test/audio-production-browser.html', mounts: [{prefix: '/g11-audio-build', directory: build}], timeoutMs: 60000, acceptedStatuses: ['passed', 'failed']});}
catch (error) {report = {status: 'failed', error: String(error.stack ?? error), browserFailure: error.browserFailure};}
const changed = paths.filter(path => inputs[path] !== sha(path));
const reads = report.httpProvenance?.files ?? [];
const mismatch = reads.filter(entry => {
  const path = entry.sourcePath.startsWith('g11-audio-build/') ? resolve(build, entry.sourcePath.slice('g11-audio-build/'.length)) : resolve(root, entry.sourcePath);
  return createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256;
});
if (changed.length || mismatch.length || !reads.length) report = {...report, status: 'failed', changed, mismatch};
writeFileSync(resolve(out, 'result.json'), JSON.stringify({schemaVersion: 1, inputs, ...report}, null, 2) + '\n');
console.log(JSON.stringify({out, status: report.status, cases: report.caseCount, error: report.error}));
if (report.status !== 'passed') process.exitCode = 1;
