import {
  SHADER_STAGES,
  type ShaderCoordinateSpace,
  type ShaderResourceDefinition,
  type ShaderStage,
} from '../contracts';
import { shaderError } from '../diagnostics';
import type {
  ShaderIrBuilder,
  ShaderIrNode,
  ShaderIrNodeOperation,
  ShaderIrPayloadValue,
  ShaderIrSource,
  ShaderIrTextureSampleOptions,
  ShaderIrValue,
} from './contracts';
import {
  genericShaderIrType,
  normalizeShaderIrValueType,
  parseShaderIrDataType,
  shaderIrValueTypeKey,
  shaderIrValueTypesEqual,
  type ShaderIrDataType,
  type ShaderIrSemantic,
  type ShaderIrValueType,
  type ShaderIrValueTypeDefinition,
} from './types';
import {
  assertSameShaderIrType,
  ensureShaderIrNumeric,
  isCompatibleShaderIrScalarMultiplier,
  preservedShaderIrSwizzleType,
  requireShaderIrSemantic,
  requireShaderIrTargetSpace,
  requireShaderIrTransform,
  throwShaderIrResourceError,
  throwShaderIrTypeError,
  validateShaderIrLiteral,
} from './rules';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

class ShaderIrValueImpl implements ShaderIrValue {
  readonly type: ShaderIrValueType;
  readonly allowedStages: readonly ShaderStage[];
  readonly nodeId: number;
  readonly owner: ShaderIrBuilderImpl;

  constructor(owner: ShaderIrBuilderImpl, node: ShaderIrNode) {
    this.owner = owner;
    this.nodeId = node.id;
    this.type = node.type;
    this.allowedStages = node.allowedStages;
    Object.freeze(this);
  }
}

export class ShaderIrBuilderImpl implements ShaderIrBuilder {
  readonly moduleId: string;
  readonly entryId: string;
  readonly entryStage: ShaderStage;
  readonly resources: ReadonlyMap<string, ShaderResourceDefinition>;
  readonly nodes: ShaderIrNode[] = [];

  constructor(
    moduleId: string,
    entryId: string,
    entryStage: ShaderStage,
    resources: readonly ShaderResourceDefinition[],
  ) {
    this.moduleId = moduleId;
    this.entryId = entryId;
    this.entryStage = entryStage;
    this.resources = new Map(resources.map(resource => [resource.id, resource]));
  }

  createInput(id: string, type: ShaderIrValueType, source: ShaderIrSource): ShaderIrValue {
    return this.createNode('input', type, [], { id }, [this.entryStage], source);
  }

  createValueForInput(node: ShaderIrNode): ShaderIrValue {
    if (node.operation !== 'input' || this.nodes[node.id] !== node) {
      shaderError('E_SHADER_IR_INVALID', 'Only an owned input node can be exposed to an entry builder.', {
        moduleId: this.moduleId,
        path: `${this.entryId}.nodes.${node.id}`,
      });
    }
    return new ShaderIrValueImpl(this, node);
  }

  nodeId(value: ShaderIrValue, path = 'value'): number {
    return this.unwrap(value, path).nodeId;
  }

  snapshotNodes(): readonly ShaderIrNode[] {
    return Object.freeze([...this.nodes]);
  }

  literal(
    typeDefinition: ShaderIrValueTypeDefinition,
    value: boolean | number | readonly number[],
    source?: ShaderIrSource,
  ): ShaderIrValue {
    const type = normalizeShaderIrValueType(typeDefinition, this.moduleId, `${this.entryId}.literal.type`);
    const normalized = validateShaderIrLiteral(type.dataType, value, this.moduleId, `${this.entryId}.literal.value`);
    const payload: Record<string, ShaderIrPayloadValue> = Array.isArray(normalized)
      ? { values: normalized }
      : { value: normalized as boolean | number };
    return this.createNode('literal', type, [], payload, SHADER_STAGES, source);
  }

