import { AnimationFormatError } from './errors';
import { extensionIdFromComponentType, validateExtensionId } from './extensions';
import {
  ANIMATION_FORMAT,
  ANIMATION_VERSION,
  ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
  type AnimationComponent,
  type AnimationCompositeLayer,
  type AnimationDocument,
  type AnimationEndBehavior,
  type AnimationLayerEffect,
  type AnimationNode,
  type AnimationParseOptions,
  type AnimationResource,
  type AnimationSprite2DComponent,
  type AnimationTrackProperty,
  type AnimationText2DComponent,
  type AnimationVectorShapeComponent,
  type AnimationVectorValueTrack,
  type ParsedAnimation,
  type ParsedAnimationTrack,
} from './types';
import { parseSafeExpressionProgram, safeExpressionDataResources } from './expression';
import {
  HYA_STATE_MACHINE_EXTENSION_ID,
} from './state-machine';
import { TEXT_SELECTOR_BASES, TEXT_SELECTOR_SHAPES } from './text-selector';

const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 8 * 1024 * 1024,
  maxNodes: 100_000,
  maxComponents: 200_000,
  maxTracks: 200_000,
  maxKeyframes: 5_000_000,
  maxResources: 10_000,
  maxPathValues: 10_000_000,
  maxTextCharacters: 5_000_000,
  maxParticleCapacity: 2_000_000,
});

export function resolveAnimationParseLimits(options: AnimationParseOptions): Required<Omit<AnimationParseOptions, 'extensions' | 'copyFloatData'>> {
  if (
    options.maxInputBytes === undefined
    && options.maxMetadataBytes === undefined
    && options.maxNodes === undefined
    && options.maxComponents === undefined
    && options.maxTracks === undefined
    && options.maxKeyframes === undefined
    && options.maxResources === undefined
    && options.maxPathValues === undefined
    && options.maxTextCharacters === undefined
    && options.maxParticleCapacity === undefined
  ) {
    return DEFAULT_LIMITS;
  }
  return {
    maxInputBytes: positiveLimit(options.maxInputBytes, DEFAULT_LIMITS.maxInputBytes, 'maxInputBytes'),
    maxMetadataBytes: positiveLimit(options.maxMetadataBytes, DEFAULT_LIMITS.maxMetadataBytes, 'maxMetadataBytes'),
    maxNodes: positiveLimit(options.maxNodes, DEFAULT_LIMITS.maxNodes, 'maxNodes'),
    maxComponents: positiveLimit(options.maxComponents, DEFAULT_LIMITS.maxComponents, 'maxComponents'),
    maxTracks: positiveLimit(options.maxTracks, DEFAULT_LIMITS.maxTracks, 'maxTracks'),
    maxKeyframes: positiveLimit(options.maxKeyframes, DEFAULT_LIMITS.maxKeyframes, 'maxKeyframes'),
    maxResources: positiveLimit(options.maxResources, DEFAULT_LIMITS.maxResources, 'maxResources'),
    maxPathValues: positiveLimit(options.maxPathValues, DEFAULT_LIMITS.maxPathValues, 'maxPathValues'),
    maxTextCharacters: positiveLimit(options.maxTextCharacters, DEFAULT_LIMITS.maxTextCharacters, 'maxTextCharacters'),
    maxParticleCapacity: positiveLimit(options.maxParticleCapacity, DEFAULT_LIMITS.maxParticleCapacity, 'maxParticleCapacity'),
  };
}

export function parseAnimationValue(
  input: unknown,
  options: AnimationParseOptions,
  source: 'json' | 'binary',
  backingBuffer?: ArrayBuffer,
): ParsedAnimation {
  const limits = resolveAnimationParseLimits(options);
  const root = record(input, '$');
  if (root.format !== ANIMATION_FORMAT) fail(`format must be "${ANIMATION_FORMAT}".`, '$.format');
  if (root.version !== ANIMATION_VERSION) {
    throw new AnimationFormatError('E_ANIMATION_UNSUPPORTED_VERSION', `Unsupported animation version "${String(root.version)}".`, '$.version');
  }

  const canvasValue = record(root.canvas, '$.canvas');
  const canvas = Object.freeze({
    width: positiveNumber(canvasValue.width, '$.canvas.width'),
    height: positiveNumber(canvasValue.height, '$.canvas.height'),
    coordinateSystem: literal(canvasValue.coordinateSystem, ['screen-y-down'] as const, '$.canvas.coordinateSystem'),
  });
  const duration = positiveNumber(root.duration, '$.duration');
  const frameRate = root.frameRate === undefined ? undefined : positiveNumber(root.frameRate, '$.frameRate');
  const endBehavior = root.endBehavior === undefined
    ? 'loop'
    : literal(root.endBehavior, ['hold', 'loop', 'destroy'] as const, '$.endBehavior');

  const resourcesInput = array(root.resources ?? [], '$.resources');
  limit(resourcesInput.length, limits.maxResources, 'resources', '$.resources');
  const resourceIds = new Set<string>();
  const resources = resourcesInput.map((value, index) => parseBinaryResourceValue(value, index, resourceIds));

  const nodesInput = array(root.nodes, '$.nodes');
  limit(nodesInput.length, limits.maxNodes, 'nodes', '$.nodes');
  const nodeIds = new Set<string>();
  let componentCount = 0;
  let pathValueCount = 0;
  let textCharacterCount = 0;
  let particleCapacity = 0;
  const nodes = nodesInput.map((value, index) => {
    const node = parseBinaryNodeValue(value, index, nodeIds, options, (kind, count) => {
      if (kind === 'path') {
        pathValueCount += count;
        limit(pathValueCount, limits.maxPathValues, 'path values', `$.nodes[${index}].components`);
      } else if (kind === 'text') {
        textCharacterCount += count;
        limit(textCharacterCount, limits.maxTextCharacters, 'text characters', `$.nodes[${index}].components`);
      } else {
        particleCapacity += count;
        limit(particleCapacity, limits.maxParticleCapacity, 'particle capacity', `$.nodes[${index}].components`);
      }
    });
    componentCount += node.components?.length ?? 0;
    limit(componentCount, limits.maxComponents, 'components', `$.nodes[${index}].components`);
    return node;
  });
  const tracksInput = array(root.tracks ?? [], '$.tracks');
  limit(tracksInput.length, limits.maxTracks, 'tracks', '$.tracks');
  let keyframeCount = 0;
  const tracks = tracksInput.map((value, index) => {
    const track = parseBinaryTrackValue(value, index, nodeIds, duration, options.copyFloatData === true);
    keyframeCount += track.times.length;
    limit(keyframeCount, limits.maxKeyframes, 'keyframes', `$.tracks[${index}].times`);
    return track;
  });

  const extensionsUsed = stringList(root.extensionsUsed ?? [], '$.extensionsUsed');
  const extensionsRequired = stringList(root.extensionsRequired ?? [], '$.extensionsRequired');
  const extensionData = root.extensions === undefined ? {} : record(root.extensions, '$.extensions');
  return finalizeParsedAnimation({
    ...(typeof root.name === 'string' ? { name: root.name } : {}),
    canvas,
    duration,
    ...(frameRate !== undefined ? { frameRate } : {}),
    endBehavior,
    resources,
    nodes,
    tracks,
    extensionsUsed,
    extensionsRequired,
    extensions: extensionData,
  }, options, source, backingBuffer);
}

