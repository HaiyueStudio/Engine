import { GuiShapeCommand } from './GuiDrawCommand';
import { GUI_SHAPE_VERTEX_LAYOUT } from './GuiVertexLayout';

const VERTICES_PER_QUAD = 6;
export const GUI_SHAPE_FLOATS_PER_VERTEX = GUI_SHAPE_VERTEX_LAYOUT.floatsPerVertex;

export class GuiBatch {
  readonly commands: GuiShapeCommand[] = [];
  vertexData = new Float32Array(0);
  vertexCount = 0;
  version = 0;
  dirty = true;

  clear(options: { releaseVertexData?: boolean } = {}): void {
    this.commands.length = 0;
    this.vertexCount = 0;
    if (options.releaseVertexData) {
      this.vertexData = new Float32Array(0);
      this.version++;
    }
    this.dirty = true;
  }

  addShape(command: GuiShapeCommand): void {
    if (command.width <= 0 || command.height <= 0 || command.color[3] <= 0) return;
    this.commands.push(command);
    this.dirty = true;
  }

  rebuild(): void {
    const vertexCount = this.commands.length * VERTICES_PER_QUAD;
    const requiredFloats = vertexCount * GUI_SHAPE_VERTEX_LAYOUT.floatsPerVertex;
    if (this.vertexData.length < requiredFloats) {
      this.vertexData = new Float32Array(nextCapacity(requiredFloats));
    }
    const data = this.vertexData;
    let offset = 0;

    for (const command of this.commands) {
      const x0 = command.x;
      const y0 = command.y;
      const x1 = command.x + command.width;
      const y1 = command.y + command.height;
      const clip = command.clip ?? {
        x: -1e9,
        y: -1e9,
        width: 2e9,
        height: 2e9,
      };
      const clipX0 = clip.x;
      const clipY0 = clip.y;
      const clipX1 = clip.x + clip.width;
      const clipY1 = clip.y + clip.height;
      offset = writeVertex(data, offset, x0, y0, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x1, y0, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x0, y1, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x1, y0, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x1, y1, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x0, y1, command, clipX0, clipY0, clipX1, clipY1);
    }

    this.vertexCount = vertexCount;
    this.version++;
    this.dirty = false;
  }
}

function nextCapacity(required: number): number {
  let capacity = 1024;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function writeVertex(
  data: Float32Array,
  offset: number,
  x: number,
  y: number,
  command: GuiShapeCommand,
  clipX0: number,
  clipY0: number,
  clipX1: number,
  clipY1: number,
): number {
  const base = offset;
  const fields = GUI_SHAPE_VERTEX_LAYOUT.floatOffsets;
  data[base + fields.position] = x;
  data[base + fields.position + 1] = y;
  data.set(command.color, base + fields.color);
  data[base + fields.rect] = command.x;
  data[base + fields.rect + 1] = command.y;
  data[base + fields.rect + 2] = command.width;
  data[base + fields.rect + 3] = command.height;
  data[base + fields.radius] = Math.max(0, Math.min(command.radius, Math.min(command.width, command.height) * 0.5));
  data[base + fields.clip] = clipX0;
  data[base + fields.clip + 1] = clipY0;
  data[base + fields.clip + 2] = clipX1;
  data[base + fields.clip + 3] = clipY1;
  return base + GUI_SHAPE_VERTEX_LAYOUT.floatsPerVertex;
}
