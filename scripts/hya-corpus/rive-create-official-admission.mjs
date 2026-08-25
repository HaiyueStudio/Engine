import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRiveFullWorkloadScenario } from './rive-workload-scenario-builder.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
const planPath = resolve(root, 'animation-spec/corpus/rive/rive-g11-workload-plan.json');
const inventoryPath = resolve(root, 'review/candidates/rive-official-7-3-input-inventory-diagnostic.json');
const oraclePath = resolve(root, 'review/candidates/rive-official-7-3-load-chrome-diagnostic.json');
const edgeOraclePath = resolve(root, 'review/candidates/rive-official-7-3-load-edge-diagnostic.json');
const outputPath = resolve(root, 'review/candidates/rive-official-7-3-admission-diagnostic.json');
const workloadRoot = resolve(root, 'animation-spec/corpus/rive/workloads');
const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const planBytes = readFileSync(planPath);
const plan = JSON.parse(planBytes);
const inventoryBytes = readFileSync(inventoryPath);
const inventory = JSON.parse(inventoryBytes);
const oracleBytes = readFileSync(oraclePath);
const oracle = JSON.parse(oracleBytes);
const edgeOracleBytes = readFileSync(edgeOraclePath);
const edgeOracle = JSON.parse(edgeOracleBytes);
mkdirSync(workloadRoot, { recursive: true });

const inventoryByPath = new Map(inventory.assets.map(value => [value.path, value]));
const oracleByPath = new Map(oracle.results.map(value => [value.path, value]));
const edgeOracleByPath = new Map(edgeOracle.results.map(value => [value.path, value]));
const assets = [];
for (const source of manifest.officialAssetSources) {
  const inventoryAsset = required(inventoryByPath.get(source.path), `inventory ${source.path}`);
  const oracleOuter = required(oracleByPath.get(source.path), `oracle ${source.path}`);
  const oracleAsset = required(oracleOuter.result?.results?.[0], `oracle result ${source.path}`);
  const edgeOracleOuter = required(edgeOracleByPath.get(source.path), `Edge oracle ${source.path}`);
  const edgeOracleAsset = required(edgeOracleOuter.result?.results?.[0], `Edge oracle result ${source.path}`);
  if (oracleOuter.status !== 'completed' || oracleAsset.status !== 'loaded') throw new Error(`${source.id} was not loaded by the official oracle.`);
  if (edgeOracleOuter.status !== 'completed' || edgeOracleAsset.status !== 'loaded') throw new Error(`${source.id} was not loaded by the official Edge oracle.`);
  const selected = selectArtboard(oracleAsset.artboards);
  const input = selected.stateMachine.inputs?.[0] ?? null;
  const scenario = createRiveFullWorkloadScenario(plan, {
    id: `${source.id}-full-workload`,
    assetId: source.id,
    rivSha256: source.sha256,
    selection: {
      artboard: selected.artboard.name,
      animation: selected.artboard.animations?.[0] ?? null,
      stateMachine: selected.stateMachine.name,
    },
    initialData: {
      harnessProbe: { value: 0 },
      sourceStateMachineInput: input ? { name: input.name, type: input.type, initialValue: input.value ?? null } : null,
    },
    initialResources: [{
      id: 'harness-empty-resource', sha256: emptySha256, revision: 'sha256-empty-v1',
      mimeType: 'application/octet-stream', byteLength: 0,
    }],
    probe: {
      dataMutation: input
        ? { operation: input.type === 'trigger' ? 'trigger' : 'set', path: `stateMachine.${input.name}`, ...(input.type === 'trigger' ? {} : { value: input.type === 'boolean' ? true : 1 }) }
        : { operation: 'set', path: 'harnessProbe.value', value: 1 },
      pointer: pointerProbe(selected.artboard.bounds),
      keyboard: { code: 'Enter', key: 'Enter' },
      gamepad: { index: 0, axes: [0, 0], buttons: [1] },
      focusTarget: `artboard:${selected.artboard.name}`,
      semanticTarget: `artboard:${selected.artboard.name}`,
      resource: {
        resourceId: 'harness-empty-resource', missingResourceId: 'harness-missing-resource',
        expectedSha256: emptySha256, invalidSha256: '0'.repeat(64),
        appliedRevision: 'sha256-empty-v1', missingRevision: 'missing-v1', integrityRevision: 'invalid-v1',
      },
    },
  });
  const scenarioBytes = Buffer.from(`${JSON.stringify(scenario, null, 2)}\n`);
  const scenarioPath = `animation-spec/corpus/rive/workloads/${source.id}.json`;
  writeFileSync(resolve(root, scenarioPath), scenarioBytes);
  const accepted = inventoryAsset.result?.status === 'accepted';
  assets.push({
    id: source.id,
    source: {
      repository: source.repository, commit: source.commit, path: source.path,
      sourceUrl: source.sourceUrl, downloadUrl: source.downloadUrl,
      sha256: source.sha256, byteLength: source.byteLength, license: source.license,
    },
    officialOracle: {
      status: 'loaded', browsers: ['chrome', 'edge'], runtime: '@rive-app/webgl2@2.40.0',
      selectedArtboard: selected.artboard.name,
      selectedAnimation: selected.artboard.animations?.[0] ?? null,
      selectedStateMachine: selected.stateMachine.name,
      selectedStateMachineInputs: selected.stateMachine.inputs ?? [],
      artboardCount: oracleAsset.artboards.length,
    },
    hyaImport: accepted ? { status: 'accepted' } : {
      status: 'rejected', code: inventoryAsset.result?.code, path: inventoryAsset.result?.path,
      owner: 'g02-riv-import-neutral-ir',
    },
    featureCoverage: accepted ? {
      status: 'captured', objectKeys: inventoryAsset.result.objectKeys,
      propertyKeys: inventoryAsset.result.propertyKeys, categories: inventoryAsset.result.categories,
    } : {
      status: 'blocked-by-strict-import', objectKeys: [], propertyKeys: [],
      blocker: `${inventoryAsset.result?.code} at ${inventoryAsset.result?.path}`,
    },
    workloadScenario: {
      path: scenarioPath, sha256: hash(scenarioBytes), byteLength: scenarioBytes.byteLength,
      sourceInputBinding: input ? 'state-machine-input' : 'harness-no-source-input',
    },
    differentialTrace: {
      status: 'not-run',
      blocker: accepted
        ? 'The production raw-RIV capability-evaluation and v2 differential orchestration exists, but no admitted revision-pinned full-fidelity evaluator plus native official/HYA capture adapters has completed this workload.'
        : 'HaiYue strict import rejects this input before HYA evaluation; the red result is retained as formal-input admission evidence.',
    },
  });
}