/** Canonical fields used internally after JSON or compact-binary structural validation. */
export interface ParsedAnimationFields {
  readonly name?: string;
  readonly canvas: ParsedAnimation['canvas'];
  readonly duration: number;
  readonly frameRate?: number;
  readonly endBehavior: AnimationEndBehavior;
  readonly resources: readonly Readonly<AnimationResource>[];
  readonly nodes: readonly Readonly<AnimationNode>[];
  readonly tracks: readonly ParsedAnimationTrack[];
  readonly extensionsUsed: readonly string[];
  readonly extensionsRequired: readonly string[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

/** @internal Shared semantic validation after a decoder has canonicalized every field exactly once. */
export function finalizeParsedAnimation(
  fields: ParsedAnimationFields,
  options: AnimationParseOptions,
  source: 'json' | 'binary',
  backingBuffer?: ArrayBuffer,
  graphValidated = false,
): ParsedAnimation {
  if (fields.extensionsUsed.includes(HYA_STATE_MACHINE_EXTENSION_ID)
    && !(HYA_STATE_MACHINE_EXTENSION_ID in fields.extensions)) {
    fail(
      `Built-in extension "${HYA_STATE_MACHINE_EXTENSION_ID}" requires document data.`,
      `$.extensions.${HYA_STATE_MACHINE_EXTENSION_ID}`,
    );
  }
  const hasHierarchy = !graphValidated && fields.nodes.some(node => node.parent !== undefined);
  const hasComposites = !graphValidated && fields.nodes.some(node => node.composite !== undefined);
  if (!graphValidated && (hasHierarchy || hasComposites)) {
    const nodeIds = new Set(fields.nodes.map(node => node.id));
    if (hasHierarchy) validateHierarchy(fields.nodes, nodeIds);
    if (hasComposites) validateComposites(fields.nodes, nodeIds);
  }
  const hasResourceReferences = fields.nodes.some(node => node.components?.some(component => (
    component.type === 'sprite2d' || component.type === 'particle2d' || component.type === 'audio'
      || (component.type === 'text2d' && (() => {
        const text = component as AnimationText2DComponent;
        return text.fontResource !== undefined || text.expression !== undefined
          || text.documents?.some(document => document.fontResource !== undefined) === true;
      })())
  )));
  const resourceIds = hasResourceReferences ? new Set(fields.resources.map(resource => resource.id)) : undefined;
  const resourcesById = hasResourceReferences ? new Map(fields.resources.map(resource => [resource.id, resource])) : undefined;
  for (let index = 0; index < fields.nodes.length; index++) {
    const node = fields.nodes[index]!;
    const start = node.start ?? 0;
    if (start > fields.duration || start + (node.duration ?? fields.duration - start) > fields.duration + 1e-6) {
      fail('Node time range must fit inside the composition duration.', `$.nodes[${index}]`);
    }
    const nodeCompositeLayers = compositeLayers(node.composite);
    for (let layerIndex = 0; layerIndex < nodeCompositeLayers.length; layerIndex++) {
      const track = nodeCompositeLayers[layerIndex]!.expansionTrack;
      if (track) validateTrackDuration(
        track.times,
        `$.nodes[${index}].composite${'layers' in node.composite! ? `.layers[${layerIndex}]` : ''}.expansionTrack.times`,
        fields.duration,
      );
    }
    for (let componentIndex = 0; componentIndex < (node.components?.length ?? 0); componentIndex++) {
      const component = node.components![componentIndex]!;
      if (component.type === ANIMATION_VECTOR_SHAPE_EXTENSION_ID) {
        validateVectorTrackDurations(
          component as AnimationVectorShapeComponent,
          `$.nodes[${index}].components[${componentIndex}]`,
          fields.duration,
        );
      } else if (component.type === 'org.haiyue.vector-path-morph@1') {
        validateTrackDuration(
          (component as unknown as { times: readonly number[] | Float32Array }).times,
          `$.nodes[${index}].components[${componentIndex}].times`,
          fields.duration,
        );
      }
      const sprite = component.type === 'sprite2d' ? component as AnimationSprite2DComponent : undefined;
      if (sprite?.uvRectTrack) {
        validateTrackDuration(
          sprite.uvRectTrack.times,
          `$.nodes[${index}].components[${componentIndex}].uvRectTrack.times`,
          fields.duration,
        );
      }
      if (component.type === 'text2d') {
        const text = component as AnimationText2DComponent;
        validateTextTrackDurations(text, `$.nodes[${index}].components[${componentIndex}]`, fields.duration);
        const fontResources = [text.fontResource, ...(text.documents?.map(document => document.fontResource) ?? [])]
          .filter((resource): resource is string => resource !== undefined);
        for (const fontResource of fontResources) {
          if (!resourceIds!.has(fontResource)) {
            fail(`Text component references missing font resource "${fontResource}".`, `$.nodes[${index}].components[${componentIndex}].fontResource`);
          }
          if (resourcesById!.get(fontResource)?.type !== 'binary') {
            fail(`Text font resource "${fontResource}" must have type "binary".`, `$.nodes[${index}].components[${componentIndex}].fontResource`);
          }
        }
        for (const dataResource of text.expression ? safeExpressionDataResources(text.expression) : []) {
          const resourcePath = `$.nodes[${index}].components[${componentIndex}].expression`;
          if (!resourceIds!.has(dataResource)) fail(`Text expression references missing data resource "${dataResource}".`, resourcePath);
          const resource = resourcesById!.get(dataResource);
          if (resource?.type !== 'binary' || !/^application\/json(?:$|;)/i.test(resource.mimeType ?? '')) {
            fail(`Text expression data resource "${dataResource}" must be JSON binary data.`, resourcePath);
          }
        }
      }
      const imageResource = component.type === 'sprite2d' || component.type === 'particle2d' ? component.resource : undefined;
      if (typeof imageResource === 'string' && !resourceIds!.has(imageResource)) {
        fail(`Component references missing resource "${imageResource}".`, `$.nodes[${index}].components[${componentIndex}].resource`);
      }
      if (typeof imageResource === 'string' && resourcesById!.get(imageResource)?.type !== 'image') {
        fail(`Component resource "${imageResource}" must have type "image".`, `$.nodes[${index}].components[${componentIndex}].resource`);
      }
      const audioResource = component.type === 'audio' ? component.resource : undefined;
      if (typeof audioResource === 'string' && resourcesById!.get(audioResource)?.type !== 'audio') {
        fail(`Audio resource "${audioResource}" must have type "audio".`, `$.nodes[${index}].components[${componentIndex}].resource`);
      }
    }
    for (let effectIndex = 0; effectIndex < (node.effects?.length ?? 0); effectIndex++) {
      validateEffectTrackDurations(node.effects![effectIndex]!, `$.nodes[${index}].effects[${effectIndex}]`, fields.duration);
    }
  }

  if (fields.extensionsUsed.length > 0 || fields.extensionsRequired.length > 0) {
    const used = new Set(fields.extensionsUsed);
    for (const id of fields.extensionsUsed) validateExtensionId(id);
    for (const id of fields.extensionsRequired) {
      validateExtensionId(id);
      if (!used.has(id)) fail(`Required extension "${id}" must also appear in extensionsUsed.`, '$.extensionsRequired');
      if (id !== HYA_STATE_MACHINE_EXTENSION_ID && !options.extensions?.has(id)) {
        throw new AnimationFormatError('E_ANIMATION_MISSING_EXTENSION', `Required extension "${id}" is not registered.`, '$.extensionsRequired');
      }
    }
    for (let nodeIndex = 0; nodeIndex < fields.nodes.length; nodeIndex++) {
      const components = fields.nodes[nodeIndex]!.components ?? [];
      for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
        const extension = extensionIdFromComponentType(components[componentIndex]!.type);
        if (extension && !used.has(extension)) {
          fail(`Extension component "${extension}" must be declared in extensionsUsed.`, `$.nodes[${nodeIndex}].components[${componentIndex}].type`);
        }
      }
    }
    for (const id of fields.extensionsUsed) {
      const handler = id === HYA_STATE_MACHINE_EXTENSION_ID ? undefined : options.extensions?.get(id);
      if (!handler?.validateDocument || !(id in fields.extensions)) continue;
      handler.validateDocument(fields.extensions[id], extensionContext(id, `$.extensions.${id}`));
    }
  } else {
    for (let nodeIndex = 0; nodeIndex < fields.nodes.length; nodeIndex++) {
      const components = fields.nodes[nodeIndex]!.components ?? [];
      for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
        const extension = extensionIdFromComponentType(components[componentIndex]!.type);
        if (extension) {
          fail(`Extension component "${extension}" must be declared in extensionsUsed.`, `$.nodes[${nodeIndex}].components[${componentIndex}].type`);
        }
      }
    }
  }

  return Object.freeze({
    format: ANIMATION_FORMAT,
    version: ANIMATION_VERSION,
    ...fields,
    resources: Object.freeze(fields.resources),
    nodes: Object.freeze(fields.nodes),
    tracks: Object.freeze(fields.tracks),
    extensionsUsed: Object.freeze(fields.extensionsUsed),
    extensionsRequired: Object.freeze(fields.extensionsRequired),
    extensions: Object.freeze({ ...fields.extensions }),
    source,
    ...(backingBuffer ? { backingBuffer } : {}),
  });
}

function validateVectorTrackDurations(component: AnimationVectorShapeComponent, path: string, duration: number): void {
  const check = (owner: object | undefined, prefix: string, keys: readonly string[]): void => {
    if (!owner) return;
    for (const key of keys) {
      const track = (owner as Record<string, AnimationVectorValueTrack | undefined>)[key];
      if (track) validateTrackDuration(track.times, `${path}.${prefix}${key}.times`, duration);
    }
  };
  check(component, '', ['morph']);
  check(component.fill, 'fill.', component.fill?.kind === 'solid'
    ? ['colorTrack', 'opacityTrack']
    : ['startTrack', 'endTrack', 'stopsTrack', 'opacityTrack']);
  check(component.stroke, 'stroke.', ['colorTrack', 'opacityTrack', 'widthTrack', 'dashOffsetTrack']);
  check(component.stroke?.gradient, 'stroke.gradient.', ['startTrack', 'endTrack', 'stopsTrack', 'opacityTrack']);
  for (let index = 0; index < (component.modifiers?.length ?? 0); index++) {
    const modifier = component.modifiers![index]!;
    check(modifier, `modifiers[${index}].`, modifier.kind === 'trim-path'
      ? ['startTrack', 'endTrack', 'offsetTrack']
      : ['radiusTrack']);
  }
}

