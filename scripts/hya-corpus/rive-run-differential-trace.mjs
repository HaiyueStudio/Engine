import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runRiveDifferentialTrace } from './rive-differential-trace-runner.mjs';
import { assertFormalRepositoryIdentity, captureRepositoryIdentity } from '../formal-evidence/repository-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rivPath = requiredPath('--riv');
const scenarioPath = requiredPath('--scenario');
const outputDirectory = requiredPath('--out-dir');
const environmentPath = requiredPath('--environment');
const evaluatorPath = requiredPath('--capability-evaluator');
const officialAdapterPath = requiredPath('--official-capture-adapter');
const hyaAdapterPath = requiredPath('--hya-capture-adapter');
const formal = process.argv.includes('--formal');
const assetId = requiredArgument('--asset-id');
const outputRelative = relative(root, outputDirectory).split('\\').join('/');
if (isAbsolute(outputRelative) || outputRelative === '..' || outputRelative.startsWith('../')) throw new Error('--out-dir must remain inside the Engine repository.');
if (formal && Number(process.versions.node.split('.')[0]) < 22) throw new Error('Formal Rive differential evidence requires Node.js 22 or later.');
const repositoryStart = captureRepositoryIdentity(root);
if (formal) assertFormalRepositoryIdentity(repositoryStart, repositoryStart, { label: 'Engine' });
const [evaluator, officialAdapter, hyaAdapter] = await Promise.all([
  loadExport(evaluatorPath, 'capabilityEvaluator'),
  loadExport(officialAdapterPath, 'officialCaptureAdapter'),
  loadExport(hyaAdapterPath, 'hyaCaptureAdapter'),
]);

const [rivBytes, scenarioBytes, environmentBytes, manifestBytes, workloadPlanBytes] = await Promise.all([
  readFile(rivPath), readFile(scenarioPath), readFile(environmentPath),
  readFile(resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json')),
  readFile(resolve(root, 'animation-spec/corpus/rive/rive-g11-workload-plan.json')),
]);
const scenario = JSON.parse(scenarioBytes); const environment = JSON.parse(environmentBytes);
const manifest = JSON.parse(manifestBytes); const workloadPlan = JSON.parse(workloadPlanBytes);
const expected = manifest.formalAssets.find(value => value.id === assetId);
if (!expected) throw new Error(`Asset ${assetId} is not admitted in formalAssets.`);
const rivSha256 = hash(rivBytes);
if (expected.riv.sha256 !== rivSha256 || expected.riv.byteLength !== rivBytes.byteLength) throw new Error(`RIV identity mismatch for ${assetId}.`);
const revision = repositoryStart.revision; const engineDirty = repositoryStart.dirty;
const conversionModule = await import(pathToFileURL(resolve(root, 'animation-spec/dist-test/rive/convert/index.js')).href);
const result = await runRiveDifferentialTrace({
  assetId, rivSha256, rivBytes: new Uint8Array(rivBytes), scenario, scenarioBytes,
  scenarioPath: `${outputRelative}/scenario.json`, artifactPrefix: outputRelative,
  convert: (bytes, signal) => conversionModule.convertRivBytesToHya(bytes, {
    capabilityEvaluator: evaluator,
    selection: scenario.selection,
    signal,
  }),
  officialAdapter, hyaAdapter, environment, workloadPlan,
  workloadPlanSha256: hash(workloadPlanBytes), corpusManifestSha256: hash(manifestBytes),
  tuple: {
    id: manifest.compatibilityTuple.id, oraclePackage: `${manifest.oracle.package}@${manifest.oracle.version}`,
    riveJsSha256: manifest.oracle.riveJsSha256, riveWasmSha256: manifest.oracle.riveWasmSha256,
  },
  engineRevision: revision, engineDirty, generatedAt: new Date().toISOString(),
  evidenceClass: formal ? 'clean-device-candidate' : 'diagnostic', formal,
});
if (formal) assertFormalRepositoryIdentity(repositoryStart, captureRepositoryIdentity(root), { label: 'Engine' });
await mkdir(outputDirectory, { recursive: true });
for (const [path, bytes] of result.artifactBytesByPath) {
  const target = resolve(root, path); const targetRelative = relative(root, target);
  if (isAbsolute(targetRelative) || targetRelative === '..' || targetRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Artifact escaped repository: ${path}`);
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
}
await writeFile(resolve(outputDirectory, 'animation.hya'), result.conversion.hyaBytes);
await writeFile(resolve(outputDirectory, 'animation.hyapkg'), result.conversion.packageBytes);
await writeFile(resolve(outputDirectory, 'conversion-manifest.json'), result.conversion.manifestBytes);
await writeFile(resolve(outputDirectory, 'conversion-report.json'), result.conversion.reportBytes);
await writeFile(resolve(outputDirectory, 'trace.json'), `${JSON.stringify(result.trace, null, 2)}\n`);
await writeFile(resolve(outputDirectory, 'validation.json'), `${JSON.stringify(result.validation, null, 2)}\n`);
console.log(`[rive-differential] ${assetId}: trace=${result.trace.status}, validation=${result.validation.status}, artifacts=${result.artifactBytesByPath.size + 6}.`);
if (result.validation.status !== 'passed') process.exitCode = 1;

async function loadExport(path, name) {
  const module = await import(pathToFileURL(path).href);
  const value = module[name] ?? module.default;
  if (!value) throw new Error(`${path} does not export ${name} or default.`);
  return value;
}
function requiredPath(name) { return resolve(requiredArgument(name)); }
function requiredArgument(name) { const value = process.argv.find(item => item.startsWith(`${name}=`))?.slice(name.length + 1); if (!value) throw new Error(`${name} is required.`); return value; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
