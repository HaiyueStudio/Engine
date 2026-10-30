import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
import {productionFontFixture} from './text-production-font-fixture.mjs';
import {loadHyaProductionSource} from '../../animation-spec/test/helpers/hya-production-source.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url)), dpr = Number(process.argv[2] ?? 1);
execFileSync(process.execPath, ['--check', resolve(root, 'extensions/test/text-production-browser.mjs')], {cwd: root, stdio: 'pipe'});
const out = resolve(root, 'artifacts/engine-0.2.2/g11/text-native-dpr' + dpr + '-' + Date.now()), build = resolve(out, 'compiled'), fixture = resolve(out, 'fixture'); mkdirSync(fixture, {recursive: true});
const {spec, record} = await loadHyaProductionSource(), font = productionFontFixture();
writeFileSync(resolve(fixture, 'document.json'), JSON.stringify(spec.parseResponsiveLayoutDocument(font.document))); writeFileSync(resolve(fixture, 'font.otf'), font.bytes);
writeFileSync(resolve(fixture, 'license.json'), JSON.stringify({license: font.license, author: font.author, sha256: font.sha256}, null, 2));
const paths = ['extensions/src/animation/AnimationTextRasterizer.ts', 'extensions/src/animation/AnimationOpenType.ts', 'extensions/src/animation/layout/parameterized/AssetOwner.ts'];
const scan = path => {for (const entry of readdirSync(resolve(root, path), {withFileTypes: true})) {const name = path + '/' + entry.name; if (entry.isDirectory()) scan(name); else if (name.endsWith('.ts')) paths.push(name);}};
scan('extensions/src/animation/text'); scan('extensions/src/layout');
paths.push(...['browser.html','browser.mjs','browser-gate.mjs','font-fixture.mjs'].map(name => 'extensions/test/text-production-' + name));
const sha = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'); const inputs = Object.fromEntries(paths.map(path => [path, sha(path)]));
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types', '--rootDir', 'extensions/src', '--outDir', build,
  'extensions/src/animation/text/production/ProductionBrowserFontPort.ts', 'extensions/src/animation/text/production/ProductionTextOwner.ts'], {cwd: root, stdio: 'pipe'});
let report;
try {report = await runChromeWebGpuFixture({root, fixture: 'extensions/test/text-production-browser.html', query: {dpr}, mounts: [{prefix: '/g11-text-build', directory: build}, {prefix: '/g11-text-fixture', directory: fixture}], timeoutMs: 60000, acceptedStatuses: ['passed', 'failed']});}
catch (error) {report = {status: 'failed', error: String(error.stack ?? error), browserFailure: error.browserFailure};}
for (const capture of report.captures ?? []) for (const kind of ['actual', 'reference']) writeFileSync(resolve(out, capture.id + '-' + kind + '.png'), Buffer.from(capture[kind].split(',')[1], 'base64'));
delete report.captures;
const reads = report.httpProvenance?.files ?? [], mismatch = reads.filter(entry => {
  const path = entry.sourcePath.startsWith('g11-text-build/') ? resolve(build, entry.sourcePath.slice('g11-text-build/'.length)) : entry.sourcePath.startsWith('g11-text-fixture/') ? resolve(fixture, entry.sourcePath.slice('g11-text-fixture/'.length)) : resolve(root, entry.sourcePath);
  return createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256;
});
const changed = paths.filter(path => sha(path) !== inputs[path]); if (changed.length || mismatch.length || !reads.length) report = {...report, status: 'failed', changed, mismatch};
writeFileSync(resolve(out, 'result.json'), JSON.stringify({schemaVersion: 1, inputs, parserBuild: record, font: {sha256: font.sha256, license: font.license}, ...report}, null, 2) + '\n');
console.log(JSON.stringify({out, status: report.status, cases: report.caseCount, error: report.error})); if (report.status !== 'passed') process.exitCode = 1;
