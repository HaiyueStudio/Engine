import { runChromeWebGpuFixture } from './chrome-runner.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseDeferredFixtureOptions, deferredRuntimeFingerprint, deferredHarnessFingerprint, validateDeferredFixtureEvidence, sha256 } from './deferred-fixture-policy.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options=parseDeferredFixtureOptions(process.argv.slice(2)),{preference}=options;
const full=options.mode==='reference',room=options.mode==='room';
const build=JSON.parse(await readFile(resolve(root,'artifacts/engine-0.2.1/g02/fixture-build.json'),'utf8'));
const inputs=await deferredRuntimeFingerprint(root),harness=await deferredHarnessFingerprint(root);
if(build.schemaVersion!==1||build.inputs.sha256!==inputs.sha256)throw new Error('Stale Deferred runtime; rebuild the fixture.');
for(const output of build.outputs)if(sha256(await readFile(resolve(root,'artifacts/engine-0.2.1/g02',output.file)))!==output.sha256)throw new Error(`Stale runtime chunk ${output.file}.`);
const fixture = await readFile(resolve(root, 'artifacts/engine-0.2.1/g02/fixture.js'));
const result = await runChromeWebGpuFixture({ root, fixture: 'scripts/webgpu-gate/deferred-reference-fixture.html',
  query: { powerPreference: preference, full: full ? 1 : 0, room: room ? 1 : 0 }, timeoutMs: full ? 240000 : 120000,
  acceptedStatuses: ['passed', 'failed'],
  visualCapture: room ? { viewportWidth: 1320, viewportHeight: 900 } : null });
if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256||harness.sha256!==(await deferredHarnessFingerprint(root)).sha256)throw new Error('Deferred inputs changed during capture; evidence rejected.');
const evidence = { schemaVersion: 1, tier: options.tier, generatedAt: new Date().toISOString(), inputs,harness,build,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  fixtureSha256: createHash('sha256').update(fixture).digest('hex'), result };
const path = resolve(root, `artifacts/engine-0.2.1/g02/${room ? 'room' : full ? 'reference' : 'smoke'}-${preference}.json`);
if (result.visualCapture?.pngBase64) {
  await writeFile(path.replace('.json', '.png'), Buffer.from(result.visualCapture.pngBase64, 'base64'));
  delete result.visualCapture.pngBase64;
}
const archivePath=path.replace('.json',`-${result.status}-${evidence.generatedAt.replaceAll(':','-')}.json`);
await writeFile(archivePath, JSON.stringify(evidence, null, 2) + '\n', {flag:'wx'});
if(result.status!=='passed') console.error(JSON.stringify({archivePath,error:result.error??result}));
validateDeferredFixtureEvidence(result,options);
await writeFile(path, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ path, adapter: result.adapter, cases: result.cases.map(c => ({ count: c.count, pixel: c.pixel })) }));