function validateTextTrackDurations(
  component: AnimationText2DComponent,
  path: string,
  duration: number,
): void {
  const documents = component.documents ?? [];
  const lastDocument = documents[documents.length - 1];
  if (lastDocument && lastDocument.time > Math.max(duration, Math.fround(duration))) {
    fail('Text document time exceeds the composition duration.', `${path}.documents[${documents.length - 1}].time`);
  }
  for (let index = 0; index < (component.animators?.length ?? 0); index++) {
    const animator = component.animators![index]!;
    checkOwnerTrackDurations(
      animator.selector,
      `${path}.animators[${index}].selector`,
      ['startTrack', 'endTrack', 'offsetTrack', 'amountTrack'],
      duration,
    );
    checkOwnerTrackDurations(
      animator,
      `${path}.animators[${index}]`,
      ['positionTrack', 'scaleTrack', 'rotationTrack', 'opacityTrack', 'fillColorTrack', 'trackingTrack'],
      duration,
    );
  }
}

function validateEffectTrackDurations(effect: AnimationLayerEffect, path: string, duration: number): void {
  const keys = effect.kind === 'tint' ? ['blackTrack', 'whiteTrack', 'amountTrack']
    : effect.kind === 'fill' ? ['colorTrack', 'opacityTrack']
      : effect.kind === 'opacity' ? ['opacityTrack']
        : effect.kind === 'color-matrix' ? ['matrixTrack']
          : effect.kind === 'blur' ? ['radiusTrack']
            : ['colorTrack', 'opacityTrack', 'offsetTrack', 'blurTrack'];
  checkOwnerTrackDurations(effect, path, keys, duration);
}

function checkOwnerTrackDurations(
  owner: object,
  path: string,
  keys: readonly string[],
  duration: number,
): void {
  for (const key of keys) {
    const track = (owner as Record<string, AnimationVectorValueTrack | undefined>)[key];
    if (track) validateTrackDuration(track.times, `${path}.${key}.times`, duration);
  }
}

function validateTrackDuration(times: readonly number[] | Float32Array, path: string, duration: number): void {
  const last = times[times.length - 1];
  if (last !== undefined && last > Math.max(duration, Math.fround(duration))) {
    fail('Vector track time exceeds the composition duration.', `${path}[${times.length - 1}]`);
  }
}

export function parsedAnimationToDocument(parsed: ParsedAnimation): AnimationDocument {
  return {
    format: parsed.format,
    version: parsed.version,
    canvas: parsed.canvas,
    duration: parsed.duration,
    endBehavior: parsed.endBehavior,
    nodes: parsed.nodes,
    tracks: parsed.tracks,
    resources: parsed.resources,
    extensionsUsed: parsed.extensionsUsed,
    extensionsRequired: parsed.extensionsRequired,
    extensions: parsed.extensions,
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.frameRate !== undefined ? { frameRate: parsed.frameRate } : {}),
  };
}

