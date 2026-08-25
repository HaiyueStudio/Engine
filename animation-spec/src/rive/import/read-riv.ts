import { RivBinaryReader } from './binary-reader.js';
import { RiveImportError } from './error.js';
import {
  FROZEN_OBJECTS,
  FROZEN_PROPERTIES,
  type FrozenObjectRecord,
  type FrozenPropertyRecord,
} from './generated/frozen-registry.js';
import type {
  NeutralProperty,
  NeutralValue,
  RiveImportDiagnosticContext,
  RiveImportLimits,
  RiveObjectVisit,
  RivePropertyVisit,
  RiveRuntimeNullObjectVisit,
} from './types.js';

const OBJECT_BY_KEY = new Map(FROZEN_OBJECTS.map(object => [object.typeKey, object]));
const PROPERTY_BY_KEY = new Map(FROZEN_PROPERTIES.map(property => [property.key, property]));
const EXPECTED_TOC_TYPE = Object.freeze({
  uint: 0,
  int: 0,
  bool: 0,
  string: 1,
  bytes: 1,
  double: 2,
  color: 3,
} as const);

export interface ParsedProperty {
  readonly source: FrozenPropertyRecord;
  readonly neutral: NeutralProperty;
  readonly rawBytes?: Uint8Array;
  readonly stringValue?: string;
  readonly numberValue?: number;
}

export interface ParsedObject {
  readonly source: FrozenObjectRecord;
  readonly sourceObjectIndex: number;
  readonly neutralObjectId: string;
  readonly properties: readonly ParsedProperty[];
  readonly visit: RiveObjectVisit;
}

export interface ParsedRiv {
  readonly fileId: number;
  readonly toc: readonly Readonly<{ sourcePropertyKey: number; fieldType: 0 | 1 | 2 | 3; status: 'consumed-type-declaration' }>[];
  readonly objects: readonly ParsedObject[];
  readonly runtimeNullObjects: readonly RiveRuntimeNullObjectVisit[];
  readonly estimatedWorkingSetBytes: number;
  readonly counts: Readonly<{
    propertyAssignments: number;
    strings: number;
    textBytes: number;
    embeddedBytes: number;
    listItems: number;
  }>;
}

interface MutableCounts {
  propertyAssignments: number;
  strings: number;
  textBytes: number;
  embeddedBytes: number;
  listItems: number;
  workingSetBytes: number;
}

interface HierarchyObject {
  readonly sourceObjectIndex: number;
  readonly source: FrozenObjectRecord;
  readonly parentId: number;
}

