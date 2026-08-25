import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  throw new Error('Usage: node generate-census.mjs <rive-runtime-source> <output-json>');
}

const sourceRoot = resolve(sourceArg);
const outputPath = resolve(outputArg);
const generatedRoot = join(sourceRoot, 'include', 'rive', 'generated');
const registryPath = join(generatedRoot, 'core_registry.hpp');
const luaRoot = join(sourceRoot, 'src', 'lua');

function filesUnder(root, predicate) {
  const result = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) result.push(...filesUnder(path, predicate));
    else if (predicate(path)) result.push(path);
  }
  return result.sort();
}

function posix(path) {
  return path.split(sep).join('/');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function familyFor(baseName, sourcePath) {
  const value = `${sourcePath}/${baseName}`.toLowerCase();
  if (/(scripted|script_input|scriptasset|shaderasset)/.test(value)) return 'scripting-custom-rendering';
  if (/(audio|export_audio)/.test(value)) return 'audio-event';
  if (/(data_bind|viewmodel|semantic|inputs\/|listener|custom_property|open_url_event|\/event)/.test(value)) {
    return 'data-interaction-accessibility';
  }
  if (/(animation\/|state_machine|transition|keyframe|key_frame|blend_state|blend_animation|interpolator)/.test(value)) {
    return 'timeline-state-machine';
  }
  if (/(bones\/|constraints\/|joystick|weight|tendon|skin|mesh)/.test(value)) return 'rig-mesh-constraint';
  if (/(text\/|layout\/|nested_artboard|artboard_component_list|fontasset|imageasset|blobasset|manifestasset|textasset|fileasset|drawableasset|\/assets\/)/.test(value)) {
    return 'text-layout-component-asset';
  }
  if (/(shapes\/|draw_rules|draw_target|clipping_shape|foreground_layout_drawable)/.test(value)) {
    return 'vector-paint-composite';
  }
  return 'import-neutral-ir';
}

const familyContracts = Object.freeze({
  'import-neutral-ir': { goal: 'g02-riv-import-neutral-ir', status: 'partial' },
  'vector-paint-composite': { goal: 'g03-vector-paint-composite-parity', status: 'partial' },
  'rig-mesh-constraint': { goal: 'g04-rig-mesh-constraint-parity', status: 'partial' },
  'text-layout-component-asset': { goal: 'g05-text-layout-component-asset-parity', status: 'partial' },
  'timeline-state-machine': { goal: 'g06-timeline-state-machine-parity', status: 'partial' },
  'data-interaction-accessibility': { goal: 'g07-data-interaction-accessibility-parity', status: 'missing' },
  'audio-event': { goal: 'g08-audio-event-runtime', status: 'partial' },
  'scripting-custom-rendering': { goal: 'g09-sandboxed-scripting-custom-rendering', status: 'missing' },
});

function statusFor(family, baseName, sourcePath) {
  const value = `${sourcePath}/${baseName}`.toLowerCase();
  if (family === 'text-layout-component-asset' && /(layout\/|nested_artboard|artboard_component_list|blobasset|manifestasset)/.test(value)) {
    return 'missing';
  }
  return familyContracts[family].status;
}

function propertyStatusFor(family, baseName, sourcePath, propertyName) {
  const objectStatus = statusFor(family, baseName, sourcePath);
  const directlyRepresentable = new Set([
    'x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity', 'width', 'height',
    'colorValue', 'fillRule', 'strokeWidth', 'cap', 'join', 'miterLimit',
    'dashOffset', 'start', 'end', 'offset', 'isVisible',
  ]);
  if (objectStatus === 'partial' && directlyRepresentable.has(propertyName)) return 'full';
  return objectStatus;
}

function ownership(family, status, kind) {
  const contract = familyContracts[family];
  if (!contract) return null;
  return {
    family,
    hyaStatus: status,
    goal: contract.goal,
    diagnostic: kind === 'script'
      ? 'E_RIVE_SCRIPT_DISABLED'
      : status === 'full'
        ? 'E_RIVE_ORACLE_MISMATCH'
        : kind === 'object'
          ? 'E_RIVE_UNSUPPORTED_OBJECT'
          : 'E_RIVE_UNSUPPORTED_PROPERTY',
    fixtureOwner: contract.goal,
  };
}

const registry = readFileSync(registryPath, 'utf8');
const registeredBases = new Set(
  [...registry.matchAll(/case\s+(\w+Base)::\s*typeKey:/g)].map(match => match[1]),
);
const propertyMembers = new Set(
  [...registry.matchAll(/case\s+(\w+Base)::\s*(\w+)PropertyKey:/g)].map(match => `${match[1]}::${match[2]}`),
);

const headerFiles = filesUnder(generatedRoot, path => path.endsWith('_base.hpp'));
const typesByBase = new Map();
for (const headerPath of headerFiles) {
  const source = readFileSync(headerPath, 'utf8');
  const classMatch = source.match(/class\s+(\w+Base)(?:\s*:\s*public\s+(\w+))?/);
  const typeMatch = source.match(/static\s+const\s+uint16_t\s+typeKey\s*=\s*(\d+)\s*;/);
  if (!classMatch) continue;
  const baseName = classMatch[1];
  const sourcePath = posix(relative(sourceRoot, headerPath));
  const properties = [...source.matchAll(/static\s+(?:const|constexpr)\s+uint16_t\s+(\w+)PropertyKey\s*=\s*(\d+)\s*;/g)]
    .map(match => ({
      name: match[1],
      key: Number(match[2]),
      serialized: new RegExp(`case\\s+${match[1]}PropertyKey:`).test(source),
    }));
  typesByBase.set(baseName, {
    baseName,
    name: baseName.slice(0, -4),
    typeKey: typeMatch ? Number(typeMatch[1]) : null,
    extends: classMatch[2] ?? null,
    sourcePath,
    properties,
  });
}

const objects = [...registeredBases].map(baseName => {
  const type = typesByBase.get(baseName);
  if (!type) throw new Error(`Registered object ${baseName} has no generated type header.`);
  const family = familyFor(baseName, type.sourcePath);
  const status = statusFor(family, baseName, type.sourcePath);
  return {
    typeKey: type.typeKey,
    name: type.name,
    baseName,
    extends: type.extends,
    source: type.sourcePath,
    evidenceClass: 'binary-object-key',
    binaryEvidenceEligible: true,
    ...ownership(family, status, 'object'),
  };
}).sort((a, b) => a.typeKey - b.typeKey || a.name.localeCompare(b.name));

const properties = [...propertyMembers].map(member => {
  const [baseName, propertyName] = member.split('::');
  const type = typesByBase.get(baseName);
  const property = type?.properties.find(item => item.name === propertyName);
  if (!type || !property) throw new Error(`Registry property ${member} has no generated declaration.`);
  const family = familyFor(baseName, type.sourcePath);
  const status = propertyStatusFor(family, baseName, type.sourcePath, property.name);
  return {
    key: property.key,
    name: property.name,
    owner: type.name,
    ownerBase: baseName,
    source: type.sourcePath,
    serialized: property.serialized,
    evidenceClass: property.serialized ? 'binary-property-key' : 'source-census-only',
    binaryEvidenceEligible: property.serialized,
    ...ownership(family, status, 'property'),
  };
}).sort((a, b) => a.key - b.key || a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));