/** @internal Compact-binary structural decoder entry point. */
export function parseBinaryNodeValue(
  value: unknown,
  index: number,
  ids: Set<string>,
  options: AnimationParseOptions,
  countBudget: (kind: 'path' | 'text' | 'particle', count: number) => void,
): Readonly<AnimationNode> {
  const path = `$.nodes[${index}]`;
  const node = record(value, path);
  const id = nonEmptyString(node.id, `${path}.id`);
  if (ids.has(id)) fail(`Duplicate node id "${id}".`, `${path}.id`);
  ids.add(id);
  const start = node.start === undefined ? 0 : nonNegativeNumber(node.start, `${path}.start`);
  const duration = node.duration === undefined ? undefined : positiveNumber(node.duration, `${path}.duration`);
  const transform = node.transform === undefined ? undefined : parseTransform(node.transform, `${path}.transform`);
  const components = node.components === undefined
    ? undefined
    : array(node.components, `${path}.components`).map((component, componentIndex) => (
        parseComponent(component, `${path}.components[${componentIndex}]`, options, countBudget)
      ));
  const effects = node.effects === undefined
    ? undefined
    : parseLayerEffects(node.effects, `${path}.effects`, options.copyFloatData === true);
  return Object.freeze({
    id,
    ...(typeof node.name === 'string' ? { name: node.name } : {}),
    ...(node.parent !== undefined ? { parent: nonEmptyString(node.parent, `${path}.parent`) } : {}),
    ...(start !== 0 ? { start } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(transform ? { transform } : {}),
    ...(node.composite !== undefined ? {
      composite: parseComposite(node.composite, `${path}.composite`, options.copyFloatData === true),
    } : {}),
    ...(effects ? { effects } : {}),
    ...(components ? { components: Object.freeze(components) } : {}),
    ...(node.extensions !== undefined ? { extensions: Object.freeze({ ...record(node.extensions, `${path}.extensions`) }) } : {}),
  });
}

function parseTransform(value: unknown, path: string) {
  const transform = record(value, path);
  const opacity = transform.opacity === undefined ? undefined : unitNumber(transform.opacity, `${path}.opacity`);
  return Object.freeze({
    ...(transform.position !== undefined ? { position: vec2(transform.position, `${path}.position`) } : {}),
    ...(transform.rotation !== undefined ? { rotation: finiteNumber(transform.rotation, `${path}.rotation`) } : {}),
    ...(transform.scale !== undefined ? { scale: vec2(transform.scale, `${path}.scale`) } : {}),
    ...(transform.anchor !== undefined ? { anchor: vec2(transform.anchor, `${path}.anchor`) } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
  });
}

/** @internal Compact-binary transform decoder entry point. */
export function parseBinaryTransformValue(value: unknown, path: string): Readonly<NonNullable<AnimationNode['transform']>> {
  return parseTransform(value, path);
}

function parseComponent(
  value: unknown,
  path: string,
  options: AnimationParseOptions,
  countBudget: (kind: 'path' | 'text' | 'particle', count: number) => void,
): AnimationComponent {
  const component = record(value, path);
  const type = nonEmptyString(component.type, `${path}.type`);
  if (type === 'shape2d') {
    return Object.freeze({
      type,
      shape: literal(component.shape, ['rect', 'ellipse'] as const, `${path}.shape`),
      size: positiveVec2(component.size, `${path}.size`),
      fill: color(component.fill, `${path}.fill`),
      ...(component.position !== undefined ? { position: vec2(component.position, `${path}.position`) } : {}),
    });
  }
  if (type === 'path2d') {
    const commands = nonEmptyString(component.commands, `${path}.commands`).toUpperCase();
    if (!/^[MLQCZ]+$/.test(commands) || commands[0] !== 'M') fail('Path commands must start with M and contain only M, L, Q, C, Z.', `${path}.commands`);
    validatePathTopology(commands, `${path}.commands`);
    const values = floatArray(component.values, `${path}.values`, options.copyFloatData === true);
    const expected = pathValueCount(commands);
    if (values.length !== expected) fail(`Path values length must be ${expected} for command stream "${commands}".`, `${path}.values`);
    if (!commands.includes('Z')) fail('Filled path must contain at least one closed contour (Z).', `${path}.commands`);
    countBudget('path', values.length);
    return Object.freeze({
      type,
      commands,
      values,
      fill: color(component.fill, `${path}.fill`),
      fillRule: component.fillRule === undefined ? 'nonzero' : literal(component.fillRule, ['nonzero', 'evenodd'] as const, `${path}.fillRule`),
      tolerance: component.tolerance === undefined ? 0.35 : positiveNumber(component.tolerance, `${path}.tolerance`),
    });
  }
  if (type === 'sprite2d') {
    const uvRectTrack = component.uvRectTrack === undefined
      ? undefined
      : parseVectorValueTrack(component.uvRectTrack, `${path}.uvRectTrack`, 4, options.copyFloatData === true);
    if (uvRectTrack && uvRectTrack.interpolation !== 'step') {
      fail('Sprite uvRectTrack requires step interpolation.', `${path}.uvRectTrack.interpolation`);
    }
    if (uvRectTrack) validateUvRectTrack(uvRectTrack, `${path}.uvRectTrack`);
    return Object.freeze({
      type,
      resource: nonEmptyString(component.resource, `${path}.resource`),
      size: positiveVec2(component.size, `${path}.size`),
      ...(component.position !== undefined ? { position: vec2(component.position, `${path}.position`) } : {}),
      ...(component.tint !== undefined ? { tint: color(component.tint, `${path}.tint`) } : {}),
      ...(component.uvRect !== undefined ? { uvRect: uvRect(component.uvRect, `${path}.uvRect`) } : {}),
      ...(uvRectTrack ? { uvRectTrack } : {}),
    });
  }
  if (type === 'text2d') {
    if (typeof component.text !== 'string') fail('Expected text to be a string.', `${path}.text`);
    countBudget('text', component.text.length);
    const resolutionScale = component.resolutionScale === undefined ? undefined : positiveNumber(component.resolutionScale, `${path}.resolutionScale`);
    if (resolutionScale !== undefined && resolutionScale > 4) fail('resolutionScale must be at most 4.', `${path}.resolutionScale`);
    const documents = component.documents === undefined ? undefined : parseTextDocuments(component.documents, `${path}.documents`);
    const animators = component.animators === undefined ? undefined : parseTextAnimators(component.animators, `${path}.animators`, options.copyFloatData === true);
    const expression = component.expression === undefined ? undefined : parseSafeExpressionProgram(component.expression, `${path}.expression`);
    if (documents) for (const document of documents) countBudget('text', document.text.length);
    return Object.freeze({
      type,
      text: component.text,
      size: positiveVec2(component.size, `${path}.size`),
      color: color(component.color, `${path}.color`),
      ...(component.position !== undefined ? { position: vec2(component.position, `${path}.position`) } : {}),
      ...(component.fontFamily !== undefined ? { fontFamily: nonEmptyString(component.fontFamily, `${path}.fontFamily`) } : {}),
      ...(component.fontSize !== undefined ? { fontSize: positiveNumber(component.fontSize, `${path}.fontSize`) } : {}),
      ...(component.fontWeight !== undefined ? { fontWeight: fontWeight(component.fontWeight, `${path}.fontWeight`) } : {}),
      ...(component.fontStyle !== undefined ? { fontStyle: literal(component.fontStyle, ['normal', 'italic'] as const, `${path}.fontStyle`) } : {}),
      ...(component.fontResource !== undefined ? { fontResource: nonEmptyString(component.fontResource, `${path}.fontResource`) } : {}),
      ...(component.lineHeight !== undefined ? { lineHeight: positiveNumber(component.lineHeight, `${path}.lineHeight`) } : {}),
      ...(component.tracking !== undefined ? { tracking: finiteNumber(component.tracking, `${path}.tracking`) } : {}),
      ...(component.textAlign !== undefined ? { textAlign: literal(component.textAlign, ['left', 'center', 'right'] as const, `${path}.textAlign`) } : {}),
      ...(component.verticalAlign !== undefined ? { verticalAlign: literal(component.verticalAlign, ['top', 'middle', 'bottom'] as const, `${path}.verticalAlign`) } : {}),
      ...(component.backgroundColor !== undefined ? { backgroundColor: color(component.backgroundColor, `${path}.backgroundColor`) } : {}),
      ...(component.padding !== undefined ? { padding: nonNegativeNumber(component.padding, `${path}.padding`) } : {}),
      ...(component.lineBackground !== undefined ? { lineBackground: textLineBackground(component.lineBackground, `${path}.lineBackground`) } : {}),
      ...(component.fit !== undefined ? { fit: literal(component.fit, ['none', 'shrink'] as const, `${path}.fit`) } : {}),
      ...(component.wrap !== undefined ? { wrap: literal(component.wrap, ['none', 'word'] as const, `${path}.wrap`) } : {}),
      ...(resolutionScale !== undefined ? { resolutionScale } : {}),
      ...(documents ? { documents } : {}),
      ...(animators ? { animators } : {}),
      ...(expression ? { expression } : {}),
    });
  }
  if (type === 'particle2d') {
    const maxParticles = boundedInteger(component.maxParticles, 1, 1_000_000, `${path}.maxParticles`);
    countBudget('particle', maxParticles);
    return Object.freeze({
      type,
      maxParticles,
      emissionRate: nonNegativeNumber(component.emissionRate, `${path}.emissionRate`),
      lifetime: numericRange(component.lifetime, `${path}.lifetime`, 1e-4),
      speed: numericRange(component.speed, `${path}.speed`, 0),
      angle: numericRange(component.angle, `${path}.angle`),
      startSize: numericRange(component.startSize, `${path}.startSize`, 0),
      endSize: numericRange(component.endSize, `${path}.endSize`, 0),
      startColor: color(component.startColor, `${path}.startColor`),
      endColor: color(component.endColor, `${path}.endColor`),
      ...(component.burst !== undefined ? { burst: boundedInteger(component.burst, 0, maxParticles, `${path}.burst`) } : {}),
      ...(component.duration !== undefined ? { duration: positiveNumber(component.duration, `${path}.duration`) } : {}),
      ...(component.loop !== undefined ? { loop: booleanValue(component.loop, `${path}.loop`) } : {}),
      ...(component.seed !== undefined ? { seed: safeInteger(component.seed, `${path}.seed`) } : {}),
      ...(component.gravity !== undefined ? { gravity: vec2(component.gravity, `${path}.gravity`) } : {}),
      ...(component.shape !== undefined ? { shape: literal(component.shape, ['point', 'box', 'circle'] as const, `${path}.shape`) } : {}),
      ...(component.shapeSize !== undefined ? { shapeSize: nonNegativeVec2(component.shapeSize, `${path}.shapeSize`) } : {}),
      ...(component.shapeRadius !== undefined ? { shapeRadius: nonNegativeNumber(component.shapeRadius, `${path}.shapeRadius`) } : {}),
      ...(component.blendMode !== undefined ? { blendMode: literal(component.blendMode, ['normal', 'additive'] as const, `${path}.blendMode`) } : {}),
      ...(component.resource !== undefined ? { resource: nonEmptyString(component.resource, `${path}.resource`) } : {}),
      ...(component.radial !== undefined ? { radial: booleanValue(component.radial, `${path}.radial`) } : {}),
    });
  }
  if (type === 'audio') {
    return Object.freeze({
      type,
      resource: nonEmptyString(component.resource, `${path}.resource`),
      ...(component.volume !== undefined ? { volume: unitNumber(component.volume, `${path}.volume`) } : {}),
      ...(component.loop !== undefined ? { loop: booleanValue(component.loop, `${path}.loop`) } : {}),
      ...(component.startOffset !== undefined ? { startOffset: nonNegativeNumber(component.startOffset, `${path}.startOffset`) } : {}),
      ...(component.playbackRate !== undefined ? { playbackRate: positiveNumber(component.playbackRate, `${path}.playbackRate`) } : {}),
    });
  }
  if (type === 'org.haiyue.vector-path-morph@1') {
    const commands = nonEmptyString(component.commands, `${path}.commands`).toUpperCase();
    if (!/^[MLQCZ]+$/.test(commands) || commands[0] !== 'M') fail('Path morph commands must start with M and contain only M, L, Q, C, Z.', `${path}.commands`);
    validatePathTopology(commands, `${path}.commands`);
    if (!commands.includes('Z')) fail('Filled path morph must contain at least one closed contour (Z).', `${path}.commands`);
    const times = floatArray(component.times, `${path}.times`, options.copyFloatData === true);
    const values = floatArray(component.values, `${path}.values`, options.copyFloatData === true);
    const valueSize = safeInteger(component.valueSize, `${path}.valueSize`);
    if (valueSize !== pathValueCount(commands)) fail(`Path morph valueSize must be ${pathValueCount(commands)} for command stream "${commands}".`, `${path}.valueSize`);
    if (times.length === 0 || values.length !== times.length * valueSize) fail('Path morph values must contain valueSize numbers for every keyframe.', `${path}.values`);
    for (let index = 0; index < times.length; index++) {
      if (times[index]! < 0 || (index > 0 && times[index]! <= times[index - 1]!)) fail('Path morph times must be non-negative and strictly increasing.', `${path}.times`);
    }
    const interpolation = literal(component.interpolation, ['step', 'linear', 'cubic-bezier'] as const, `${path}.interpolation`);
    const easings = component.easings === undefined ? undefined : floatArray(component.easings, `${path}.easings`, options.copyFloatData === true);
    if (interpolation === 'cubic-bezier' && easings?.length !== Math.max(0, times.length - 1) * 4) fail('Cubic path morph easing data must contain four numbers per segment.', `${path}.easings`);
    countBudget('path', values.length);
    return Object.freeze({
      type,
      commands,
      times,
      values,
      valueSize,
      interpolation,
      ...(easings === undefined ? {} : { easings }),
      fill: color(component.fill, `${path}.fill`),
      fillRule: component.fillRule === undefined ? 'nonzero' : literal(component.fillRule, ['nonzero', 'evenodd'] as const, `${path}.fillRule`),
      tolerance: component.tolerance === undefined ? 0.35 : positiveNumber(component.tolerance, `${path}.tolerance`),
    });
  }
  if (type === ANIMATION_VECTOR_SHAPE_EXTENSION_ID) {
    const commands = nonEmptyString(component.commands, `${path}.commands`).toUpperCase();
    if (!/^[MLQCZ]+$/.test(commands) || commands[0] !== 'M') fail('Vector shape commands must start with M and contain only M, L, Q, C, Z.', `${path}.commands`);
    validatePathTopology(commands, `${path}.commands`, component.fill !== undefined);
    const values = floatArray(component.values, `${path}.values`, options.copyFloatData === true);
    const valueSize = pathValueCount(commands);
    if (values.length !== valueSize) fail(`Vector shape values length must be ${valueSize}.`, `${path}.values`);
    const morph = component.morph === undefined ? undefined : parseVectorValueTrack(component.morph, `${path}.morph`, valueSize, options.copyFloatData === true);
    const fill = component.fill === undefined ? undefined : parseVectorFill(component.fill, `${path}.fill`, options.copyFloatData === true);
    const stroke = component.stroke === undefined ? undefined : parseVectorStroke(component.stroke, `${path}.stroke`, options.copyFloatData === true);
    const modifiers = component.modifiers === undefined
      ? undefined
      : array(component.modifiers, `${path}.modifiers`).map((modifier, index) => (
        parseVectorModifier(modifier, `${path}.modifiers[${index}]`, options.copyFloatData === true)
      ));
    if (modifiers && (modifiers.length < 1 || modifiers.length > 8)) fail('Vector shape modifiers must contain 1–8 entries.', `${path}.modifiers`);
    if (!fill && !stroke) fail('Vector shape requires a fill or stroke paint.', path);
    countBudget('path', values.length + (morph?.values.length ?? 0));
    return Object.freeze({
      type,
      commands,
      values,
      ...(morph ? { morph } : {}),
      ...(component.morphRelative === true ? { morphRelative: true } : {}),
      ...(fill ? { fill } : {}),
      ...(stroke ? { stroke } : {}),
      ...(modifiers ? { modifiers: Object.freeze(modifiers) } : {}),
      fillRule: component.fillRule === undefined ? 'nonzero' : literal(component.fillRule, ['nonzero', 'evenodd'] as const, `${path}.fillRule`),
      tolerance: component.tolerance === undefined ? 0.35 : positiveNumber(component.tolerance, `${path}.tolerance`),
    });
  }
  validateExtensionId(type);
  const handler = options.extensions?.get(extensionIdFromComponentType(type)!);
  handler?.validateComponent?.(component, extensionContext(type, path));
  return Object.freeze({ ...component, type });
}

function parseTextDocuments(value: unknown, path: string) {
  const documents = array(value, path);
  if (documents.length < 1 || documents.length > 128) fail('Text documents must contain 1–128 keyframes.', path);
  let previousTime = -1;
  return Object.freeze(documents.map((value, index) => {
    const documentPath = `${path}[${index}]`;
    const document = record(value, documentPath);
    const time = nonNegativeNumber(document.time, `${documentPath}.time`);
    if (time <= previousTime) fail('Text document times must be strictly increasing.', `${documentPath}.time`);
    previousTime = time;
    if (typeof document.text !== 'string') fail('Expected text to be a string.', `${documentPath}.text`);
    return Object.freeze({
      time,
      text: document.text,
      ...(document.fontFamily === undefined ? {} : { fontFamily: nonEmptyString(document.fontFamily, `${documentPath}.fontFamily`) }),
      ...(document.fontSize === undefined ? {} : { fontSize: positiveNumber(document.fontSize, `${documentPath}.fontSize`) }),
      ...(document.fontWeight === undefined ? {} : { fontWeight: fontWeight(document.fontWeight, `${documentPath}.fontWeight`) }),
      ...(document.fontStyle === undefined ? {} : { fontStyle: literal(document.fontStyle, ['normal', 'italic'] as const, `${documentPath}.fontStyle`) }),
      ...(document.fontResource === undefined ? {} : { fontResource: nonEmptyString(document.fontResource, `${documentPath}.fontResource`) }),
      ...(document.lineHeight === undefined ? {} : { lineHeight: positiveNumber(document.lineHeight, `${documentPath}.lineHeight`) }),
      ...(document.tracking === undefined ? {} : { tracking: finiteNumber(document.tracking, `${documentPath}.tracking`) }),
      ...(document.textAlign === undefined ? {} : { textAlign: literal(document.textAlign, ['left', 'center', 'right'] as const, `${documentPath}.textAlign`) }),
      ...(document.color === undefined ? {} : { color: color(document.color, `${documentPath}.color`) }),
    });
  }));
}

function parseTextAnimators(value: unknown, path: string, copy: boolean) {
  const animators = array(value, path);
  if (animators.length < 1 || animators.length > 16) fail('Text animators must contain 1–16 entries.', path);
  return Object.freeze(animators.map((value, index) => {
    const animatorPath = `${path}[${index}]`;
    const animator = record(value, animatorPath);
    const selectorPath = `${animatorPath}.selector`;
    const selector = record(animator.selector, selectorPath);
    const amount = selector.amount === undefined ? undefined : finiteNumber(selector.amount, `${selectorPath}.amount`);
    if (amount !== undefined && (amount < -1 || amount > 1)) fail('Text selector amount must be in [-1, 1].', `${selectorPath}.amount`);
    return Object.freeze({
      selector: Object.freeze({
        start: finiteNumber(selector.start, `${selectorPath}.start`),
        end: finiteNumber(selector.end, `${selectorPath}.end`),
        ...(selector.offset === undefined ? {} : { offset: finiteNumber(selector.offset, `${selectorPath}.offset`) }),
        ...(selector.units === undefined ? {} : { units: literal(selector.units, ['percent', 'index'] as const, `${selectorPath}.units`) }),
        ...(amount === undefined ? {} : { amount }),
        ...(selector.shape === undefined ? {} : { shape: literal(selector.shape, TEXT_SELECTOR_SHAPES, `${selectorPath}.shape`) }),
        ...(selector.basedOn === undefined ? {} : { basedOn: literal(selector.basedOn, TEXT_SELECTOR_BASES, `${selectorPath}.basedOn`) }),
        ...(selector.easing === undefined ? {} : { easing: color(selector.easing, `${selectorPath}.easing`) }),
        ...(selector.smoothness === undefined ? {} : { smoothness: unitNumber(selector.smoothness, `${selectorPath}.smoothness`) }),
        ...(selector.randomSeed === undefined ? {} : { randomSeed: boundedInteger(selector.randomSeed, 0, 0xffffffff, `${selectorPath}.randomSeed`) }),
        ...parseVectorTrackField(selector, 'startTrack', selectorPath, 1, copy),
        ...parseVectorTrackField(selector, 'endTrack', selectorPath, 1, copy),
        ...parseVectorTrackField(selector, 'offsetTrack', selectorPath, 1, copy),
        ...parseVectorTrackField(selector, 'amountTrack', selectorPath, 1, copy),
      }),
      ...(animator.position === undefined ? {} : { position: vec2(animator.position, `${animatorPath}.position`) }),
      ...(animator.scale === undefined ? {} : { scale: vec2(animator.scale, `${animatorPath}.scale`) }),
      ...(animator.rotation === undefined ? {} : { rotation: finiteNumber(animator.rotation, `${animatorPath}.rotation`) }),
      ...(animator.opacity === undefined ? {} : { opacity: unitNumber(animator.opacity, `${animatorPath}.opacity`) }),
      ...(animator.fillColor === undefined ? {} : { fillColor: color(animator.fillColor, `${animatorPath}.fillColor`) }),
      ...(animator.tracking === undefined ? {} : { tracking: finiteNumber(animator.tracking, `${animatorPath}.tracking`) }),
      ...parseVectorTrackField(animator, 'positionTrack', animatorPath, 2, copy),
      ...parseVectorTrackField(animator, 'scaleTrack', animatorPath, 2, copy),
      ...parseVectorTrackField(animator, 'rotationTrack', animatorPath, 1, copy),
      ...parseVectorTrackField(animator, 'opacityTrack', animatorPath, 1, copy),
      ...parseVectorTrackField(animator, 'fillColorTrack', animatorPath, 4, copy),
      ...parseVectorTrackField(animator, 'trackingTrack', animatorPath, 1, copy),
    });
  }));
}

function parseLayerEffects(value: unknown, path: string, copy: boolean): readonly AnimationLayerEffect[] {
  const effects = array(value, path);
  if (effects.length < 1 || effects.length > 8) fail('Layer effects must contain 1–8 ordered entries.', path);
  return Object.freeze(effects.map((value, index) => {
    const effectPath = `${path}[${index}]`;
    const effect = record(value, effectPath);
    const kind = literal(effect.kind, ['tint', 'fill', 'opacity', 'color-matrix', 'blur', 'drop-shadow'] as const, `${effectPath}.kind`);
    if (kind === 'tint') return Object.freeze({
      kind,
      black: unitVec3(effect.black, `${effectPath}.black`),
      white: unitVec3(effect.white, `${effectPath}.white`),
      amount: unitNumber(effect.amount, `${effectPath}.amount`),
      ...parseVectorTrackField(effect, 'blackTrack', effectPath, 3, copy),
      ...parseVectorTrackField(effect, 'whiteTrack', effectPath, 3, copy),
      ...parseVectorTrackField(effect, 'amountTrack', effectPath, 1, copy),
    });
    if (kind === 'fill') return Object.freeze({
      kind,
      color: color(effect.color, `${effectPath}.color`),
      ...(effect.opacity === undefined ? {} : { opacity: unitNumber(effect.opacity, `${effectPath}.opacity`) }),
      ...parseVectorTrackField(effect, 'colorTrack', effectPath, 4, copy),
      ...parseVectorTrackField(effect, 'opacityTrack', effectPath, 1, copy),
    });
    if (kind === 'opacity') return Object.freeze({
      kind,
      opacity: unitNumber(effect.opacity, `${effectPath}.opacity`),
      ...parseVectorTrackField(effect, 'opacityTrack', effectPath, 1, copy),
    });
    if (kind === 'color-matrix') {
      const matrix = floatArray(effect.matrix, `${effectPath}.matrix`, copy);
      if (matrix.length !== 20) fail('Color matrix must contain exactly 20 values.', `${effectPath}.matrix`);
      return Object.freeze({
        kind, matrix,
        ...parseVectorTrackField(effect, 'matrixTrack', effectPath, 20, copy),
      });
    }
    if (kind === 'blur') return Object.freeze({
      kind,
      radius: nonNegativeVec2(effect.radius, `${effectPath}.radius`),
      ...parseVectorTrackField(effect, 'radiusTrack', effectPath, 2, copy),
    });
    return Object.freeze({
      kind,
      color: color(effect.color, `${effectPath}.color`),
      opacity: unitNumber(effect.opacity, `${effectPath}.opacity`),
      offset: vec2(effect.offset, `${effectPath}.offset`),
      blur: nonNegativeNumber(effect.blur, `${effectPath}.blur`),
      ...parseVectorTrackField(effect, 'colorTrack', effectPath, 4, copy),
      ...parseVectorTrackField(effect, 'opacityTrack', effectPath, 1, copy),
      ...parseVectorTrackField(effect, 'offsetTrack', effectPath, 2, copy),
      ...parseVectorTrackField(effect, 'blurTrack', effectPath, 1, copy),
    });
  }));
}

/** @internal Compact-binary effect decoder entry point. */
export function parseBinaryEffectsValue(
  value: unknown,
  path: string,
  copy: boolean,
): readonly AnimationLayerEffect[] {
  return parseLayerEffects(value, path, copy);
}

function parseVectorModifier(value: unknown, path: string, copy: boolean) {
  const modifier = record(value, path);
  const kind = literal(modifier.kind, ['trim-path', 'round-corners'] as const, `${path}.kind`);
  if (kind === 'round-corners') return Object.freeze({
    kind,
    radius: nonNegativeNumber(modifier.radius, `${path}.radius`),
    ...parseVectorTrackField(modifier, 'radiusTrack', path, 1, copy),
  });
  return Object.freeze({
    kind,
    start: finiteNumber(modifier.start, `${path}.start`),
    end: finiteNumber(modifier.end, `${path}.end`),
    offset: finiteNumber(modifier.offset, `${path}.offset`),
    mode: literal(modifier.mode, ['simultaneous', 'individual'] as const, `${path}.mode`),
    ...parseVectorTrackField(modifier, 'startTrack', path, 1, copy),
    ...parseVectorTrackField(modifier, 'endTrack', path, 1, copy),
    ...parseVectorTrackField(modifier, 'offsetTrack', path, 1, copy),
  });
}

function parseVectorTrackField(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  valueSize: number,
  copy: boolean,
): Record<string, AnimationVectorValueTrack> {
  const value = owner[key];
  return value === undefined ? {} : { [key]: parseVectorValueTrack(value, `${path}.${key}`, valueSize, copy) };
}

function parseVectorValueTrack(
  value: unknown,
  path: string,
  expectedValueSize: number | undefined,
  copy: boolean,
): AnimationVectorValueTrack {
  const track = record(value, path);
  const valueSize = safeInteger(track.valueSize, `${path}.valueSize`);
  if (valueSize < 1 || valueSize > 4096 || (expectedValueSize !== undefined && valueSize !== expectedValueSize)) {
    fail(`Vector track valueSize must be ${expectedValueSize ?? 'between 1 and 4096'}.`, `${path}.valueSize`);
  }
  const times = floatArray(track.times, `${path}.times`, copy);
  const values = floatArray(track.values, `${path}.values`, copy);
  if (times.length < 1 || values.length !== times.length * valueSize) fail('Vector track values must contain valueSize numbers for every keyframe.', `${path}.values`);
  for (let index = 0; index < times.length; index++) {
    if (times[index]! < 0 || (index > 0 && times[index]! <= times[index - 1]!)) fail('Vector track times must be non-negative and strictly increasing.', `${path}.times`);
  }
  const interpolation = literal(track.interpolation, ['step', 'linear', 'cubic-bezier'] as const, `${path}.interpolation`);
  const easings = track.easings === undefined ? undefined : floatArray(track.easings, `${path}.easings`, copy);
  if (interpolation === 'cubic-bezier' && easings?.length !== Math.max(0, times.length - 1) * 4) fail('Cubic vector track easing data must contain four numbers per segment.', `${path}.easings`);
  if (interpolation !== 'cubic-bezier' && easings !== undefined) fail('Vector track easings require cubic-bezier interpolation.', `${path}.easings`);
  return Object.freeze({ times, values, valueSize, interpolation, ...(easings ? { easings } : {}) });
}

function parseVectorFill(value: unknown, path: string, copy: boolean) {
  const fill = record(value, path);
  const kind = literal(fill.kind, ['solid', 'linear-gradient', 'radial-gradient'] as const, `${path}.kind`);
  const opacityTrack = fill.opacityTrack === undefined ? undefined : parseVectorValueTrack(fill.opacityTrack, `${path}.opacityTrack`, 1, copy);
  if (kind === 'solid') {
    return Object.freeze({
      kind,
      color: color(fill.color, `${path}.color`),
      ...(fill.opacity === undefined ? {} : { opacity: unitNumber(fill.opacity, `${path}.opacity`) }),
      ...parseVectorTrackField(fill, 'colorTrack', path, 4, copy),
      ...(opacityTrack ? { opacityTrack } : {}),
    });
  }
  const stops = floatArray(fill.stops, `${path}.stops`, copy);
  if (stops.length < 10 || stops.length > 40 || stops.length % 5 !== 0) fail('Gradient stops must contain 2–8 offset,r,g,b,a tuples.', `${path}.stops`);
  let previousOffset = -Infinity;
  for (let offset = 0; offset < stops.length; offset += 5) {
    if (stops[offset]! < previousOffset || stops[offset]! < 0 || stops[offset]! > 1) fail('Gradient stop offsets must be ordered in [0, 1].', `${path}.stops[${offset}]`);
    previousOffset = stops[offset]!;
    for (let channel = 1; channel < 5; channel++) if (stops[offset + channel]! < 0 || stops[offset + channel]! > 1) fail('Gradient stop channels must be in [0, 1].', `${path}.stops[${offset + channel}]`);
  }
  return Object.freeze({
    kind,
    start: vec2(fill.start, `${path}.start`),
    end: vec2(fill.end, `${path}.end`),
    stops,
    ...(fill.opacity === undefined ? {} : { opacity: unitNumber(fill.opacity, `${path}.opacity`) }),
    ...parseVectorTrackField(fill, 'startTrack', path, 2, copy),
    ...parseVectorTrackField(fill, 'endTrack', path, 2, copy),
    ...parseVectorTrackField(fill, 'stopsTrack', path, stops.length, copy),
    ...(opacityTrack ? { opacityTrack } : {}),
  });
}

function parseVectorStroke(value: unknown, path: string, copy: boolean) {
  const stroke = record(value, path);
  const dash = stroke.dash === undefined ? undefined : floatArray(stroke.dash, `${path}.dash`, copy);
  if (dash && (dash.length < 1 || dash.length > 32 || Array.from(dash).some(value => value < 0))) fail('Stroke dash values must contain 1–32 non-negative numbers.', `${path}.dash`);
  const gradient = stroke.gradient === undefined ? undefined : parseVectorFill(stroke.gradient, `${path}.gradient`, copy);
  if (gradient?.kind === 'solid') fail('Stroke gradient must be linear-gradient or radial-gradient.', `${path}.gradient.kind`);
  return Object.freeze({
    color: color(stroke.color, `${path}.color`),
    width: positiveNumber(stroke.width, `${path}.width`),
    ...(stroke.opacity === undefined ? {} : { opacity: unitNumber(stroke.opacity, `${path}.opacity`) }),
    lineCap: literal(stroke.lineCap, ['butt', 'round', 'square'] as const, `${path}.lineCap`),
    lineJoin: literal(stroke.lineJoin, ['miter', 'round', 'bevel'] as const, `${path}.lineJoin`),
    miterLimit: positiveNumber(stroke.miterLimit, `${path}.miterLimit`),
    ...(gradient ? { gradient } : {}),
    ...(dash ? { dash } : {}),
    ...(stroke.dashOffset === undefined ? {} : { dashOffset: finiteNumber(stroke.dashOffset, `${path}.dashOffset`) }),
    ...parseVectorTrackField(stroke, 'colorTrack', path, 4, copy),
    ...parseVectorTrackField(stroke, 'opacityTrack', path, 1, copy),
    ...parseVectorTrackField(stroke, 'widthTrack', path, 1, copy),
    ...parseVectorTrackField(stroke, 'dashOffsetTrack', path, 1, copy),
  });
}

/** @internal Compact-binary component decoder entry point. */
export function parseBinaryComponentValue(
  value: unknown,
  path: string,
  options: AnimationParseOptions,
  countBudget: (kind: 'path' | 'text' | 'particle', count: number) => void,
): AnimationComponent {
  return parseComponent(value, path, options, countBudget);
}

function parseComposite(value: unknown, path: string, copy: boolean) {
  const composite = record(value, path);
  if (composite.layers !== undefined) {
    const values = array(composite.layers, `${path}.layers`);
    if (values.length < 1 || values.length > 8) fail('Composite stacks must contain between 1 and 8 layers.', `${path}.layers`);
    return Object.freeze({
      layers: Object.freeze(values.map((layer, index) => parseCompositeLayer(layer, `${path}.layers[${index}]`, copy))),
    });
  }
  return parseCompositeLayer(composite, path, copy);
}

function parseCompositeLayer(value: unknown, path: string, copy: boolean) {
  const composite = record(value, path);
  return Object.freeze({
    kind: literal(composite.kind, ['mask', 'matte'] as const, `${path}.kind`),
    source: nonEmptyString(composite.source, `${path}.source`),
    mode: literal(composite.mode, ['alpha', 'alpha-inverted', 'luma', 'luma-inverted'] as const, `${path}.mode`),
    ...(composite.operation === undefined ? {} : {
      operation: literal(composite.operation, ['add', 'subtract', 'intersect', 'difference'] as const, `${path}.operation`),
    }),
    ...(composite.feather === undefined ? {} : { feather: nonNegativeVec2(composite.feather, `${path}.feather`) }),
    ...(composite.expansion === undefined ? {} : { expansion: finiteNumber(composite.expansion, `${path}.expansion`) }),
    ...parseVectorTrackField(composite, 'expansionTrack', path, 1, copy),
  });
}

/** @internal Compact-binary structural decoder entry point. */
export function parseBinaryTrackValue(value: unknown, index: number, nodeIds: Set<string>, duration: number, copy: boolean): ParsedAnimationTrack {
  const path = `$.tracks[${index}]`;
  const track = record(value, path);
  const node = nonEmptyString(track.node, `${path}.node`);
  if (!nodeIds.has(node)) fail(`Track references missing node "${node}".`, `${path}.node`);
  const property = literal(track.property, ['position', 'rotation', 'scale', 'opacity'] as const, `${path}.property`);
  const interpolation = literal(track.interpolation, ['step', 'linear', 'cubic-bezier'] as const, `${path}.interpolation`);
  const times = floatArray(track.times, `${path}.times`, copy);
  if (times.length < 1) fail('Track must contain at least one keyframe.', `${path}.times`);
  let previous = -Infinity;
  // Track pools are Float32-backed. A source key exactly at a non-representable
  // composition duration may round above the Float64 duration, but no later
  // representable Float32 value is part of that boundary.
  const maximumTrackTime = Math.max(duration, Math.fround(duration));
  for (let i = 0; i < times.length; i++) {
    const current = requiredFloat(times, i, `${path}.times`);
    if (current < 0 || current <= previous) fail('Track times must be finite, non-negative and strictly increasing.', `${path}.times[${i}]`);
    if (current > maximumTrackTime) fail('Track time exceeds the composition duration.', `${path}.times[${i}]`);
    previous = current;
  }
  const valueSize = trackValueSize(property);
  const values = floatArray(track.values, `${path}.values`, copy);
  if (values.length !== times.length * valueSize) {
    fail(`Track values length must equal keyframe count × ${valueSize}.`, `${path}.values`);
  }
  const easings = track.easings === undefined ? undefined : floatArray(track.easings, `${path}.easings`, copy);
  if (interpolation === 'cubic-bezier') {
    const expected = Math.max(0, times.length - 1) * 4;
    if (!easings || easings.length !== expected) fail(`Cubic track easings length must be ${expected}.`, `${path}.easings`);
    for (let i = 0; i < easings.length; i += 4) {
      if (requiredFloat(easings, i, `${path}.easings`) < 0 || requiredFloat(easings, i, `${path}.easings`) > 1
        || requiredFloat(easings, i + 2, `${path}.easings`) < 0 || requiredFloat(easings, i + 2, `${path}.easings`) > 1) {
        fail('Cubic easing x control points must be in [0, 1].', `${path}.easings[${i}]`);
      }
    }
  } else if (easings) {
    fail('easings are only valid for cubic-bezier tracks.', `${path}.easings`);
  }
  const spatialTangents = track.spatialTangents === undefined
    ? undefined
    : floatArray(track.spatialTangents, `${path}.spatialTangents`, copy);
  if (spatialTangents) {
    const expected = Math.max(0, times.length - 1) * 4;
    if (property !== 'position' || interpolation === 'step' || spatialTangents.length !== expected) {
      fail(`spatialTangents require position, non-step and ${expected} values.`, `${path}.spatialTangents`);
    }
  }
  return Object.freeze({
    node, property, interpolation, times, values, valueSize,
    ...(easings ? { easings } : {}),
    ...(spatialTangents ? { spatialTangents } : {}),
  });
}

/** @internal Compact-binary structural decoder entry point. */
export function parseBinaryResourceValue(value: unknown, index: number, ids: Set<string>): Readonly<AnimationResource> {
  const path = `$.resources[${index}]`;
  const resource = record(value, path);
  const id = nonEmptyString(resource.id, `${path}.id`);
  if (ids.has(id)) fail(`Duplicate resource id "${id}".`, `${path}.id`);
  ids.add(id);
  const type = literal(resource.type, ['image', 'audio', 'binary'] as const, `${path}.type`);
  return Object.freeze({
    id,
    type,
    uri: nonEmptyString(resource.uri, `${path}.uri`),
    ...(resource.mimeType !== undefined ? { mimeType: nonEmptyString(resource.mimeType, `${path}.mimeType`) } : {}),
    ...(resource.integrity !== undefined ? { integrity: nonEmptyString(resource.integrity, `${path}.integrity`) } : {}),
    ...(type === 'image' && resource.width !== undefined ? { width: positiveNumber(resource.width, `${path}.width`) } : {}),
    ...(type === 'image' && resource.height !== undefined ? { height: positiveNumber(resource.height, `${path}.height`) } : {}),
    ...(type === 'image' && resource.colorSpace !== undefined
      ? { colorSpace: literal(resource.colorSpace, ['srgb', 'linear'] as const, `${path}.colorSpace`) }
      : {}),
  });
}

function validateHierarchy(nodes: readonly Readonly<AnimationNode>[], ids: Set<string>): void {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const states = new Uint8Array(nodes.length);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.parent && !ids.has(node.parent)) fail(`Node references missing parent "${node.parent}".`, `$.nodes[${index}].parent`);
    if (states[index] !== 0) continue;
    let cursor: number | undefined = index;
    while (cursor !== undefined && states[cursor] === 0) {
      states[cursor] = 1;
      const parentId: string | undefined = nodes[cursor]!.parent;
      cursor = parentId === undefined ? undefined : indexById.get(parentId);
    }
    if (cursor !== undefined && states[cursor] === 1) {
      fail('Node hierarchy contains a cycle.', `$.nodes[${index}].parent`);
    }
    cursor = index;
    while (cursor !== undefined && states[cursor] === 1) {
      states[cursor] = 2;
      const parentId: string | undefined = nodes[cursor]!.parent;
      cursor = parentId === undefined ? undefined : indexById.get(parentId);
    }
  }
}