if (process.argv.includes('--update-manifest')) {
  manifest.workloadPlan.sha256 = hash(planBytes);
  manifest.workloadPlan.byteLength = planBytes.byteLength;
  manifest.formalAssets = assets.map(asset => formalAsset(asset, manifest.officialAssetSources.find(source => source.id === asset.id)));
  manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(manifestPath, manifestBytes);
}

const revision = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']).length > 0;
const report = {
  schemaVersion: 1,
  kind: 'haiyue-rive-official-input-admission',
  status: 'blocked-before-differential-trace',
  formalEvidence: false,
  evidenceClass: dirty ? 'dirty-worktree-diagnostic' : 'clean-revision-candidate',
  generatedAt: new Date().toISOString(),
  engineRevision: revision,
  engineDirty: dirty,
  nodeVersion: process.version,
  corpusManifest: reference(relative(root, manifestPath), manifestBytes),
  workloadPlan: reference(relative(root, planPath), planBytes),
  officialLoadRun: reference(relative(root, oraclePath), oracleBytes),
  officialEdgeLoadRun: reference(relative(root, edgeOraclePath), edgeOracleBytes),
  importerInventoryRun: reference(relative(root, inventoryPath), inventoryBytes),
  totals: {
    inputs: assets.length,
    officialLoaded: assets.filter(value => value.officialOracle.status === 'loaded').length,
    importerAccepted: assets.filter(value => value.hyaImport.status === 'accepted').length,
    importerRejected: assets.filter(value => value.hyaImport.status === 'rejected').length,
    workloadScenarios: assets.length,
    differentialTraces: 0,
    unclassifiedFailures: 0,
  },
  assets,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[rive-corpus] official admission record written to ${relative(root, outputPath)}; loaded=${report.totals.officialLoaded}, accepted=${report.totals.importerAccepted}, rejected=${report.totals.importerRejected}, workloads=${report.totals.workloadScenarios}.`);

function selectArtboard(artboards) {
  const candidates = artboards.flatMap(artboard => artboard.stateMachines.map(stateMachine => ({ artboard, stateMachine })));
  if (candidates.length === 0) throw new Error('Official asset contains no state machine selection.');
  return candidates.sort((left, right) => (right.stateMachine.inputCount ?? 0) - (left.stateMachine.inputCount ?? 0))[0];
}

function formalAsset(asset, source) {
  const profiles = {
    'official-game-menu-ad-police-files': { kind: 'combined-stress', featureFamilies: ['timeline-state-machine', 'data-interaction-accessibility'] },
    'official-inventory-demo-v2': { kind: 'combined-stress', featureFamilies: ['text-layout-component-asset', 'timeline-state-machine', 'data-interaction-accessibility'] },
    'official-joystick-databound-keyframe': { kind: 'feature-isolated', featureFamilies: ['rig-mesh-constraint'] },
    'official-grid-placement-bound': { kind: 'feature-isolated', featureFamilies: ['text-layout-component-asset'] },
    'official-eight-planets-grid': { kind: 'combined-stress', featureFamilies: ['text-layout-component-asset', 'timeline-state-machine', 'data-interaction-accessibility'] },
    'official-text-fit': { kind: 'property-boundary', featureFamilies: ['text-layout-component-asset'] },
    'official-text-style-background': { kind: 'property-boundary', featureFamilies: ['vector-paint-composite', 'text-layout-component-asset'] },
    'official-double-library-with-image': { kind: 'feature-isolated', featureFamilies: ['text-layout-component-asset'] },
  };
  const profile = required(profiles[asset.id], `admission profile ${asset.id}`);
  const accepted = asset.hyaImport.status === 'accepted';
  return {
    id: asset.id,
    kind: profile.kind,
    sourceIdentity: { kind: 'official-git', officialAssetSourceId: source.id },
    storagePolicy: 'remote-hash-pinned-no-vendoring',
    riv: { sourceUrl: source.downloadUrl, sha256: source.sha256, byteLength: source.byteLength },
    externalAssets: [],
    license: {
      id: source.license.id,
      evidence: source.license.evidence,
      visibility: 'public-redistributable',
      attribution: `Rive official runtime fixture ${source.path}; MIT; commit ${source.commit}.`,
      allowedUses: {
        import: true,
        modificationAndDerivative: true,
        automatedOracleExecution: true,
        ciStorage: true,
        screenshotAndAudioEvidence: true,
        hyaRedistribution: true,
      },
    },
    featureFamilies: profile.featureFamilies,
    objectKeys: asset.featureCoverage.objectKeys,
    propertyKeys: asset.featureCoverage.propertyKeys,
    scriptModuleKeys: [],
    scriptSymbolKeys: [],
    assetTypeKeys: [],
    fixtureOwner: accepted ? 'g11-corpus-version-fidelity-performance' : 'g02-riv-import-neutral-ir',
    oracleTraceId: `${asset.id}-differential-v2`,
    officialOracleEvidence: {
      status: 'loaded',
      ...reference(relative(root, oraclePath), oracleBytes),
      resultSelector: `results[path=${source.path}]`,
    },
    officialOracleCrossBrowserEvidence: {
      status: 'loaded',
      ...reference(relative(root, edgeOraclePath), edgeOracleBytes),
      resultSelector: `results[path=${source.path}]`,
    },
    featureCoverageEvidence: {
      status: asset.featureCoverage.status,
      ...reference(relative(root, inventoryPath), inventoryBytes),
      resultSelector: `assets[path=${source.path}]`,
    },
    workloadScenario: asset.workloadScenario,
    admissionResult: accepted ? {
      status: 'workload-recorded-trace-blocked',
      blocker: asset.differentialTrace.blocker,
    } : {
      status: 'formal-red-import-failure',
      diagnostic: asset.hyaImport.code,
      path: asset.hyaImport.path,
      blocker: asset.differentialTrace.blocker,
    },
  };
}

function pointerProbe(bounds) {
  const minX = Number(bounds?.minX ?? 0), minY = Number(bounds?.minY ?? 0);
  const maxX = Number(bounds?.maxX ?? minX + 1), maxY = Number(bounds?.maxY ?? minY + 1);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, deltaX: 1, deltaY: 1, pointerId: 1, buttons: 1 };
}

function reference(path, bytes) {
  return { path: path.split('\\').join('/'), sha256: hash(bytes), byteLength: bytes.byteLength };
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function required(value, label) { if (!value) throw new Error(`Missing ${label}.`); return value; }
function git(args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