export function readFrozenRiv(
  bytes: Uint8Array,
  limits: RiveImportLimits,
  baseContext: RiveImportDiagnosticContext,
): ParsedRiv {
  const reader = new RivBinaryReader(bytes, baseContext);
  const fingerprint = String.fromCharCode(
    reader.readByte('$.riv.header.fingerprint[0]'),
    reader.readByte('$.riv.header.fingerprint[1]'),
    reader.readByte('$.riv.header.fingerprint[2]'),
    reader.readByte('$.riv.header.fingerprint[3]'),
  );
  if (fingerprint !== 'RIVE') {
    throw new RiveImportError('E_RIVE_INVALID_FINGERPRINT', 'Rive fingerprint must be RIVE.', '$.riv.header.fingerprint', baseContext);
  }

  const major = reader.readVarUint('$.riv.header.major', 0x7fff_ffff);
  const minor = reader.readVarUint('$.riv.header.minor', 0x7fff_ffff);
  const context = Object.freeze({ ...baseContext, formatMajor: major, formatMinor: minor });
  reader.setContext(context);
  if (major !== 7) {
    throw new RiveImportError('E_RIVE_FORMAT_MAJOR_UNSUPPORTED', 'Only frozen Rive format major 7 is accepted.', '$.riv.header.major', context);
  }
  if (minor !== 3) {
    throw new RiveImportError('E_RIVE_FORMAT_MINOR_UNSUPPORTED', 'Only frozen Rive format minor 3 is accepted.', '$.riv.header.minor', context);
  }
  const fileId = reader.readVarUint('$.riv.header.fileId', 0x7fff_ffff);
  const tocKeys: number[] = [];
  const tocSeen = new Set<number>();
  for (;;) {
    const key = reader.readVarUint('$.riv.header.toc.propertyKey', 0xffff);
    if (key === 0) break;
    if (tocSeen.has(key)) {
      throw new RiveImportError('E_RIVE_TOC_INVALID', 'ToC contains a duplicate property key.', '$.riv.header.toc', { ...context, propertyKey: key });
    }
    tocSeen.add(key);
    tocKeys.push(key);
  }

  const toc: Array<Readonly<{ sourcePropertyKey: number; fieldType: 0 | 1 | 2 | 3; status: 'consumed-type-declaration' }>> = [];
  for (let index = 0; index < tocKeys.length; index += 4) {
    const packed = reader.readUint32('$.riv.header.toc.fieldTypes');
    for (let slot = 0; slot < 4 && index + slot < tocKeys.length; slot++) {
      const key = tocKeys[index + slot]!;
      const fieldType = ((packed >>> (slot * 2)) & 3) as 0 | 1 | 2 | 3;
      const property = PROPERTY_BY_KEY.get(key);
      if (property && fieldType !== EXPECTED_TOC_TYPE[property.wireKind]) {
        throw new RiveImportError('E_RIVE_TOC_INVALID', 'ToC field type conflicts with the frozen registry.', '$.riv.header.toc.fieldTypes', { ...context, propertyKey: key });
      }
      toc.push(Object.freeze({ sourcePropertyKey: key, fieldType, status: 'consumed-type-declaration' }));
    }
  }
  const tocFieldTypeByKey = new Map(toc.map(entry => [entry.sourcePropertyKey, entry.fieldType]));
  const unknownTocKeys = new Set(tocKeys.filter(key => !PROPERTY_BY_KEY.has(key)));
  const consumedRuntimeNullTocKeys = new Set<number>();

  const counts: MutableCounts = {
    propertyAssignments: 0,
    strings: 0,
    textBytes: 0,
    embeddedBytes: 0,
    listItems: 0,
    workingSetBytes: bytes.byteLength * 2,
  };
  const objects: ParsedObject[] = [];
  const runtimeNullObjects: RiveRuntimeNullObjectVisit[] = [];
  let sourceObjectCount = 0;
  let hierarchy: HierarchyObject[] | undefined;
  let artboardInstances = 0;
  let vertices = 0;
  let keyframes = 0;
  let drawItems = 0;

  while (!reader.reachedEnd) {
    assertBudget(sourceObjectCount + 1, limits.objects, 'objects', '$.riv.objects', context);
    const sourceObjectIndex = sourceObjectCount++;
    const typeKey = reader.readVarUint(`$.riv.objects[index=${sourceObjectIndex}].typeKey`, 0xffff);
    const source = OBJECT_BY_KEY.get(typeKey);
    if (!source) {
      if (typeKey === 526) {
        runtimeNullObjects.push(readRuntimeNullObject(
          reader,
          sourceObjectIndex,
          typeKey,
          tocFieldTypeByKey,
          consumedRuntimeNullTocKeys,
          limits,
          counts,
          context,
        ));
        continue;
      }
      throw new RiveImportError('E_RIVE_UNKNOWN_OBJECT', 'Object type is outside the frozen 7.3 registry.', `$.riv.objects[typeKey=${typeKey}][index=${sourceObjectIndex}]`, { ...context, objectKey: typeKey });
    }
    if (source.name.includes('NestedArtboard') || source.name.includes('ArtboardInstance')) {
      assertBudget(++artboardInstances, limits.artboardInstances, 'artboardInstances', '$.riv.objects', context);
    }
    if (source.lineage.some(name => name.endsWith('Vertex'))) {
      assertBudget(++vertices, limits.vertices, 'vertices', '$.riv.objects', context);
    }
    if (source.lineage.some(name => name.startsWith('KeyFrame'))) {
      assertBudget(++keyframes, limits.keyframes, 'keyframes', '$.riv.objects', context);
    }
    if (source.lineage.includes('Drawable')) {
      assertBudget(++drawItems, limits.drawItems, 'drawItems', '$.riv.objects', context);
    }
    const objectContext = Object.freeze({ ...context, objectKey: typeKey });
    reader.setContext(objectContext);
    const neutralObjectId = `object:${sourceObjectIndex.toString().padStart(8, '0')}`;
    const parsedProperties: ParsedProperty[] = [];
    const fieldIdsByKey = new Map<number, string[]>();
    let assignmentIndex = 0;

    for (;;) {
      const propertyKey = reader.readVarUint(`$.riv.objects[typeKey=${typeKey}][index=${sourceObjectIndex}].properties`, 0xffff);
      if (propertyKey === 0) break;
      counts.propertyAssignments++;
      assertBudget(counts.propertyAssignments, limits.propertyAssignments, 'propertyAssignments', '$.riv.objects', objectContext);
      const property = PROPERTY_BY_KEY.get(propertyKey);
      const propertyPath = `$.riv.objects[typeKey=${typeKey}][index=${sourceObjectIndex}].properties[key=${propertyKey}]`;
      if (!property) {
        throw new RiveImportError('E_RIVE_UNKNOWN_PROPERTY', 'Property is outside the frozen 7.3 registry.', propertyPath, { ...objectContext, propertyKey });
      }
      const propertyContext = Object.freeze({ ...objectContext, propertyKey });
      reader.setContext(propertyContext);
      if (!source.lineage.includes(property.owner) || !property.serialized) {
        throw new RiveImportError('E_RIVE_UNSUPPORTED_PROPERTY', 'Property is not serializable by this frozen object type.', propertyPath, propertyContext);
      }
      const fieldId = `field:${sourceObjectIndex.toString().padStart(8, '0')}:${assignmentIndex.toString().padStart(6, '0')}`;
      assignmentIndex++;
      const parsed = readProperty(reader, property, fieldId, propertyPath, limits, counts, propertyContext);
      parsedProperties.push(parsed);
      const ids = fieldIdsByKey.get(propertyKey) ?? [];
      ids.push(fieldId);
      fieldIdsByKey.set(propertyKey, ids);
      assertBudget(counts.workingSetBytes, limits.decodedWorkingSetBytes, 'decodedWorkingSetBytes', propertyPath, propertyContext);
    }

    const allowedProperties = FROZEN_PROPERTIES.filter(property => source.lineage.includes(property.owner));
    counts.workingSetBytes += 512 + parsedProperties.length * 96 + allowedProperties.length * 192;
    assertBudget(counts.workingSetBytes, limits.decodedWorkingSetBytes, 'decodedWorkingSetBytes', `$.riv.objects[typeKey=${typeKey}][index=${sourceObjectIndex}]`, objectContext);
    const visitProperties: RivePropertyVisit[] = allowedProperties
      .map(property => Object.freeze({
        sourcePropertyKey: property.key,
        sourceName: property.name,
        sourceOwner: property.owner,
        wireKind: property.wireKind,
        status: fieldIdsByKey.has(property.key) ? 'consumed' as const : 'not-serialized' as const,
        neutralFieldIds: Object.freeze([...(fieldIdsByKey.get(property.key) ?? [])]),
      }));
    const visit: RiveObjectVisit = Object.freeze({
      neutralObjectId,
      sourceObjectIndex,
      sourceTypeKey: typeKey,
      sourceName: source.name,
      sourceFamily: source.family,
      properties: Object.freeze(visitProperties),
    });
    const parsedObject = Object.freeze({
      source,
      sourceObjectIndex,
      neutralObjectId,
      properties: Object.freeze(parsedProperties),
      visit,
    });
    objects.push(parsedObject);

    if (source.name === 'Artboard') {
      if (hierarchy) validateHierarchy(hierarchy, limits, context);
      hierarchy = [];
    }
    if (source.lineage.includes('Component') && !isRootScopedComponent(source)) {
      if (!hierarchy) {
        throw new RiveImportError('E_RIVE_REFERENCE_INVALID', 'Component appears outside an artboard hierarchy.', `$.riv.objects[typeKey=${typeKey}][index=${sourceObjectIndex}]`, objectContext);
      }
      const parent = parsedProperties.find(property => property.source.name === 'parentId')?.numberValue ?? 0;
      hierarchy.push({ sourceObjectIndex, source, parentId: parent });
    }
  }
  if (hierarchy) validateHierarchy(hierarchy, limits, context);
  for (const key of unknownTocKeys) {
    if (!consumedRuntimeNullTocKeys.has(key)) {
      throw new RiveImportError('E_RIVE_UNKNOWN_PROPERTY', 'ToC property outside the frozen registry was not confined to an accepted runtime-null object.', '$.riv.header.toc', { ...context, propertyKey: key });
    }
  }

  return Object.freeze({
    fileId,
    toc: Object.freeze(toc),
    objects: Object.freeze(objects),
    runtimeNullObjects: Object.freeze(runtimeNullObjects),
    estimatedWorkingSetBytes: counts.workingSetBytes,
    counts: Object.freeze({
      propertyAssignments: counts.propertyAssignments,
      strings: counts.strings,
      textBytes: counts.textBytes,
      embeddedBytes: counts.embeddedBytes,
      listItems: counts.listItems,
    }),
  });
}

