import type{Tilemap2DComponent}from'./Tilemap2DComponent';
import{atlasColumns,tilemapState,MAX_MAP_CELLS,validateAtlasCell,type TilemapCellTransform}from'./TilemapState';
export interface TileChunk {key:number;x0:number;y0:number;x1:number;y1:number;}
export function tileChunks(map:Tilemap2DComponent,view:Float32Array,world:Float32Array):{chunks:TileChunk[];culled:boolean;legacy:boolean} {
  const state=tilemapState(map),legacy=map.columns*map.rows>MAX_MAP_CELLS&&!state.atlas&&!state.explicitChunks;
  if(legacy)return {chunks:[{key:0,x0:0,y0:0,x1:map.columns,y1:map.rows}],culled:false,legacy:true};
  let x0=0,y0=0,x1=map.columns,y1=map.rows,culled=false;
  const product=(column:number,row:number)=>view[row]!*world[column*4]!+view[row+4]!*world[column*4+1]!+view[row+8]!*world[column*4+2]!+view[row+12]!*world[column*4+3]!;
  const sx=product(0,0),sy=product(1,1),tx=product(3,0),ty=product(3,1),w=product(3,3);
  if([...view,...world].every(v=>Number.isFinite(v)&&Math.abs(v)<=1048576)&&product(0,1)===0&&product(1,0)===0&&product(0,3)===0&&product(1,3)===0&&sx!==0&&sy!==0&&w!==0&&map.cellWidth>0&&map.cellHeight>0){
    const ax=(-w-tx)/sx,bx=(w-tx)/sx,ay=(-w-ty)/sy,by=(w-ty)/sy;
    if([ax,bx,ay,by,map.originX,map.originY].every(v=>Number.isFinite(v)&&Math.abs(v)<=1048576)){
      x0=Math.max(0,Math.floor((Math.min(ax,bx)-map.originX)/map.cellWidth)-1);x1=Math.min(map.columns,Math.ceil((Math.max(ax,bx)-map.originX)/map.cellWidth)+1);
      y0=Math.max(0,Math.floor((Math.min(ay,by)-map.originY)/map.cellHeight)-1);y1=Math.min(map.rows,Math.ceil((Math.max(ay,by)-map.originY)/map.cellHeight)+1);culled=true;
    }
  }
  const chunks:TileChunk[]=[],size=state.chunkSize,columns=Math.ceil(map.columns/size);
  if(x1<=x0||y1<=y0)return {chunks,culled,legacy:false};
  for(let y=Math.floor(y0/size);y<Math.ceil(y1/size);y++)for(let x=Math.floor(x0/size);x<Math.ceil(x1/size);x++)chunks.push({key:y*columns+x,x0:x*size,y0:y*size,x1:Math.min(map.columns,(x+1)*size),y1:Math.min(map.rows,(y+1)*size)});
  return {chunks,culled,legacy:false};
}
export function transformedUv(u:number,v:number,transform:TilemapCellTransform):readonly[number,number] {
  switch(transform){case'flip-x':return[1-u,v];case'flip-y':return[u,1-v];case'rotate-90':return[v,1-u];case'rotate-180':return[1-u,1-v];case'rotate-270':return[1-v,u];default:return[u,v];}
}
const corners:readonly(readonly[number,number])[]=[[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]];
/** Same absolute positions and triangle order as the original full palette renderer. */
export function buildTileVertices(map:Tilemap2DComponent,chunks:readonly TileChunk[],storage?:Float32Array):{data:Float32Array;count:number;cells:number} {
  const state=tilemapState(map),atlas=state.atlas,stride=atlas?8:6;
  let cells=0;for(const chunk of chunks)for(let y=chunk.y0;y<chunk.y1;y++)for(let x=chunk.x0;x<chunk.x1;x++)if(map.getCell(x,y)>0)cells++;
  const floats=cells*6*stride,data=storage&&storage.length>=floats?storage:new Float32Array(floats);let offset=0;
  for(const chunk of chunks)for(let row=chunk.y0;row<chunk.y1;row++)for(let column=chunk.x0;column<chunk.x1;column++){
    const value=map.getCell(column,row);validateAtlasCell(value,atlas);if(value<=0)continue;
    const x0=map.originX+column*map.cellWidth+map.gap*.5,y0=map.originY+row*map.cellHeight+map.gap*.5,width=Math.max(0,map.cellWidth-map.gap),height=Math.max(0,map.cellHeight-map.gap);
    const color=map.palette[value]??map.palette[1]??[1,1,1,1];
    let u0=0,v0=0,u1=1,v1=1;
    if(atlas){const cols=atlasColumns(atlas),x=(value-1)%cols,y=Math.floor((value-1)/cols),margin=atlas.margin??0,spacing=atlas.spacing??0;
      // The nearest-sampled domain runs from the first to the last texel centre.
      u0=(margin+x*(atlas.tileWidth+spacing)+.5)/atlas.sourceWidth;u1=(margin+x*(atlas.tileWidth+spacing)+atlas.tileWidth-.5)/atlas.sourceWidth;
      v0=(margin+y*(atlas.tileHeight+spacing)+.5)/atlas.sourceHeight;v1=(margin+y*(atlas.tileHeight+spacing)+atlas.tileHeight-.5)/atlas.sourceHeight;
    }
    for(const [x,y]of corners){data[offset++]=x0+x*width;data[offset++]=y0+y*height;
      if(atlas){const uv=transformedUv(x,y,state.transforms.get(map.index(column,row))??'none');data[offset++]=u0+uv[0]*(u1-u0);data[offset++]=v0+uv[1]*(v1-v0);for(let i=0;i<4;i++)data[offset++]=1;}
      else {data[offset++]=color[0]??1;data[offset++]=color[1]??1;data[offset++]=color[2]??1;data[offset++]=color[3]??1;}
    }
  }
  return {data,count:cells*6,cells};
}