  uniformField(resourceId: string, fieldId: string, source?: ShaderIrSource): ShaderIrValue {
    const resource = this.resources.get(resourceId);
    if (!resource || resource.kind !== 'uniform-buffer' || !resource.fields) {
      throwShaderIrResourceError(this.moduleId, `${this.entryId}.resources.${resourceId}`, `Typed IR requires declared generated uniform block ${resourceId}.`);
    }
    const field = resource.fields.find(candidate => candidate.id === fieldId);
    if (!field) {
      throwShaderIrResourceError(this.moduleId, `${this.entryId}.resources.${resourceId}.${fieldId}`, `Uniform ${resourceId} has no field ${fieldId}.`);
    }
    const type = normalizeShaderIrValueType({
      dataType: field.type as ShaderIrDataType,
      ...(field.semantic === undefined ? {} : { semantic: field.semantic }),
      ...(field.coordinateSpace === undefined ? {} : { coordinateSpace: field.coordinateSpace }),
      ...(field.colorSpace === undefined ? {} : { colorSpace: field.colorSpace }),
      ...(field.fromSpace === undefined ? {} : { fromSpace: field.fromSpace }),
      ...(field.toSpace === undefined ? {} : { toSpace: field.toSpace }),
    }, this.moduleId, `${this.entryId}.resources.${resourceId}.${fieldId}`);
    return this.createNode(
      'uniform-field',
      type,
      [],
      { resourceId, fieldId },
      resource.visibility,
      source,
    );
  }

  splat(value: ShaderIrValue, width: 2 | 3 | 4, source?: ShaderIrSource): ShaderIrValue {
    const input = this.unwrap(value, 'splat.value');
    const info = parseShaderIrDataType(input.type.dataType, this.moduleId, `${this.entryId}.splat.value`);
    if (info.kind !== 'scalar') throwShaderIrTypeError(this.moduleId, 'splat.value', 'scalar', shaderIrValueTypeKey(input.type));
    const type = genericShaderIrType(`vec${width}<${info.scalarType}>`);
    return this.createNode('splat', type, [input], { width }, input.allowedStages, source);
  }

  construct(
    typeDefinition: ShaderIrValueTypeDefinition,
    values: readonly ShaderIrValue[],
    source?: ShaderIrSource,
  ): ShaderIrValue {
    const type = normalizeShaderIrValueType(typeDefinition, this.moduleId, `${this.entryId}.construct.type`);
    const target = parseShaderIrDataType(type.dataType, this.moduleId, `${this.entryId}.construct.type`);
    if (target.kind !== 'vector') {
      shaderError('E_SHADER_TYPE_MISMATCH', `Stage 2 construct supports vector results, not ${type.dataType}.`, {
        moduleId: this.moduleId,
        path: `${this.entryId}.construct.type`,
      });
    }
    const operands = values.map((value, index) => this.unwrap(value, `construct.values.${index}`));
    let components = 0;
    for (const [index, operand] of operands.entries()) {
      const info = parseShaderIrDataType(operand.type.dataType, this.moduleId, `${this.entryId}.construct.values.${index}`);
      if ((info.kind !== 'scalar' && info.kind !== 'vector') || info.scalarType !== target.scalarType) {
        throwShaderIrTypeError(this.moduleId, `construct.values.${index}`, `${target.scalarType} scalar/vector`, operand.type.dataType);
      }
      components += info.width;
    }
    if (components !== target.width) {
      throwShaderIrTypeError(this.moduleId, 'construct.values', `${target.width} ${target.scalarType} components`, String(components));
    }
    return this.createNode('construct', type, operands, {}, intersectOperandStages(operands), source);
  }

  cast(value: ShaderIrValue, dataType: ShaderIrDataType, source?: ShaderIrSource): ShaderIrValue {
    const input = this.unwrap(value, 'cast.value');
    const from = parseShaderIrDataType(input.type.dataType, this.moduleId, `${this.entryId}.cast.value`);
    const to = parseShaderIrDataType(dataType, this.moduleId, `${this.entryId}.cast.dataType`);
    if (from.kind !== to.kind || from.width !== to.width || from.rows !== to.rows || from.kind === 'matrix') {
      throwShaderIrTypeError(this.moduleId, 'cast.dataType', `same scalar/vector shape as ${input.type.dataType}`, dataType);
    }
    return this.createNode('cast', genericShaderIrType(dataType), [input], { dataType }, input.allowedStages, source);
  }