function readRuntimeNullObject(
  reader: RivBinaryReader,
  sourceObjectIndex: number,
  typeKey: 526,
  tocFieldTypeByKey: ReadonlyMap<number, 0 | 1 | 2 | 3>,
  consumedRuntimeNullTocKeys: Set<number>,
  limits: RiveImportLimits,
  counts: MutableCounts,
  context: RiveImportDiagnosticContext,
): RiveRuntimeNullObjectVisit {
  const objectContext = Object.freeze({ ...context, objectKey: typeKey });
  reader.setContext(objectContext);
  const sourcePropertyKeys: number[] = [];
  for (;;) {
    const propertyPath = `$.riv.objects[typeKey=${typeKey}][index=${sourceObjectIndex}].properties`;
    const propertyKey = reader.readVarUint(propertyPath, 0xffff);
    if (propertyKey === 0) break;
    counts.propertyAssignments++;
    assertBudget(counts.propertyAssignments, limits.propertyAssignments, 'propertyAssignments', '$.riv.objects', objectContext);
    const property = PROPERTY_BY_KEY.get(propertyKey);
    const tocFieldType = tocFieldTypeByKey.get(propertyKey);
    if (!property && tocFieldType === undefined) {
      throw new RiveImportError('E_RIVE_UNKNOWN_PROPERTY', 'Runtime-null object property has no frozen registry or ToC wire type.', propertyPath, { ...objectContext, propertyKey });
    }
    if (!property) consumedRuntimeNullTocKeys.add(propertyKey);
    const propertyContext = Object.freeze({ ...objectContext, propertyKey });
    reader.setContext(propertyContext);
    skipRuntimeNullProperty(reader, property?.wireKind, tocFieldType, `${propertyPath}[key=${propertyKey}]`, limits, counts, propertyContext);
    sourcePropertyKeys.push(propertyKey);
    assertBudget(counts.workingSetBytes, limits.decodedWorkingSetBytes, 'decodedWorkingSetBytes', propertyPath, propertyContext);
  }
  counts.workingSetBytes += 128 + sourcePropertyKeys.length * 16;
  assertBudget(counts.workingSetBytes, limits.decodedWorkingSetBytes, 'decodedWorkingSetBytes', `$.riv.objects[typeKey=${typeKey}][index=${sourceObjectIndex}]`, objectContext);
  return Object.freeze({
    sourceObjectIndex,
    sourceTypeKey: typeKey,
    status: 'consumed-runtime-null',
    sourcePropertyKeys: Object.freeze(sourcePropertyKeys),
  });
}

