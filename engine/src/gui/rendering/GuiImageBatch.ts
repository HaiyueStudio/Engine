import type { GuiImageSource } from '../components/GuiImage';
import { GUI_TEXTURED_VERTEX_LAYOUT } from './GuiVertexLayout';

const VERTICES_PER_IMAGE = 6;
export const GUI_IMAGE_FLOATS_PER_VERTEX = GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;

export interface GuiImageCommand {
  source: GuiImageSource;
  x: number;
  y: number;
  width: number;
  height: number;
  uv: [number, number, number, number];
  color: [number, number, number, number];
  clip?: { x: number; y: number; width: number; height: number };
}

export interface GuiImageGroup {
  source: NonNullable<GuiImageSource>;
  vertexData: Float32Array;
  vertexCount: number;
  version: number;
}

export class GuiImageBatch {
  readonly commands: GuiImageCommand[] = [];
  readonly groups: GuiImageGroup[] = [];
  private version = 0;
  private readonly cachedGroups = new Map<NonNullable<GuiImageSource>, { group: GuiImageGroup; scratch: Float32Array }>();
  dirty = true;

  clear(): void {
    this.commands.length = 0;
    this.groups.length = 0;
    this.dirty = true;
  }

  addImage(command: GuiImageCommand): void {
    if (!command.source || command.width <= 0 || command.height <= 0 || command.color[3] <= 0) return;
    this.commands.push(command);
    this.dirty = true;
  }

  rebuild(): void {
    const grouped = new Map<NonNullable<GuiImageSource>, GuiImageCommand[]>();
    for (const command of this.commands) {
      if (!command.source) continue;
      let commands = grouped.get(command.source);
      if (!commands) {
        commands = [];
        grouped.set(command.source, commands);
      }
      commands.push(command);
    }
    this.groups.length = 0;
    this.version++;
    for (const source of this.cachedGroups.keys()) {
      if (!grouped.has(source)) this.cachedGroups.delete(source);
    }
    for (const [source, commands] of grouped) {
      const vertexCount = commands.length * VERTICES_PER_IMAGE;
      const floatCount = vertexCount * GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
      let cached = this.cachedGroups.get(source);
      if (!cached || cached.scratch.length < floatCount) {
        cached = {
          group: { source, vertexData: new Float32Array(floatCount), vertexCount: 0, version: -1 },
          scratch: new Float32Array(floatCount),
        };
        this.cachedGroups.set(source, cached);
      }
      const vertexData = cached.scratch;
      let offset = 0;
      for (const command of commands) offset = appendImage(vertexData, offset, command);
      const group = cached.group;
      let changed = group.vertexCount !== vertexCount;
      for (let i = 0; !changed && i < floatCount; i++) changed = group.vertexData[i] !== vertexData[i];
      if (changed) {
        cached.scratch = group.vertexData;
        group.vertexData = vertexData;
        group.vertexCount = vertexCount;
        group.version = this.version;
      }
      this.groups.push(group);
    }
    this.dirty = false;
  }
}

function appendImage(data: Float32Array, offset: number, command: GuiImageCommand): number {
  const x0 = command.x;
  const y0 = command.y;
  const x1 = command.x + command.width;
  const y1 = command.y + command.height;
  const [u, v, w, h] = command.uv;
  const u0 = u;
  const v0 = v;
  const u1 = u + w;
  const v1 = v + h;
  const clip = command.clip ?? { x: command.x, y: command.y, width: command.width, height: command.height };
  const clipX0 = clip.x;
  const clipY0 = clip.y;
  const clipX1 = clip.x + clip.width;
  const clipY1 = clip.y + clip.height;
  offset = writeVertex(data, offset, x0, y0, u0, v0, command.color, clipX0, clipY0, clipX1, clipY1);
  offset = writeVertex(data, offset, x1, y0, u1, v0, command.color, clipX0, clipY0, clipX1, clipY1);
  offset = writeVertex(data, offset, x0, y1, u0, v1, command.color, clipX0, clipY0, clipX1, clipY1);
  offset = writeVertex(data, offset, x1, y0, u1, v0, command.color, clipX0, clipY0, clipX1, clipY1);
  offset = writeVertex(data, offset, x1, y1, u1, v1, command.color, clipX0, clipY0, clipX1, clipY1);
  offset = writeVertex(data, offset, x0, y1, u0, v1, command.color, clipX0, clipY0, clipX1, clipY1);
  return offset;
}

function writeVertex(
  data: Float32Array,
  offset: number,
  x: number,
  y: number,
  u: number,
  v: number,
  color: [number, number, number, number],
  clipX0: number,
  clipY0: number,
  clipX1: number,
  clipY1: number,
): number {
  const base = offset;
  const fields = GUI_TEXTURED_VERTEX_LAYOUT.floatOffsets;
  data[base + fields.position] = x;
  data[base + fields.position + 1] = y;
  data[base + fields.uv] = u;
  data[base + fields.uv + 1] = v;
  data.set(color, base + fields.color);
  data[base + fields.clip] = clipX0;
  data[base + fields.clip + 1] = clipY0;
  data[base + fields.clip + 2] = clipX1;
  data[base + fields.clip + 3] = clipY1;
  return base + GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
}