  withSemantic(
    value: ShaderIrValue,
    typeDefinition: ShaderIrValueTypeDefinition,
    source?: ShaderIrSource,
  ): ShaderIrValue {
    const input = this.unwrap(value, 'withSemantic.value');
    const type = normalizeShaderIrValueType(typeDefinition, this.moduleId, `${this.entryId}.withSemantic.type`);
    if (input.type.dataType !== type.dataType) {
      throwShaderIrTypeError(this.moduleId, 'withSemantic.type', input.type.dataType, type.dataType);
    }
    return this.createNode('semantic', type, [input], {}, input.allowedStages, source);
  }

  add(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    return this.addOrSubtract('add', left, right, source);
  }

  subtract(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    return this.addOrSubtract('subtract', left, right, source);
  }

  multiply(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    const a = this.unwrap(left, 'multiply.left');
    const b = this.unwrap(right, 'multiply.right');
    let output: ShaderIrValueType;
    if (shaderIrValueTypesEqual(a.type, b.type)) {
      ensureShaderIrNumeric(a.type, this.moduleId, `${this.entryId}.multiply`);
      output = a.type;
    } else if (isCompatibleShaderIrScalarMultiplier(a.type, b.type)) {
      output = b.type;
    } else if (isCompatibleShaderIrScalarMultiplier(b.type, a.type)) {
      output = a.type;
    } else {
      assertSameShaderIrType(a.type, b.type, this.moduleId, `${this.entryId}.multiply`);
      output = a.type;
    }
    return this.createNode('multiply', output, [a, b], {}, intersectOperandStages([a, b]), source);
  }

  divide(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    const a = this.unwrap(left, 'divide.left');
    const b = this.unwrap(right, 'divide.right');
    if (!shaderIrValueTypesEqual(a.type, b.type) && !isCompatibleShaderIrScalarMultiplier(b.type, a.type)) {
      assertSameShaderIrType(a.type, b.type, this.moduleId, `${this.entryId}.divide`);
    }
    ensureShaderIrNumeric(a.type, this.moduleId, `${this.entryId}.divide`);
    return this.createNode('divide', a.type, [a, b], {}, intersectOperandStages([a, b]), source);
  }

  dot(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    const a = this.unwrap(left, 'dot.left');
    const b = this.unwrap(right, 'dot.right');
    assertSameShaderIrType(a.type, b.type, this.moduleId, `${this.entryId}.dot`);
    const info = parseShaderIrDataType(a.type.dataType, this.moduleId, `${this.entryId}.dot`);
    if (info.kind !== 'vector' || info.scalarType !== 'f32') {
      throwShaderIrTypeError(this.moduleId, 'dot', 'f32 vector', a.type.dataType);
    }
    return this.createNode('dot', genericShaderIrType('f32'), [a, b], {}, intersectOperandStages([a, b]), source);
  }