function skipRuntimeNullProperty(
  reader: RivBinaryReader,
  wireKind: FrozenPropertyRecord['wireKind'] | undefined,
  tocFieldType: 0 | 1 | 2 | 3 | undefined,
  path: string,
  limits: RiveImportLimits,
  counts: MutableCounts,
  context: RiveImportDiagnosticContext,
): void {
  const effectiveKind = wireKind ?? (tocFieldType === 0 ? 'uint' : tocFieldType === 1 ? 'bytes' : tocFieldType === 2 ? 'double' : 'color');
  switch (effectiveKind) {
    case 'uint':
    case 'int': reader.readVarUint(path, 0xffff_ffff); break;
    case 'bool': {
      const value = reader.readByte(path);
      if (value > 1) throw new RiveImportError('E_RIVE_TOC_INVALID', 'Boolean payload must be 0 or 1.', path, context);
      break;
    }
    case 'string': {
      const value = reader.readString(path, limits.stringBytes);
      counts.strings++;
      counts.textBytes += value.byteLength;
      counts.workingSetBytes += value.byteLength * 3;
      assertBudget(counts.textBytes, limits.totalTextBytes, 'totalTextBytes', path, context);
      break;
    }
    case 'bytes': {
      const value = reader.readLengthPrefixedBytes(path, limits.oneAssetBytes);
      counts.embeddedBytes += value.byteLength;
      counts.workingSetBytes += value.byteLength;
      break;
    }
    case 'double': reader.readFloat32(path); break;
    case 'color': reader.readUint32(path); break;
  }
}