function validateComposites(nodes: readonly Readonly<AnimationNode>[], ids: Set<string>): void {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const layers = compositeLayers(node.composite);
    for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
      const source = layers[layerIndex]!.source;
      const sourcePath = compositeSourcePath(index, node.composite!, layerIndex);
      if (!ids.has(source)) fail(`Composite references missing source node "${source}".`, sourcePath);
      if (source === node.id) fail('Composite source cannot reference its own node.', sourcePath);
    }
  }
  const states = new Uint8Array(nodes.length);
  const visit = (index: number): void => {
    if (states[index] === 2) return;
    if (states[index] === 1) fail('Composite graph contains a cycle.', `$.nodes[${index}].composite`);
    states[index] = 1;
    for (const layer of compositeLayers(nodes[index]!.composite)) visit(indexById.get(layer.source)!);
    states[index] = 2;
  };
  for (let index = 0; index < nodes.length; index++) visit(index);
}

function compositeLayers(composite: Readonly<AnimationNode>['composite']): readonly AnimationCompositeLayer[] {
  if (!composite) return [];
  return 'layers' in composite ? composite.layers : [composite];
}

function compositeSourcePath(index: number, composite: NonNullable<Readonly<AnimationNode>['composite']>, layerIndex: number): string {
  return 'layers' in composite
    ? `$.nodes[${index}].composite.layers[${layerIndex}].source`
    : `$.nodes[${index}].composite.source`;
}