  cross(left: ShaderIrValue, right: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    const a = this.unwrap(left, 'cross.left');
    const b = this.unwrap(right, 'cross.right');
    const aInfo = parseShaderIrDataType(a.type.dataType, this.moduleId, `${this.entryId}.cross.left`);
    const bInfo = parseShaderIrDataType(b.type.dataType, this.moduleId, `${this.entryId}.cross.right`);
    if (aInfo.dataType !== 'vec3<f32>' || bInfo.dataType !== 'vec3<f32>') {
      throwShaderIrTypeError(this.moduleId, `${this.entryId}.cross`, 'vec3<f32> operands', `${a.type.dataType}, ${b.type.dataType}`);
    }
    const coordinateSpace = a.type.coordinateSpace ?? b.type.coordinateSpace;
    if (a.type.coordinateSpace !== b.type.coordinateSpace) {
      shaderError('E_SHADER_SPACE_MISMATCH', `cross operands must use one coordinate space, got ${shaderIrValueTypeKey(a.type)} and ${shaderIrValueTypeKey(b.type)}.`, {
        moduleId: this.moduleId,
        path: `${this.entryId}.cross`,
      });
    }
    const spatial = ['direction', 'normal'].includes(a.type.semantic)
      && ['direction', 'normal'].includes(b.type.semantic);
    if (!spatial && (a.type.semantic !== 'value' || b.type.semantic !== 'value')) {
      shaderError('E_SHADER_SEMANTIC_MISMATCH', `cross requires generic vectors or direction/normal vectors, got ${a.type.semantic} and ${b.type.semantic}.`, {
        moduleId: this.moduleId,
        path: `${this.entryId}.cross`,
      });
    }
    const output = spatial
      ? normalizeShaderIrValueType({ dataType: 'vec3<f32>', semantic: 'direction', coordinateSpace: coordinateSpace! }, this.moduleId, `${this.entryId}.cross.output`)
      : genericShaderIrType('vec3<f32>');
    return this.createNode('cross', output, [a, b], {}, intersectOperandStages([a, b]), source);
  }

  normalize(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    const input = this.unwrap(value, 'normalize.value');
    const info = parseShaderIrDataType(input.type.dataType, this.moduleId, `${this.entryId}.normalize`);
    if (info.kind !== 'vector' || info.scalarType !== 'f32') {
      throwShaderIrTypeError(this.moduleId, 'normalize.value', 'f32 vector', input.type.dataType);
    }
    return this.createNode('normalize', input.type, [input], {}, input.allowedStages, source);
  }

  pow(base: ShaderIrValue, exponent: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    const a = this.unwrap(base, 'pow.base');
    const b = this.unwrap(exponent, 'pow.exponent');
    assertSameShaderIrType(a.type, b.type, this.moduleId, `${this.entryId}.pow`);
    const info = parseShaderIrDataType(a.type.dataType, this.moduleId, `${this.entryId}.pow`);
    if (a.type.semantic !== 'value' || info.scalarType !== 'f32' || (info.kind !== 'scalar' && info.kind !== 'vector')) {
      throwShaderIrTypeError(this.moduleId, `${this.entryId}.pow`, 'generic f32 scalar/vector', shaderIrValueTypeKey(a.type));
    }
    return this.createNode('pow', a.type, [a, b], {}, intersectOperandStages([a, b]), source);
  }

  sqrt(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    const input = this.unwrap(value, 'sqrt.value');
    const info = parseShaderIrDataType(input.type.dataType, this.moduleId, `${this.entryId}.sqrt`);
    if (input.type.semantic !== 'value' || info.scalarType !== 'f32' || (info.kind !== 'scalar' && info.kind !== 'vector')) {
      throwShaderIrTypeError(this.moduleId, `${this.entryId}.sqrt`, 'generic f32 scalar/vector', shaderIrValueTypeKey(input.type));
    }
    return this.createNode('sqrt', input.type, [input], {}, input.allowedStages, source);
  }

  mix(
    left: ShaderIrValue,
    right: ShaderIrValue,
    factor: ShaderIrValue,
    source?: ShaderIrSource,
  ): ShaderIrValue {
    const a = this.unwrap(left, 'mix.left');
    const b = this.unwrap(right, 'mix.right');
    const t = this.unwrap(factor, 'mix.factor');
    assertSameShaderIrType(a.type, b.type, this.moduleId, `${this.entryId}.mix`);
    const info = parseShaderIrDataType(a.type.dataType, this.moduleId, `${this.entryId}.mix`);
    if (info.scalarType !== 'f32' || (info.kind !== 'scalar' && info.kind !== 'vector')) {
      throwShaderIrTypeError(this.moduleId, 'mix.left', 'f32 scalar/vector', a.type.dataType);
    }
    if (t.type.dataType !== 'f32' || t.type.semantic !== 'value') {
      throwShaderIrTypeError(this.moduleId, 'mix.factor', 'f32|value', shaderIrValueTypeKey(t.type));
    }
    return this.createNode('mix', a.type, [a, b, t], {}, intersectOperandStages([a, b, t]), source);
  }