function isRootScopedComponent(source: FrozenObjectRecord): boolean {
  // View-model aggregates and scroll-physics definitions are serialized in
  // file-level sections before the first artboard. Their historical Component
  // inheritance does not make them members of an artboard hierarchy.
  return source.lineage.includes('ViewModelInstance')
    || source.lineage.includes('ViewModelInstanceValue')
    || source.lineage.includes('ScrollPhysics');
}

function readProperty(
  reader: RivBinaryReader,
  property: FrozenPropertyRecord,
  fieldId: string,
  path: string,
  limits: RiveImportLimits,
  counts: MutableCounts,
  context: RiveImportDiagnosticContext,
): ParsedProperty {
  let neutralValue: NeutralValue;
  let rawBytes: Uint8Array | undefined;
  let stringValue: string | undefined;
  let numberValue: number | undefined;
  switch (property.wireKind) {
    case 'uint': {
      numberValue = reader.readVarUint(path, 0xffff_ffff);
      neutralValue = Object.freeze({ type: 'unsigned-integer', value: numberValue });
      break;
    }
    case 'int': {
      const encoded = reader.readVarUint(path, 0xffff_ffff);
      numberValue = (encoded >>> 1) ^ -(encoded & 1);
      neutralValue = Object.freeze({ type: 'signed-integer', value: numberValue });
      break;
    }
    case 'bool': {
      const encoded = reader.readByte(path);
      if (encoded > 1) throw new RiveImportError('E_RIVE_TOC_INVALID', 'Boolean payload must be 0 or 1.', path, context);
      neutralValue = Object.freeze({ type: 'boolean', value: encoded === 1 });
      break;
    }
    case 'string': {
      const decoded = reader.readString(path, limits.stringBytes);
      stringValue = decoded.value;
      counts.strings++;
      counts.textBytes += decoded.byteLength;
      counts.workingSetBytes += decoded.byteLength * 3;
      assertBudget(counts.textBytes, limits.totalTextBytes, 'totalTextBytes', path, context);
      neutralValue = Object.freeze({ type: 'string', value: decoded.value });
      break;
    }
    case 'bytes': {
      rawBytes = reader.readLengthPrefixedBytes(path, limits.oneAssetBytes);
      counts.embeddedBytes += rawBytes.byteLength;
      counts.workingSetBytes += rawBytes.byteLength;
      if (isListProperty(property.name)) {
        const listCount = countVarUintItems(rawBytes, limits.listItems - counts.listItems, path, context);
        counts.listItems += listCount;
        assertBudget(counts.listItems, limits.listItems, 'listItems', path, context);
      }
      const base64 = encodeBase64(rawBytes);
      counts.workingSetBytes += base64.length * 2;
      neutralValue = Object.freeze({ type: 'bytes', base64, byteLength: rawBytes.byteLength });
      break;
    }
    case 'double': {
      numberValue = reader.readFloat32(path);
      neutralValue = Object.freeze({ type: 'number', value: numberValue });
      break;
    }
    case 'color': {
      const color = reader.readUint32(path);
      neutralValue = Object.freeze({
        type: 'color',
        rgba: Object.freeze([
          ((color >>> 16) & 0xff) / 255,
          ((color >>> 8) & 0xff) / 255,
          (color & 0xff) / 255,
          ((color >>> 24) & 0xff) / 255,
        ]) as readonly [number, number, number, number],
      });
      break;
    }
  }
  return Object.freeze({
    source: property,
    neutral: Object.freeze({ id: fieldId, value: neutralValue }),
    ...(rawBytes ? { rawBytes } : {}),
    ...(stringValue !== undefined ? { stringValue } : {}),
    ...(numberValue !== undefined ? { numberValue } : {}),
  });
}