const duplicateObjectKeys = objects.filter((item, index) => index > 0 && item.typeKey === objects[index - 1].typeKey);
const duplicatePropertyKeys = properties.filter((item, index) => index > 0 && item.key === properties[index - 1].key);
if (duplicateObjectKeys.length || duplicatePropertyKeys.length) {
  throw new Error(`Registry keys are not unique: object=${duplicateObjectKeys.length}, property=${duplicatePropertyKeys.length}.`);
}

const luaFiles = filesUnder(luaRoot, path => path.endsWith('.cpp') || path.endsWith('.mm'));
const scriptModules = [];
const scriptSymbols = [];
for (const filePath of luaFiles) {
  const source = readFileSync(filePath, 'utf8');
  const sourcePath = posix(relative(sourceRoot, filePath));
  for (const match of source.matchAll(/\bint\s+(luaopen_[A-Za-z0-9_]+)\s*\(/g)) {
    scriptModules.push({
      name: match[1],
      source: sourcePath,
      evidenceClass: 'behavioral-capability',
      binaryEvidenceEligible: false,
      behavioralEvidenceEligible: true,
      ...ownership('scripting-custom-rendering', 'missing', 'script'),
    });
  }
  const names = new Set();
  for (const match of source.matchAll(/\{\s*"([A-Za-z_][A-Za-z0-9_.:]*)"\s*,/g)) names.add(match[1]);
  for (const match of source.matchAll(/lua_setglobal\s*\([^,]+,\s*"([A-Za-z_][A-Za-z0-9_.:]*)"\s*\)/g)) names.add(match[1]);
  for (const name of names) {
    scriptSymbols.push({
      name,
      source: sourcePath,
      evidenceClass: 'behavioral-capability',
      binaryEvidenceEligible: false,
      behavioralEvidenceEligible: true,
      ...ownership('scripting-custom-rendering', 'missing', 'script'),
    });
  }
}
scriptModules.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
scriptSymbols.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));

