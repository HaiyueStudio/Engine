import { snapshotGuiCommand } from './GuiCommandCache';
import { GuiShapeCommand } from './GuiDrawCommand';
import { GUI_SHAPE_VERTEX_LAYOUT } from './GuiVertexLayout';
import {GuiVertexChanges,forgetGuiVertexChanges} from './GuiVertexChanges';

const VERTICES_PER_QUAD = 6;
export const GUI_SHAPE_FLOATS_PER_VERTEX = /* @__PURE__ */ (() => GUI_SHAPE_VERTEX_LAYOUT.floatsPerVertex)();

export class GuiBatch {
  readonly commands: GuiShapeCommand[] = [];
  readonly commandRanges: {first: number; count: number}[] = [];
  vertexData = new Float32Array(0);
  vertexCount = 0;
  version = 0;
  dirty = true;
  private retained: GuiShapeCommand[] = [];
  private retainedVertexCount = 0;
  private forceUpload=false;

  clear(options: { releaseVertexData?: boolean } = {}): void {
    this.commands.length = 0;
    this.commandRanges.length = 0;
    this.vertexCount = 0;
    if (options.releaseVertexData) {
      this.vertexData = new Float32Array(0);
      this.retained = [];
      this.retainedVertexCount = 0;
      this.version++;
      forgetGuiVertexChanges(this);
    }
    this.dirty = true;
  }

  addShape(command: GuiShapeCommand): void {
    if (command.width <= 0 || command.height <= 0 || command.color[3] <= 0) return;
    this.commands.push(command);
    this.dirty = true;
  }

  rebuild(): void {
    try{this.rebuildGeometry();}catch(error){this.retained=[];this.forceUpload=true;this.dirty=true;forgetGuiVertexChanges(this);throw error;}
  }
  private rebuildGeometry():void {
    const base=this.version,changes=new GuiVertexChanges();let rebuilt=0;
    this.commandRanges.length = 0;
    let vertices = 0;
    for (const command of this.commands) {
      const count = shapeVertices(command);
      this.commandRanges.push({first: vertices, count}); vertices += count;
    }
    const vertexCount = vertices;
    const requiredFloats = vertexCount * GUI_SHAPE_VERTEX_LAYOUT.floatsPerVertex;
    if (this.vertexData.length < requiredFloats) {
      const data=new Float32Array(nextCapacity(requiredFloats));data.set(this.vertexData);this.vertexData=data;
    }
    if(this.forceUpload)changes.add(0,requiredFloats*4);
    let oldFirst=0,changed=this.forceUpload||vertexCount!==this.retainedVertexCount;
    for(let i=0;i<this.commands.length;i++){
      const command=this.commands[i]!,previous=this.retained[i],range=this.commandRanges[i]!;
      const oldCount=previous?shapeVertices(previous):0;
      if(oldFirst!==range.first||!sameShape(previous,command)){
        packShape(this.vertexData,range.first*GUI_SHAPE_FLOATS_PER_VERTEX,command);
        changes.add(range.first*GUI_SHAPE_FLOATS_PER_VERTEX*4,range.count*GUI_SHAPE_FLOATS_PER_VERTEX*4);
        rebuilt+=range.count;changed=true;this.retained[i]=snapshotGuiCommand(command);
      }
      oldFirst+=oldCount;
    }
    this.retained.length=this.commands.length;
    this.retainedVertexCount = this.vertexCount = vertexCount;
    if(changed)this.version++;
    this.forceUpload=false;
    changes.commit(this,base,this.version,{commands:this.commands.length,layouts:0,vertices:rebuilt});
    this.dirty = false;
  }
}

function shapeVertices(command:GuiShapeCommand):number {return command.strokeWidth?36*6:command.roundedMesh?36*3:VERTICES_PER_QUAD;}
function sameShape(a:GuiShapeCommand|undefined,b:GuiShapeCommand):boolean {
  return !!a&&a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height&&a.radius===b.radius&&a.strokeWidth===b.strokeWidth&&a.roundedMesh===b.roundedMesh&&a.color.every((v,i)=>v===b.color[i])&&
    (a.clip===b.clip||!!(a.clip&&b.clip&&a.clip.x===b.clip.x&&a.clip.y===b.clip.y&&a.clip.width===b.clip.width&&a.clip.height===b.clip.height));
}
function packShape(data:Float32Array,offset:number,command:GuiShapeCommand):number {
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
      if (command.strokeWidth) {
        const outer = outlinePoints(command, 0), inner = outlinePoints(command, command.strokeWidth);
        for (let i = 0; i < outer.length; i++) {
          const j = (i + 1) % outer.length;
          for (const point of [outer[i]!, outer[j]!, inner[i]!, outer[j]!, inner[j]!, inner[i]!])
            offset = writeVertex(data, offset, point[0], point[1], command, clipX0, clipY0, clipX1, clipY1);
        }
        return offset;
      }
      if (command.roundedMesh) {
        const edge = outlinePoints(command, 0);
        for (let i = 0; i < edge.length; i++) {
          for (const [x, y] of [[(x0 + x1) / 2, (y0 + y1) / 2], edge[i]!, edge[(i + 1) % edge.length]!])
            offset = writeVertex(data, offset, x!, y!, command, clipX0, clipY0, clipX1, clipY1);
        }
        return offset;
      }
      offset = writeVertex(data, offset, x0, y0, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x1, y0, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x0, y1, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x1, y0, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x1, y1, command, clipX0, clipY0, clipX1, clipY1);
      offset = writeVertex(data, offset, x0, y1, command, clipX0, clipY0, clipX1, clipY1);
    return offset;
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

function outlinePoints(c: GuiShapeCommand, inset: number): [number, number][] {
  const d = Math.min(inset, c.width / 2, c.height / 2);
  const x = c.x + d, y = c.y + d, w = c.width - d * 2, h = c.height - d * 2;
  const r = Math.max(0, Math.min(c.radius - d, w / 2, h / 2));
  const points: [number, number][] = [];
  const centers = [[x+w-r,y+r],[x+w-r,y+h-r],[x+r,y+h-r],[x+r,y+r]];
  centers.forEach(([cx,cy], corner) => {
    for (let n=0;n<=8;n++) { const a=(corner-1)*Math.PI/2+n*Math.PI/16;
      points.push([cx!+Math.cos(a)*r,cy!+Math.sin(a)*r]); }
  });
  return points;
}