  clamp(
    value: ShaderIrValue,
    low: ShaderIrValue,
    high: ShaderIrValue,
    source?: ShaderIrSource,
  ): ShaderIrValue {
    const input = this.unwrap(value, 'clamp.value');
    const minimum = this.unwrap(low, 'clamp.low');
    const maximum = this.unwrap(high, 'clamp.high');
    assertSameShaderIrType(input.type, minimum.type, this.moduleId, `${this.entryId}.clamp.low`);
    assertSameShaderIrType(input.type, maximum.type, this.moduleId, `${this.entryId}.clamp.high`);
    ensureShaderIrNumeric(input.type, this.moduleId, `${this.entryId}.clamp`);
    return this.createNode('clamp', input.type, [input, minimum, maximum], {}, intersectOperandStages([input, minimum, maximum]), source);
  }

  sin(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    const input = this.unwrap(value, 'sin.value');
    const info = parseShaderIrDataType(input.type.dataType, this.moduleId, `${this.entryId}.sin`);
    if (input.type.semantic !== 'value' || info.scalarType !== 'f32' || (info.kind !== 'scalar' && info.kind !== 'vector')) {
      throwShaderIrTypeError(this.moduleId, 'sin.value', 'generic f32 scalar/vector', shaderIrValueTypeKey(input.type));
    }
    return this.createNode('sin', input.type, [input], {}, input.allowedStages, source);
  }

  swizzle(value: ShaderIrValue, pattern: string, source?: ShaderIrSource): ShaderIrValue {
    const input = this.unwrap(value, 'swizzle.value');
    const info = parseShaderIrDataType(input.type.dataType, this.moduleId, `${this.entryId}.swizzle`);
    if (info.kind !== 'vector' || !/^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(pattern)) {
      throwShaderIrTypeError(this.moduleId, 'swizzle.pattern', 'valid vector swizzle', `${input.type.dataType}.${pattern}`);
    }
    const indexes = [...pattern].map(component => 'xyzw'.includes(component)
      ? 'xyzw'.indexOf(component)
      : 'rgba'.indexOf(component));
    if (indexes.some(index => index >= info.width)) {
      throwShaderIrTypeError(this.moduleId, 'swizzle.pattern', `components within ${input.type.dataType}`, pattern);
    }
    const dataType = pattern.length === 1
      ? info.scalarType
      : `vec${pattern.length}<${info.scalarType}>` as ShaderIrDataType;
    const type = preservedShaderIrSwizzleType(input.type, dataType);
    return this.createNode('swizzle', type, [input], { pattern }, input.allowedStages, source);
  }

  textureSample(
    textureId: string,
    samplerId: string,
    uv: ShaderIrValue,
    options: ShaderIrTextureSampleOptions = {},
  ): ShaderIrValue {
    const texture = this.resources.get(textureId);
    const sampler = this.resources.get(samplerId);
    if (!texture || texture.kind !== 'texture' || texture.valueType !== 'texture_2d<f32>') {
      throwShaderIrResourceError(this.moduleId, `${this.entryId}.resources.${textureId}`, `Stage 2 sampling requires texture_2d<f32> resource ${textureId}.`);
    }
    if (!sampler || sampler.kind !== 'sampler' || sampler.valueType !== 'sampler') {
      throwShaderIrResourceError(this.moduleId, `${this.entryId}.resources.${samplerId}`, `Stage 2 sampling requires filtering sampler ${samplerId}.`);
    }
    const coordinates = this.unwrap(uv, 'textureSample.uv');
    if (coordinates.type.dataType !== 'vec2<f32>' || coordinates.type.semantic !== 'uv') {
      throwShaderIrTypeError(this.moduleId, 'textureSample.uv', 'vec2<f32>|uv with explicit space', shaderIrValueTypeKey(coordinates.type));
    }
    const level = options.level === undefined ? null : this.unwrap(options.level, 'textureSample.level');
    if (level && (level.type.dataType !== 'f32' || level.type.semantic !== 'value')) {
      throwShaderIrTypeError(this.moduleId, 'textureSample.level', 'f32|value', shaderIrValueTypeKey(level.type));
    }
    const output = texture.colorSpace === 'linear' || texture.colorSpace === 'srgb'
      ? normalizeShaderIrValueType({ dataType: 'vec4<f32>', semantic: 'color', colorSpace: texture.colorSpace }, this.moduleId, `${this.entryId}.textureSample.output`)
      : genericShaderIrType('vec4<f32>');
    const operands = level ? [coordinates, level] : [coordinates];
    const intrinsicStages: readonly ShaderStage[] = level ? SHADER_STAGES : ['fragment'];
    return this.createNode(
      level ? 'texture-sample-level' : 'texture-sample',
      output,
      operands,
      { textureId, samplerId },
      intersectStages([intrinsicStages, texture.visibility, sampler.visibility, ...operands.map(item => item.allowedStages)]),
      options.source,
    );
  }