const assets = [...typesByBase.values()]
  .filter(type => type.sourcePath.includes('/generated/assets/'))
  .map(type => {
    const family = familyFor(type.baseName, type.sourcePath);
    const status = statusFor(family, type.baseName, type.sourcePath);
    return {
      typeKey: type.typeKey,
      name: type.name,
      baseName: type.baseName,
      extends: type.extends,
      source: type.sourcePath,
      serialized: registeredBases.has(type.baseName),
      evidenceClass: registeredBases.has(type.baseName) ? 'binary-asset-type' : 'source-census-only',
      binaryEvidenceEligible: registeredBases.has(type.baseName),
      ...ownership(family, status, 'object'),
    };
  })
  .sort((a, b) => a.typeKey - b.typeKey || a.name.localeCompare(b.name));
const sourceInputs = [registryPath, ...headerFiles, ...luaFiles].sort();
const sourceDigest = sha256(sourceInputs.map(path => `${posix(relative(sourceRoot, path))}\0${sha256(readFileSync(path))}`).join('\n'));
const unclassifiedObjects = objects.filter(item => !item.family || !item.goal || !item.diagnostic || !item.fixtureOwner);
const unclassifiedProperties = properties.filter(item => !item.family || !item.goal || !item.diagnostic || !item.fixtureOwner);
const unclassifiedScripts = [...scriptModules, ...scriptSymbols]
  .filter(item => !item.family || !item.goal || !item.diagnostic || !item.fixtureOwner);
const unclassifiedAssets = assets.filter(item => !item.family || !item.goal || !item.diagnostic || !item.fixtureOwner);

const census = {
  schemaVersion: 1,
  compatibilityTupleId: 'rive-7.3-webgl2-2.40.0',
  source: {
    repository: 'https://github.com/rive-app/rive-runtime',
    publicCommit: '526625850eaf34fc1263d181808ffca10cae6ac1',
    riveHead: 'ee809ba7f032271dd7102f17afe3baf9d192435b',
    registry: 'include/rive/generated/core_registry.hpp',
    inputFileCount: sourceInputs.length,
    inputDigestSha256: sourceDigest,
  },
  totals: {
    objectTypes: objects.length,
    propertyKeys: properties.length,
    serializedPropertyKeys: properties.filter(item => item.serialized).length,
    sourceOnlyPropertyKeys: properties.filter(item => !item.serialized).length,
    scriptModules: scriptModules.length,
    scriptSymbols: scriptSymbols.length,
    assetTypes: assets.length,
    serializedAssetTypes: assets.filter(item => item.serialized).length,
    sourceOnlyAssetTypes: assets.filter(item => !item.serialized).length,
    unclassifiedObjects: unclassifiedObjects.length,
    unclassifiedProperties: unclassifiedProperties.length,
    unclassifiedScripts: unclassifiedScripts.length,
    unclassifiedAssets: unclassifiedAssets.length,
  },
  coverageEvidenceModel: {
    contractRevision: 2,
    sourceCensus: {
      rule: 'Every frozen registry/source definition remains classified, including entries that cannot occur as serialized .riv keys.',
      requiredForClassificationClosure: true,
      requiredAsFormalAssetWireCoverage: false,
    },
    binaryEvidence: {
      rule: 'Only registry-instantiable object keys, generated deserialize property cases, and registry-instantiable asset types are eligible for .riv encounter coverage.',
      objectTypes: objects.length,
      propertyKeys: properties.filter(item => item.serialized).length,
      assetTypes: assets.filter(item => item.serialized).length,
    },
    behavioralEvidence: {
      rule: 'Luau registration modules and symbols are source capabilities, not .riv wire keys; formal closure requires feature-family behavior probes and differential traces instead of raw-key encounter claims.',
      scriptModules: scriptModules.length,
      scriptSymbols: scriptSymbols.length,
      featureFamilies: Object.keys(familyContracts).length,
    },
  },
  statusVocabulary: ['full', 'partial', 'missing'],
  familyContracts,
  objects,
  properties,
  scripts: { modules: scriptModules, symbols: scriptSymbols },
  assets,
};

if (unclassifiedObjects.length || unclassifiedProperties.length || unclassifiedScripts.length || unclassifiedAssets.length) {
  throw new Error(`Unclassified census entries: objects=${unclassifiedObjects.length}, properties=${unclassifiedProperties.length}, scripts=${unclassifiedScripts.length}, assets=${unclassifiedAssets.length}.`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(census, null, 2)}\n`);
console.log(JSON.stringify(census.totals));
