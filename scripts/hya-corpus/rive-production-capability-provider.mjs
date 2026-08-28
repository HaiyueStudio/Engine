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
  return {
    format: 'haiyue-rive-neutral-capability-evaluation',
    version: 1,
    inputIrSha256: request.inputIrSha256,
    tuple: context.descriptor,
    baseDocument: {
      format: 'haiyue-animation', version: '1.0',
      name: string(artboardFields.name) ?? 'Rive 7.3 imported composition',
      canvas, duration: 2, endBehavior: 'loop', nodes,
    },
    artifacts: [], coverage, bakedTracks: [], assets: [],
    featureLedger: [{
      feature: 'neutral.metadata-preservation', capability: 'hya-core',
      representation: 'native-semantic', count: ir.objects.length,
    }],
    classification: { unclassifiedObjects: 0, unclassifiedProperties: 0, unclassifiedAssets: 0, unclassifiedScripts: 0 },
  };
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