  derivativeX(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    return this.derivative('derivative-x', value, source);
  }

  derivativeY(value: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    return this.derivative('derivative-y', value, source);
  }

  transformPosition(
    matrix: ShaderIrValue,
    position: ShaderIrValue,
    toSpace: ShaderCoordinateSpace | undefined,
    source?: ShaderIrSource,
  ): ShaderIrValue {
    const transform = this.unwrap(matrix, 'transformPosition.matrix');
    const input = this.unwrap(position, 'transformPosition.position');
    requireShaderIrSemantic(input.type, 'position', this.moduleId, `${this.entryId}.transformPosition.position`);
    const target = requireShaderIrTargetSpace(input.type, toSpace, this.moduleId, `${this.entryId}.transformPosition.toSpace`);
    requireShaderIrTransform(transform.type, ['mat4x4<f32>'], input.type.coordinateSpace!, target, this.moduleId, `${this.entryId}.transformPosition.matrix`);
    const dataType = target === 'clip' ? 'vec4<f32>' : 'vec3<f32>';
    const type = normalizeShaderIrValueType({ dataType, semantic: 'position', coordinateSpace: target }, this.moduleId, `${this.entryId}.transformPosition.output`);
    return this.createNode('transform-position', type, [transform, input], { toSpace: target }, intersectOperandStages([transform, input]), source);
  }

  transformDirection(
    matrix: ShaderIrValue,
    direction: ShaderIrValue,
    toSpace: ShaderCoordinateSpace | undefined,
    source?: ShaderIrSource,
  ): ShaderIrValue {
    return this.transformVector('transform-direction', matrix, direction, 'direction', ['mat3x3<f32>', 'mat4x4<f32>'], toSpace, source);
  }

  transformNormal(
    matrix: ShaderIrValue,
    normal: ShaderIrValue,
    toSpace: ShaderCoordinateSpace | undefined,
    source?: ShaderIrSource,
  ): ShaderIrValue {
    return this.transformVector('transform-normal', matrix, normal, 'normal', ['mat3x3<f32>'], toSpace, source);
  }

  srgbToLinear(color: ShaderIrValue, source?: ShaderIrSource): ShaderIrValue {
    const input = this.unwrap(color, 'srgbToLinear.color');
    if (input.type.semantic !== 'color' || input.type.colorSpace !== 'srgb') {
      shaderError('E_SHADER_SEMANTIC_MISMATCH', `sRGB decode requires an srgb color, got ${shaderIrValueTypeKey(input.type)}.`, {
        moduleId: this.moduleId,
        path: `${this.entryId}.srgbToLinear.color`,
      });
    }
    const type = normalizeShaderIrValueType({
      dataType: input.type.dataType,
      semantic: 'color',
      colorSpace: 'linear',
    }, this.moduleId, `${this.entryId}.srgbToLinear.output`);
    return this.createNode('srgb-to-linear', type, [input], {}, input.allowedStages, source);
  }