function extensionContext(extension: string, path: string) {
  return {
    extension,
    path,
    fail(message: string, overridePath = path): never { return fail(message, overridePath); },
  };
}

function trackValueSize(property: AnimationTrackProperty): 1 | 2 {
  return property === 'position' || property === 'scale' ? 2 : 1;
}

function floatArray(value: unknown, path: string, copy: boolean): Float32Array {
  if (value instanceof Float32Array) {
    for (let i = 0; i < value.length; i++) requiredFloat(value, i, path);
    return copy ? new Float32Array(value) : value;
  }
  const values = array(value, path);
  const result = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) result[i] = finiteNumber(values[i], `${path}[${i}]`);
  return result;
}

function pathValueCount(commands: string): number {
  let count = 0;
  for (const command of commands) count += command === 'M' || command === 'L' ? 2 : command === 'Q' ? 4 : command === 'C' ? 6 : 0;
  return count;
}

function validatePathTopology(commands: string, path: string, requireClosed = true): void {
  let open = false;
  let pointCount = 0;
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!;
    if (command === 'M') {
      if (open && requireClosed) fail('Each filled subpath must be closed with Z before the next M.', `${path}[${index}]`);
      open = true;
      pointCount = 1;
    } else if (command === 'Z') {
      if (!open || pointCount < (requireClosed ? 3 : 2)) fail(`Each ${requireClosed ? 'filled ' : ''}subpath must contain at least ${requireClosed ? 'three' : 'two'} points before Z.`, `${path}[${index}]`);
      open = false;
      pointCount = 0;
    } else {
      if (!open) fail('L, Q and C commands must follow M inside a subpath.', `${path}[${index}]`);
      pointCount++;
    }
  }
  if (open && requireClosed) fail('Each filled subpath must end with Z.', path);
}

