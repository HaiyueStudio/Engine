export type GuiVertexFieldFormat = 'float32' | 'float32x2' | 'float32x4';

export interface GuiVertexField<Name extends string> {
  readonly name: Name;
  readonly shaderLocation: number;
  readonly format: GuiVertexFieldFormat;
}

export interface GuiVertexLayout<Name extends string> {
  readonly fields: readonly GuiVertexField<Name>[];
  readonly floatOffsets: Readonly<Record<Name, number>>;
  readonly floatsPerVertex: number;
  readonly gpu: GPUVertexBufferLayout;
}

type ShapeField = 'position' | 'color' | 'rect' | 'radius' | 'clip';
type TexturedField = 'position' | 'uv' | 'color' | 'clip';

export const GUI_SHAPE_VERTEX_LAYOUT = defineGuiVertexLayout<ShapeField>([
  { name: 'position', shaderLocation: 0, format: 'float32x2' },
  { name: 'color', shaderLocation: 1, format: 'float32x4' },
  { name: 'rect', shaderLocation: 2, format: 'float32x4' },
  { name: 'radius', shaderLocation: 3, format: 'float32' },
  { name: 'clip', shaderLocation: 4, format: 'float32x4' },
]);

export const GUI_TEXTURED_VERTEX_LAYOUT = defineGuiVertexLayout<TexturedField>([
  { name: 'position', shaderLocation: 0, format: 'float32x2' },
  { name: 'uv', shaderLocation: 1, format: 'float32x2' },
  { name: 'color', shaderLocation: 2, format: 'float32x4' },
  { name: 'clip', shaderLocation: 3, format: 'float32x4' },
]);

function defineGuiVertexLayout<Name extends string>(fields: readonly GuiVertexField<Name>[]): GuiVertexLayout<Name> {
  const offsets = {} as Record<Name, number>;
  const attributes: GPUVertexAttribute[] = [];
  let floatOffset = 0;
  for (const field of fields) {
    offsets[field.name] = floatOffset;
    attributes.push({
      shaderLocation: field.shaderLocation,
      offset: floatOffset * Float32Array.BYTES_PER_ELEMENT,
      format: field.format,
    });
    floatOffset += componentCount(field.format);
  }
  return Object.freeze({
    fields: Object.freeze([...fields]),
    floatOffsets: Object.freeze(offsets),
    floatsPerVertex: floatOffset,
    gpu: Object.freeze({
      arrayStride: floatOffset * Float32Array.BYTES_PER_ELEMENT,
      attributes: Object.freeze(attributes),
    }),
  });
}

function componentCount(format: GuiVertexFieldFormat): number {
  switch (format) {
    case 'float32': return 1;
    case 'float32x2': return 2;
    case 'float32x4': return 4;
  }
}
