import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceArgument = argument('--source-root');
const archiveArgument = argument('--archive');
const outputArgument = argument('--out');
const sourceId = argument('--source-id') ?? 'rive-wasm-oracle-githead-examples';
if (!sourceArgument || !archiveArgument) {
  throw new Error('Usage: node scripts/hya-corpus/rive-inventory-upstream-diagnostics.mjs --source-id=<id> --source-root=<extracted source> --archive=<source.zip> [--out=<candidate.json>]');
}
const sourceRoot = resolve(sourceArgument);
const archivePath = resolve(archiveArgument);
const expectedSources = new Map([
  ['rive-wasm-oracle-githead-examples', {
    repository: 'https://github.com/rive-app/rive-wasm',
    revision: '1e9391880df1d501b98d165d2db89284025462eb',
    archiveSha256: '0e0e27771a1bcd8d7f7f5d3c3f1e54c5c063948c4ebf41786978e1d9ca83e71a',
    licenseSha256: '8a1efa755d19446b51a18e1c15f6308728da0b36283c4d38050698ad6954b69a',
  }],
  ['rive-runtime-frozen-source-tests', {
    repository: 'https://github.com/rive-app/rive-runtime',
    revision: '526625850eaf34fc1263d181808ffca10cae6ac1',
    archiveSha256: '67b05558f8d49a0568533e753501f2e1586160d088020d4f88158f10a537207f',
    licenseSha256: 'fa43eb0d7fbf66f9504182d92dd097311278bb80111a5bf1403c366d6a403144',
  }],
  ['rive-runtime-official-7-3-evidence-inputs', {
    repository: 'https://github.com/rive-app/rive-runtime',
    revision: '3f4047a85f11fecfde8c4d906c0c1654aa12b015',
    archiveSha256: '021a49ed83ddda9a5e476d8c3a165c0eb44960e6719e751f4711b6b8befe1062',
    licenseSha256: 'fa43eb0d7fbf66f9504182d92dd097311278bb80111a5bf1403c366d6a403144',
  }],
]);
const expected = expectedSources.get(sourceId);
if (!expected) throw new Error(`Unknown diagnostic upstream source ${sourceId}.`);
if (hash(readFileSync(archivePath)) !== expected.archiveSha256) throw new Error(`${sourceId} source archive hash does not match the frozen policy.`);
if (hash(readFileSync(resolve(sourceRoot, 'LICENSE'))) !== expected.licenseSha256) throw new Error(`${sourceId} LICENSE hash does not match the diagnostic source policy.`);
const modulePath = resolve(root, 'animation-spec/dist-test/conversion/rive-ir/index.js');
let rive;
try {
  rive = await import(pathToFileURL(modulePath).href);
} catch (error) {
  throw new Error('Build animation-spec conversion tests before inventorying upstream diagnostics.', { cause: error });
}

const paths = walk(sourceRoot).filter(path => path.toLowerCase().endsWith('.riv')).sort();
const assets = [];
const objectKeys = new Set();
const propertyKeys = new Set();
for (const path of paths) {
  const bytes = readFileSync(path);
  const record = {
    path: relative(sourceRoot, path).split('\\').join('/'),
    byteLength: bytes.byteLength,
    sha256: hash(bytes),
    result: null,
  };
  try {
    const imported = await rive.importFrozenRiv(new Uint8Array(bytes));
    for (const key of imported.report.registryCoverage.encounteredObjectTypeKeys) objectKeys.add(key);
    for (const key of imported.report.registryCoverage.encounteredPropertyKeys) propertyKeys.add(key);
    record.result = {
      status: 'accepted',
      objects: imported.report.counts.objects,
      runtimeNullObjects: imported.report.counts.runtimeNullObjects,
      runtimeNullObjectKeys: imported.report.runtimeNullObjects.map(value => value.sourceTypeKey),
      propertyAssignments: imported.report.counts.propertyAssignments,
      objectKeys: imported.report.registryCoverage.encounteredObjectTypeKeys,
      propertyKeys: imported.report.registryCoverage.encounteredPropertyKeys,
      categories: Object.fromEntries([
        'artboards', 'instances', 'drawables', 'resources', 'geometry', 'paints', 'rigs', 'constraints',
        'layouts', 'text', 'timelines', 'stateMachines', 'dataModels', 'interactions', 'events',
        'audioSchedules', 'semantics', 'sandboxPrograms',
      ].map(key => [key, imported.ir[key].length])),
    };
  } catch (error) {
    record.result = {
      status: 'rejected',
      code: error instanceof rive.RiveImportError ? error.code : 'E_RIVE_UNCLASSIFIED_DIAGNOSTIC',
      path: error instanceof rive.RiveImportError ? error.path : '$',
      ...(error instanceof rive.RiveImportError ? { context: error.context } : {}),
    };
  }
  assets.push(record);
}
const rejectedByCode = {};
for (const asset of assets.filter(value => value.result.status === 'rejected')) {
  rejectedByCode[asset.result.code] = (rejectedByCode[asset.result.code] ?? 0) + 1;
}
const revision = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']).length > 0;
const report = {
  schemaVersion: 1,
  kind: 'haiyue-rive-upstream-diagnostic-inventory',
  formalEvidence: false,
  formalDisqualifier: 'This aggregate inventory sweep is diagnostic. An individual official path becomes eligible only through an explicit immutable source entry plus a formal workload and validated oracle/HYA artifacts.',
  generatedAt: new Date().toISOString(),
  engineRevision: revision,
  engineDirty: dirty,
  source: {
    id: sourceId,
    repository: expected.repository,
    revision: expected.revision,
    archiveSha256: expected.archiveSha256,
    licenseId: 'MIT',
    licenseSha256: expected.licenseSha256,
  },
  totals: {
    assets: assets.length,
    accepted: assets.filter(value => value.result.status === 'accepted').length,
    rejected: assets.filter(value => value.result.status === 'rejected').length,
    rejectedByCode,
    coveredObjectKeys: objectKeys.size,
    coveredPropertyKeys: propertyKeys.size,
    unclassifiedFailureCount: rejectedByCode.E_RIVE_UNCLASSIFIED_DIAGNOSTIC ?? 0,
  },
  assets,
};
if (outputArgument) {
  const output = resolve(root, outputArgument);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[rive-corpus] diagnostic upstream inventory written to ${relative(root, output)}.`);
}
console.log(
  `[rive-corpus] upstream diagnostics: assets=${report.totals.assets}, accepted=${report.totals.accepted}, `
  + `rejected=${report.totals.rejected}, objects=${report.totals.coveredObjectKeys}/288, `
  + `properties=${report.totals.coveredPropertyKeys}/618, unclassified=${report.totals.unclassifiedFailureCount}.`,
);

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function argument(name) {
  return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