function stringList(value: unknown, path: string): string[] {
  const values = array(value, path);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < values.length; i++) {
    const item = nonEmptyString(values[i], `${path}[${i}]`);
    if (seen.has(item)) fail(`Duplicate value "${item}".`, `${path}[${i}]`);
    seen.add(item);
    result.push(item);
  }
  return result;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) fail('Expected an object.', path);
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail('Expected an array.', path);
  return value;
}

function vec2(value: unknown, path: string): readonly [number, number] {
  const values = array(value, path);
  if (values.length !== 2) fail('Expected exactly two numbers.', path);
  return Object.freeze([finiteNumber(values[0], `${path}[0]`), finiteNumber(values[1], `${path}[1]`)] as [number, number]);
}

function positiveVec2(value: unknown, path: string): readonly [number, number] {
  const values = vec2(value, path);
  if (values[0] <= 0 || values[1] <= 0) fail('Expected two positive numbers.', path);
  return values;
}

function nonNegativeVec2(value: unknown, path: string): readonly [number, number] {
  const values = vec2(value, path);
  if (values[0] < 0 || values[1] < 0) fail('Expected two non-negative numbers.', path);
  return values;
}

function numericRange(value: unknown, path: string, minimum = -Infinity): readonly [number, number] {
  const values = vec2(value, path);
  if (values[0] < minimum || values[1] < values[0]) fail(`Expected an ascending numeric range above ${minimum}.`, path);
  return values;
}

