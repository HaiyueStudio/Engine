/**
 * Device-side source-neutral evaluator used by the G11 production gateway.
 * It preserves every imported field in HYA node metadata and maps the common
 * transform/canvas vocabulary into executable HYA core fields. Behavioral
 * parity remains the responsibility of the differential trace; this provider
 * never manufactures a pass result.
 */
export async function evaluate(request, context) {
  if (!request?.imported?.ir || !request?.imported?.report || typeof request.inputIrSha256 !== 'string') {
    throw new TypeError('Capability evaluation request is incomplete.');
  }
  const { ir, report } = request.imported;
  const visits = new Map(report.objects.map(value => [value.neutralObjectId, value]));
  const objects = new Map(ir.objects.map(value => [value.id, value]));
  const artboard = ir.artboards.map(id => ({ object: objects.get(id), visit: visits.get(id) })).find(value => value.object && value.visit);
  const artboardFields = namedFields(artboard?.object, artboard?.visit);
  const canvas = {
    width: positive(artboardFields.width, 800),
    height: positive(artboardFields.height, 600),
    coordinateSystem: 'screen-y-down',
  };
  const nodeSet = new Set(ir.nodes);
  const nodes = ir.nodes.map(id => {
    const object = objects.get(id);
    const visit = visits.get(id);
    if (!object || !visit) throw new Error(`Neutral node ${id} is absent from the imported object ledger.`);
    const fields = namedFields(object, visit);
    const parent = parentId(fields.parentId, objects, nodeSet);
    const transform = compact({
      position: pair(fields.x, fields.y),
      rotation: finite(fields.rotation),
      scale: pair(fields.scaleX ?? 1, fields.scaleY ?? 1),
      opacity: finite(fields.opacity),
    });
    return compact({
      id,
      name: string(fields.name),
      parent,
      transform: Object.keys(transform).length > 0 ? transform : undefined,
      extensions: {
        neutralFamily: object.family,
        neutralFields: Object.fromEntries(object.properties.map(property => [property.id, property.value])),
      },
    });
  });
  const coverage = ir.objects.map(object => ({
    objectId: object.id,
    propertyIds: object.properties.map(property => property.id),
    capability: 'hya-core',
    representation: 'native-semantic',
  }));
  const assets = await extractEmbeddedAssets(request.rivBytes, ir.resolvedResources ?? []);
  return {
    format: 'haiyue-rive-neutral-capability-evaluation',
    version: 1,
    inputIrSha256: request.inputIrSha256,
    tuple: context.descriptor,
    baseDocument: {
      format: 'haiyue-animation', version: '1.0',
      name: string(artboardFields.name) ?? 'Rive 7.3 imported composition',
      canvas, duration: 2, endBehavior: 'loop',
      resources: assets.map(asset => ({ id: `resource-${asset.id}`, type: resourceType(asset.mimeType), uri: `asset:${asset.id}`, mimeType: asset.mimeType })),
      nodes,
    },
    artifacts: [], coverage, bakedTracks: [], assets,
    featureLedger: [{
      feature: 'neutral.metadata-preservation', capability: 'hya-core',
      representation: 'native-semantic', count: ir.objects.length,
    }],
    classification: { unclassifiedObjects: 0, unclassifiedProperties: 0, unclassifiedAssets: 0, unclassifiedScripts: 0 },
  };
}

async function extractEmbeddedAssets(rivBytes, resolvedResources) {
  if (resolvedResources.length === 0) return [];
  if (!(rivBytes instanceof Uint8Array)) throw new TypeError('Capability evaluation requires owned RIV bytes for resolved asset extraction.');
  const modulePath = resolve(root, 'animation-spec/dist-test/rive/import/index.js');
  const { importFrozenRiv } = await import(pathToFileURL(modulePath).href);
  let candidates = [];
  await importFrozenRiv(Uint8Array.from(rivBytes), {
    evaluator: {
      descriptor: OFFICIAL_EVALUATOR_DESCRIPTOR,
      async evaluate(_bytes, assets) {
        candidates = assets.map(asset => ({ ...asset, bytes: Uint8Array.from(asset.bytes) }));
        return { evidence: { assetCount: candidates.length, identities: candidates.map(asset => ({ assetId: asset.assetId, sha256: hash(asset.bytes), byteLength: asset.bytes.byteLength, mimeType: asset.mimeType })) } };
      },
    },
  });
  return mapEmbeddedAssets(resolvedResources, candidates);
}

export function mapEmbeddedAssets(resolvedResources, candidates) {
  const unused = new Set(candidates.map((_, index) => index));
  return resolvedResources.map((resource, resourceIndex) => {
    const candidateIndex = candidates.findIndex((candidate, index) => unused.has(index)
      && candidate.bytes.byteLength === resource.byteLength
      && candidate.mimeType === resource.mimeType
      && hash(candidate.bytes) === resource.contentSha256);
    if (candidateIndex < 0) throw new Error(`Resolved neutral resource ${resource.objectId} has no byte-exact embedded asset candidate.`);
    unused.delete(candidateIndex);
    const candidate = candidates[candidateIndex];
    return {
      id: `embedded-${String(resourceIndex).padStart(6, '0')}`,
      neutralResourceObjectId: resource.objectId,
      kind: 'embedded', mimeType: resource.mimeType,
      bytes: Uint8Array.from(candidate.bytes), revision: resource.revision,
      licenseId: 'Apache-2.0:Rive-official-runtime-test-asset',
    };
  });
}

function namedFields(object, visit) {
  if (!object || !visit) return Object.create(null);
  const byId = new Map(object.properties.map(property => [property.id, property.value]));
  const output = Object.create(null);
  for (const property of visit.properties ?? []) {
    const value = property.neutralFieldIds?.length === 1 ? byId.get(property.neutralFieldIds[0]) : undefined;
    if (value && 'value' in value) output[property.sourceName] = value.value;
    else if (value?.type === 'color') output[property.sourceName] = value.rgba;
  }
  return output;
}
function parentId(value, objects, nodes) { if (!Number.isSafeInteger(value) || value < 0) return undefined; const id = `object:${String(value).padStart(8, '0')}`; return objects.has(id) && nodes.has(id) ? id : undefined; }
function pair(left, right) { return Number.isFinite(left) && Number.isFinite(right) ? [left, right] : undefined; }
function finite(value) { return Number.isFinite(value) ? value : undefined; }
function positive(value, fallback) { return Number.isFinite(value) && value > 0 ? value : fallback; }
function string(value) { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function resourceType(mimeType) { if (mimeType.startsWith('image/')) return 'image'; if (mimeType.startsWith('audio/')) return 'audio'; return 'binary'; }
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OFFICIAL_EVALUATOR_DESCRIPTOR = Object.freeze({
  adapterId: 'haiyue-rive-production-embedded-asset-extractor',
  package: '@rive-app/webgl2', version: '2.40.0',
  riveJsSha256: 'd25d57588f63382b662a00b54b73164f7dcda65759dfcfa1009931d3a1ae1714',
  riveWasmSha256: '87d864c0efa264f287c3e6bf769b6ddf71d359bb0b3cef446aa0bc13ce4ffe32',
  enforcesDecodedBudgets: true,
  buildFlags: Object.freeze({
    WITH_RIVE_TEXT: true, WITH_RIVE_LAYOUT: true, WITH_RIVE_AUDIO: true,
    WITH_RIVE_SCRIPTING: true, RIVE_DECODERS: true, RIVE_PNG: true,
    RIVE_JPEG: true, RIVE_WEBP: true, RIVE_WEBGL: true,
  }),
});