  private addOrSubtract(
    operation: 'add' | 'subtract',
    left: ShaderIrValue,
    right: ShaderIrValue,
    source?: ShaderIrSource,
  ): ShaderIrValue {
    const a = this.unwrap(left, `${operation}.left`);
    const b = this.unwrap(right, `${operation}.right`);
    if (a.type.dataType !== b.type.dataType) {
      throwShaderIrTypeError(this.moduleId, `${this.entryId}.${operation}`, shaderIrValueTypeKey(a.type), shaderIrValueTypeKey(b.type));
    }
    if (a.type.coordinateSpace !== b.type.coordinateSpace) {
      assertSameShaderIrType(a.type, b.type, this.moduleId, `${this.entryId}.${operation}`);
    }
    let output: ShaderIrValueType;
    const sameSpace = a.type.coordinateSpace;
    if (operation === 'add' && a.type.semantic === 'position' && b.type.semantic === 'direction') {
      output = a.type;
    } else if (operation === 'add' && a.type.semantic === 'direction' && b.type.semantic === 'position') {
      output = b.type;
    } else if (operation === 'subtract' && a.type.semantic === 'position' && b.type.semantic === 'position') {
      if (a.type.dataType !== 'vec3<f32>') {
        throwShaderIrTypeError(this.moduleId, `${this.entryId}.${operation}`, 'vec3<f32> positions', a.type.dataType);
      }
      output = normalizeShaderIrValueType({
        dataType: 'vec3<f32>',
        semantic: 'direction',
        coordinateSpace: sameSpace!,
      }, this.moduleId, `${this.entryId}.${operation}.output`);
    } else if (operation === 'subtract' && a.type.semantic === 'position' && b.type.semantic === 'direction') {
      output = a.type;
    } else if (a.type.semantic === 'position' || b.type.semantic === 'position') {
      shaderError('E_SHADER_SEMANTIC_MISMATCH', `${operation} cannot combine ${a.type.semantic} and ${b.type.semantic}.`, {
        moduleId: this.moduleId,
        path: `${this.entryId}.${operation}`,
      });
    } else {
      assertSameShaderIrType(a.type, b.type, this.moduleId, `${this.entryId}.${operation}`);
      output = a.type;
    }
    ensureShaderIrNumeric(output, this.moduleId, `${this.entryId}.${operation}`);
    return this.createNode(operation, output, [a, b], {}, intersectOperandStages([a, b]), source);
  }

  private derivative(
    operation: 'derivative-x' | 'derivative-y',
    value: ShaderIrValue,
    source?: ShaderIrSource,
  ): ShaderIrValue {
    const input = this.unwrap(value, `${operation}.value`);
    const info = parseShaderIrDataType(input.type.dataType, this.moduleId, `${this.entryId}.${operation}`);
    if (info.scalarType !== 'f32' || (info.kind !== 'scalar' && info.kind !== 'vector')) {
      throwShaderIrTypeError(this.moduleId, `${operation}.value`, 'f32 scalar/vector', input.type.dataType);
    }
    return this.createNode(operation, input.type, [input], {}, intersectStages([input.allowedStages, ['fragment']]), source);
  }

  private transformVector(
    operation: 'transform-direction' | 'transform-normal',
    matrix: ShaderIrValue,
    value: ShaderIrValue,
    semantic: 'direction' | 'normal',
    matrixTypes: readonly ShaderIrDataType[],
    toSpace: ShaderCoordinateSpace | undefined,
    source?: ShaderIrSource,
  ): ShaderIrValue {
    const transform = this.unwrap(matrix, `${operation}.matrix`);
    const input = this.unwrap(value, `${operation}.value`);
    requireShaderIrSemantic(input.type, semantic, this.moduleId, `${this.entryId}.${operation}.value`);
    const target = requireShaderIrTargetSpace(input.type, toSpace, this.moduleId, `${this.entryId}.${operation}.toSpace`);
    requireShaderIrTransform(transform.type, matrixTypes, input.type.coordinateSpace!, target, this.moduleId, `${this.entryId}.${operation}.matrix`);
    const type = normalizeShaderIrValueType({
      dataType: 'vec3<f32>',
      semantic,
      coordinateSpace: target,
    }, this.moduleId, `${this.entryId}.${operation}.output`);
    return this.createNode(operation, type, [transform, input], { toSpace: target }, intersectOperandStages([transform, input]), source);
  }

