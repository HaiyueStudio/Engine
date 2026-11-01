import{EngineError,EngineErrorCode}from'@haiyue/engine/core';
import type{SampleableTextureSource}from'@haiyue/engine/material';
import type{Tilemap2DComponent}from'./Tilemap2DComponent';

export interface TilemapAtlasOptions {
  readonly source:SampleableTextureSource;readonly sourceWidth:number;readonly sourceHeight:number;
  readonly tileWidth:number;readonly tileHeight:number;readonly margin?:number;readonly spacing?:number;
}
export type TilemapCellTransform='none'|'flip-x'|'flip-y'|'rotate-90'|'rotate-180'|'rotate-270';
export const cellTransforms:readonly TilemapCellTransform[]=['none','flip-x','flip-y','rotate-90','rotate-180','rotate-270'];
export const MAX_MAP_CELLS=1048576;
export const tilemapInvalid=(message:string)=>new EngineError(EngineErrorCode.AssetInvalidData,message,{docsPath:'errors/E_ASSET_INVALID_DATA'});
export interface TilemapState {
  atlas:Readonly<TilemapAtlasOptions>|null;chunkSize:number;maxResident:number;explicitChunks:boolean;
  fullRevision:number;clock:number;dirty:Map<number,number>;transforms:Map<number,TilemapCellTransform>;
}
const states=new WeakMap<Tilemap2DComponent,TilemapState>();
export function tilemapState(map:Tilemap2DComponent):TilemapState {return states.get(map)!;}
export function initializeTilemap(map:Tilemap2DComponent,state:TilemapState):void {states.set(map,state);}
export function validateMapSize(columns:number,rows:number,cells:ArrayLike<number>,admitted:boolean):void {
  if(admitted&&(!Number.isSafeInteger(columns)||columns<1||!Number.isSafeInteger(rows)||rows<1||columns*rows>MAX_MAP_CELLS||cells.length>MAX_MAP_CELLS))throw tilemapInvalid('Atlas/chunk maps are limited to 1,048,576 CPU cells.');
}
export function checkedAtlas(value:TilemapAtlasOptions|null):Readonly<TilemapAtlasOptions>|null {
  if(value===null)return null;
  if(!value||typeof value!=='object')throw tilemapInvalid('Invalid atlas descriptor.');
  const {source,sourceWidth:w,sourceHeight:h,tileWidth:tw,tileHeight:th}=value,margin=value.margin??0,spacing=value.spacing??0;
  if(!source||typeof source.texture?.createView!=='function'||![w,h,tw,th,margin,spacing].every(Number.isSafeInteger)||w<1||h<1||w>4096||h>4096||tw<1||th<1||margin<0||spacing<0||tw+2*margin>w||th+2*margin>h)throw tilemapInvalid('Invalid single-texture atlas dimensions, margin or spacing.');
  return Object.freeze({source,sourceWidth:w,sourceHeight:h,tileWidth:tw,tileHeight:th,margin,spacing});
}
export function atlasColumns(atlas:TilemapAtlasOptions):number {return Math.floor((atlas.sourceWidth-2*(atlas.margin??0)+(atlas.spacing??0))/(atlas.tileWidth+(atlas.spacing??0)));}
export function atlasCount(atlas:TilemapAtlasOptions):number {return atlasColumns(atlas)*Math.floor((atlas.sourceHeight-2*(atlas.margin??0)+(atlas.spacing??0))/(atlas.tileHeight+(atlas.spacing??0)));}
export function validateAtlasCell(value:number,atlas:TilemapAtlasOptions|null):void {
  if(atlas&&(!Number.isSafeInteger(value)||value<0||value>32767||value>atlasCount(atlas)))throw tilemapInvalid('Atlas cells are 0 (empty) or valid 1-based Int16 tile indices.');
}
export function validateAtlasCells(cells:ArrayLike<number>,atlas:TilemapAtlasOptions|null):void {if(atlas)for(let i=0;i<cells.length;i++)validateAtlasCell(cells[i]!,atlas);}
export function invalidateTilemap(map:Tilemap2DComponent):void {const state=tilemapState(map);if(state){state.fullRevision=++state.clock;state.dirty.clear();}}
export function dirtyTile(map:Tilemap2DComponent,column:number,row:number):void {
  const s=tilemapState(map),columns=Math.ceil(map.columns/s.chunkSize),key=Math.floor(row/s.chunkSize)*columns+Math.floor(column/s.chunkSize);s.dirty.set(key,++s.clock);
}