function color(value: unknown, path: string): readonly [number, number, number, number] {
  const values = array(value, path);
  if (values.length !== 4) fail('Expected RGBA with four numbers.', path);
  return Object.freeze([
    unitNumber(values[0], `${path}[0]`), unitNumber(values[1], `${path}[1]`),
    unitNumber(values[2], `${path}[2]`), unitNumber(values[3], `${path}[3]`),
  ] as [number, number, number, number]);
}

function textLineBackground(value: unknown, path: string) {
  const background = record(value, path);
  return Object.freeze({
    fill: color(background.fill, `${path}.fill`),
    ...(background.stroke === undefined ? {} : { stroke: color(background.stroke, `${path}.stroke`) }),
    ...(background.strokeWidth === undefined ? {} : { strokeWidth: nonNegativeNumber(background.strokeWidth, `${path}.strokeWidth`) }),
    ...(background.cornerRadius === undefined ? {} : { cornerRadius: nonNegativeNumber(background.cornerRadius, `${path}.cornerRadius`) }),
    ...(background.padding === undefined ? {} : { padding: nonNegativeNumber(background.padding, `${path}.padding`) }),
  });
}

function unitVec3(value: unknown, path: string): readonly [number, number, number] {
  const values = array(value, path);
  if (values.length !== 3) fail('Expected RGB with three numbers.', path);
  return Object.freeze([
    unitNumber(values[0], `${path}[0]`),
    unitNumber(values[1], `${path}[1]`),
    unitNumber(values[2], `${path}[2]`),
  ] as [number, number, number]);
}

function uvRect(value: unknown, path: string): readonly [number, number, number, number] {
  const values = array(value, path);
  if (values.length !== 4) fail('Expected normalized UV rectangle with four numbers.', path);
  const x = unitNumber(values[0], `${path}[0]`);
  const y = unitNumber(values[1], `${path}[1]`);
  const width = positiveNumber(values[2], `${path}[2]`);
  const height = positiveNumber(values[3], `${path}[3]`);
  if (x + width > 1 + 1e-6 || y + height > 1 + 1e-6) fail('UV rectangle must fit inside [0, 1].', path);
  return Object.freeze([x, y, width, height] as [number, number, number, number]);
}

function validateUvRectTrack(track: AnimationVectorValueTrack, path: string): void {
  for (let frame = 0; frame < track.times.length; frame++) {
    const offset = frame * 4;
    uvRect([
      track.values[offset],
      track.values[offset + 1],
      track.values[offset + 2],
      track.values[offset + 3],
    ], `${path}.values[${offset}..${offset + 3}]`);
  }
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('Expected a finite number.', path);
  return value;
}

function positiveNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result <= 0) fail('Expected a positive number.', path);
  return result;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result < 0) fail('Expected a non-negative number.', path);
  return result;
}

function unitNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result < 0 || result > 1) fail('Expected a number in [0, 1].', path);
  return result;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('Expected a non-empty string.', path);
  return value;
}

function fontWeight(value: unknown, path: string): string | number {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 1000) return value;
  fail('Expected a non-empty font weight string or a number in [1, 1000].', path);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('Expected a boolean.', path);
  return value;
}

function safeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('Expected a safe integer.', path);
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, path: string): number {
  const result = safeInteger(value, path);
  if (result < minimum || result > maximum) fail(`Expected an integer in [${minimum}, ${maximum}].`, path);
  return result;
}

function literal<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) fail(`Expected one of: ${values.join(', ')}.`, path);
  return value as T[number];
}

function requiredFloat(values: Float32Array, index: number, path: string): number {
  const value = values[index];
  if (value === undefined || !Number.isFinite(value)) fail('Expected finite Float32 values.', `${path}[${index}]`);
  return value;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive safe integer.`, '$options');
  return value;
}

function limit(actual: number, maximum: number, label: string, path: string): void {
  if (actual > maximum) throw new AnimationFormatError('E_ANIMATION_LIMIT_EXCEEDED', `${label} count ${actual} exceeds limit ${maximum}.`, path);
}

function fail(message: string, path: string): never {
  throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', message, path);
}
