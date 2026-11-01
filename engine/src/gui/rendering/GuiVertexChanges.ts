interface Range {offset:number;size:number;}
interface Delta {base:number;version:number;ranges:readonly Range[];}
interface Work {commands:number;layouts:number;vertices:number;}
const deltas=new WeakMap<object,Delta>(),work=new WeakMap<object,Work>();

/** Private batch-owned edits in bytes. Bound driver calls, even for scattered glyphs. */
export class GuiVertexChanges {
  readonly ranges:Range[]=[];
  private envelope=false;
  add(offset:number,size:number):void {
    if(!size)return;
    const last=this.ranges.at(-1);
    if(last&&(this.envelope||offset<=last.offset+last.size))last.size=Math.max(last.offset+last.size,offset+size)-last.offset;
    else this.ranges.push({offset,size});
    if(this.ranges.length>32){const first=this.ranges[0]!;first.size=this.ranges.at(-1)!.offset+this.ranges.at(-1)!.size-first.offset;this.ranges.length=1;this.envelope=true;}
  }
  commit(batch:object,base:number,version:number,diagnostic:Work):void {
    work.set(batch,diagnostic);
    if(version!==base)deltas.set(batch,{base,version,ranges:this.ranges});
  }
}
export function guiVertexChanges(batch:object,base:unknown,version:unknown):readonly Range[]|undefined {
  const delta=deltas.get(batch);return delta&&delta.base===base&&delta.version===version?delta.ranges:undefined;
}
/** Structural work counters only; never used to select a rendering path. */
export function guiGeometryWork(batch:object):Readonly<Work>|undefined {return work.get(batch);}
export function forgetGuiVertexChanges(batch:object):void {deltas.delete(batch);work.delete(batch);}