function validateHierarchy(hierarchy: readonly HierarchyObject[], limits: RiveImportLimits, context: RiveImportDiagnosticContext): void {
  if (hierarchy.length === 0 || hierarchy[0]?.source.name !== 'Artboard') {
    throw new RiveImportError('E_RIVE_REFERENCE_INVALID', 'Artboard hierarchy does not start with its artboard object.', '$.riv.objects', context);
  }
  for (let index = 1; index < hierarchy.length; index++) {
    const object = hierarchy[index]!;
    if (object.parentId >= hierarchy.length || object.parentId === index) {
      throw new RiveImportError('E_RIVE_REFERENCE_INVALID', 'Component parent reference is out of range or self-referential.', `$.riv.objects[index=${object.sourceObjectIndex}].properties[parentId]`, context);
    }
    const parent = hierarchy[object.parentId];
    if (!parent?.source.lineage.includes('ContainerComponent')) {
      throw new RiveImportError('E_RIVE_REFERENCE_INVALID', 'Component parent must reference a container component.', `$.riv.objects[index=${object.sourceObjectIndex}].properties[parentId]`, context);
    }
    const seen = new Set<number>([index]);
    let cursor = object.parentId;
    let depth = 1;
    while (cursor !== 0) {
      if (seen.has(cursor)) {
        throw new RiveImportError('E_RIVE_REFERENCE_CYCLE', 'Component hierarchy contains a cycle.', `$.riv.objects[index=${object.sourceObjectIndex}].properties[parentId]`, context);
      }
      seen.add(cursor);
      depth++;
      assertBudget(depth, limits.referenceDepth, 'referenceDepth', `$.riv.objects[index=${object.sourceObjectIndex}]`, context);
      cursor = hierarchy[cursor]?.parentId ?? Number.MAX_SAFE_INTEGER;
      if (cursor >= hierarchy.length) {
        throw new RiveImportError('E_RIVE_REFERENCE_INVALID', 'Component ancestor reference is out of range.', `$.riv.objects[index=${object.sourceObjectIndex}].properties[parentId]`, context);
      }
    }
  }
}

function isListProperty(name: string): boolean {
  return name === 'path' || name.endsWith('PathIds') || name.endsWith('pathIds');
}

function countVarUintItems(bytes: Uint8Array, remainingLimit: number, path: string, context: RiveImportDiagnosticContext): number {
  let offset = 0;
  let count = 0;
  while (offset < bytes.length) {
    count++;
    if (count > remainingLimit) assertBudget(count, remainingLimit, 'listItems', path, context);
    let terminated = false;
    for (let index = 0; index < 10 && offset < bytes.length; index++) {
      const byte = bytes[offset++]!;
      if (index === 9 && byte > 1) throw new RiveImportError('E_RIVE_VARINT_OVERFLOW', 'Nested list varuint exceeds 64 bits.', path, context);
      if ((byte & 0x80) === 0) { terminated = true; break; }
    }
    if (!terminated) throw new RiveImportError('E_RIVE_TRUNCATED', 'Nested list ends inside a varuint.', path, context);
  }
  return count;
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const packed = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output += alphabet[(packed >>> 18) & 63];
    output += alphabet[(packed >>> 12) & 63];
    output += b === undefined ? '=' : alphabet[(packed >>> 6) & 63];
    output += c === undefined ? '=' : alphabet[packed & 63];
  }
  return output;
}

function assertBudget(observed: number, limit: number, budget: string, path: string, context: RiveImportDiagnosticContext): void {
  if (observed > limit) {
    throw new RiveImportError('E_RIVE_LIMIT_EXCEEDED', `Rive import exceeded ${budget}.`, path, { ...context, observed, limit, budget });
  }
}