  private createNode(
    operation: ShaderIrNodeOperation,
    type: ShaderIrValueType,
    operands: readonly ShaderIrValueImpl[],
    payload: Readonly<Record<string, ShaderIrPayloadValue>>,
    allowedStages: readonly ShaderStage[],
    source?: ShaderIrSource,
  ): ShaderIrValueImpl {
    const stages = SHADER_STAGES.filter(stage => allowedStages.includes(stage));
    const normalizedSource = normalizeSource(source, this.moduleId, this.entryId, this.nodes.length);
    if (!stages.includes(this.entryStage)) {
      shaderError('E_SHADER_STAGE_VIOLATION', `${operation} is unavailable in ${this.entryStage} stage.`, {
        moduleId: this.moduleId,
        path: normalizedSource.path ?? `${this.entryId}.nodes.${this.nodes.length}`,
        details: { operation, entryStage: this.entryStage, allowedStages: stages },
      });
    }
    const node = Object.freeze({
      id: this.nodes.length,
      operation,
      type,
      allowedStages: Object.freeze(stages),
      operands: Object.freeze(operands.map(operand => operand.nodeId)),
      payload: Object.freeze(Object.fromEntries(Object.entries(payload).map(([key, value]) => [
        key,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ]))),
      source: normalizedSource,
    });
    this.nodes.push(node);
    return new ShaderIrValueImpl(this, node);
  }

  private unwrap(value: ShaderIrValue, path: string): ShaderIrValueImpl {
    if (!(value instanceof ShaderIrValueImpl) || value.owner !== this) {
      shaderError('E_SHADER_IR_INVALID', 'Shader IR values cannot cross builder/entry ownership boundaries.', {
        moduleId: this.moduleId,
        path: `${this.entryId}.${path}`,
      });
    }
    return value;
  }
}

function normalizeSource(
  source: ShaderIrSource | undefined,
  moduleId: string,
  entryId: string,
  nodeId: number,
): ShaderIrSource {
  const value = source ?? { sourceId: moduleId, path: `${entryId}.nodes.${nodeId}` };
  if (!value.sourceId?.trim()) {
    shaderError('E_SHADER_IR_INVALID', 'IR sourceId must not be empty.', { moduleId, path: `${entryId}.nodes.${nodeId}.source` });
  }
  if (value.sourceName !== undefined && (!value.sourceName.trim() || /[\r\n]/.test(value.sourceName))) {
    shaderError('E_SHADER_IR_INVALID', 'IR sourceName must be a non-empty single line.', { moduleId, path: `${entryId}.nodes.${nodeId}.sourceName` });
  }
  if (value.line !== undefined && (!Number.isInteger(value.line) || value.line < 1)) {
    shaderError('E_SHADER_IR_INVALID', 'IR source line must be a positive integer.', { moduleId, path: `${entryId}.nodes.${nodeId}.line` });
  }
  if (value.column !== undefined && (!Number.isInteger(value.column) || value.column < 1)) {
    shaderError('E_SHADER_IR_INVALID', 'IR source column must be a positive integer.', { moduleId, path: `${entryId}.nodes.${nodeId}.column` });
  }
  return Object.freeze({ ...value });
}

function intersectOperandStages(operands: readonly ShaderIrValueImpl[]): readonly ShaderStage[] {
  return intersectStages(operands.map(operand => operand.allowedStages));
}

function intersectStages(groups: readonly (readonly ShaderStage[])[]): readonly ShaderStage[] {
  return SHADER_STAGES.filter(stage => groups.every(group => group.includes(stage)));
}

export function assertShaderIrIdentifier(value: string, moduleId: string, path: string): void {
  if (!IDENTIFIER.test(value) || value.startsWith('hy_')) {
    shaderError('E_SHADER_IR_INVALID', `Invalid or reserved shader IR identifier ${value}.`, { moduleId, path });
  }
}
