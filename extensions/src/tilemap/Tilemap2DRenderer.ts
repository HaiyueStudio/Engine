import{requireEngineDevice,type IEngine,type RenderCommandContext}from'@haiyue/engine/extension-authoring';
import{EngineError,EngineErrorCode}from'@haiyue/engine/core';
import type{Tilemap2DComponent}from'./Tilemap2DComponent';
import{createCamera2DLayout,createObject2DLayout,matrixEquals,writeFloatBuffer}from'../utils/render2dGpu';
import paletteWgsl from'../shaders/generated/2d-ui-tilemap2d.generated.wgsl';
import texturedWgsl from'../shaders/generated/2d-ui-spine2d.generated.wgsl';
import{tileChunks,buildTileVertices,type TileChunk}from'./TilemapGeometry';
import{tilemapState,tilemapInvalid}from'./TilemapState';
import{TilemapGpuOwner,type TileBuffer}from'./TilemapGpuOwner';
interface SharedGpu {camera:GPUBindGroupLayout;object:GPUBindGroupLayout;material:GPUBindGroupLayout;sampler:GPUSampler;palette:GPUShaderModule;atlas:GPUShaderModule;paletteLayout:GPUPipelineLayout;atlasLayout:GPUPipelineLayout;pipelines:Map<string,GPURenderPipeline>;}
const sharedCache=new WeakMap<GPUDevice,SharedGpu>();
function sharedGpu(device:GPUDevice):SharedGpu {
 let value=sharedCache.get(device);if(value)return value;
 const camera=createCamera2DLayout(device),object=createObject2DLayout(device),material=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}]});
 value={camera,object,material,sampler:device.createSampler({magFilter:'nearest',minFilter:'nearest',mipmapFilter:'nearest',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'}),palette:device.createShaderModule({code:paletteWgsl}),atlas:device.createShaderModule({code:texturedWgsl}),paletteLayout:device.createPipelineLayout({bindGroupLayouts:[camera,object]}),atlasLayout:device.createPipelineLayout({bindGroupLayouts:[camera,object,material]}),pipelines:new Map()};sharedCache.set(device,value);return value;
}
interface Uniform {gpu:TileBuffer;group:GPUBindGroup;snapshot:Float32Array;}
interface VertexSlot {gpu:TileBuffer|null;data:Float32Array;count:number;map:Tilemap2DComponent|null;revision:string;key:number|null;signature:string;}
interface EntityGpu {pool:VertexSlot[];cache:Map<number,VertexSlot>;streams:VertexSlot[];objects:Uniform[];material:{texture:GPUTexture;version:number|undefined;group:GPUBindGroup}|null;}
const unavailable=()=>new EngineError(EngineErrorCode.RenderCommandContextInvalid,'Submit or cancel outstanding Tilemap recordings before exhausting the bounded working pool.');
/** Original 2D ownership and programs, with map revisions independent from bounded GPU windows. */
export class Tilemap2DRenderer {
 reverseZ=false;msaaSamples:1|4=1;colorFormat:GPUTextureFormat|undefined;
 private engine!:IEngine;private device!:GPUDevice;private shared!:SharedGpu;private owner!:TilemapGpuOwner;
 private cameras:Uniform[]=[];private viewProjection=new Float32Array(16);private entityCache=new Map<number,EntityGpu>();private initialized=false;
 private counters={chunkBuilds:0,workingBuilds:0,vertexUploadCalls:0,vertexUploadBytes:0,draws:0,candidateChunks:0,culledRecords:0};
 prepare(engine:IEngine):void {
  const device=requireEngineDevice(engine);if(this.initialized&&this.device===device)return;if(this.initialized)this.destroy();
  this.engine=engine;this.device=device;this.shared=sharedGpu(device);this.owner=new TilemapGpuOwner(engine);this.initialized=true;
 }
 updateCamera(viewProjection:Float32Array):void {this.viewProjection.set(viewProjection);}
 private uniform(pool:Uniform[],matrix:Float32Array,layout:GPUBindGroupLayout,label:string,context:RenderCommandContext):Uniform {
  let value=pool.find(value=>matrixEquals(value.snapshot,matrix));
  if(!value){value=pool.find(value=>!value.gpu.leases.size);
   if(!value){if(pool.length>=32)throw unavailable();const gpu=this.owner.create(64,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label);value={gpu,group:this.device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:gpu.buffer}}]}),snapshot:new Float32Array(16).fill(NaN)};pool.push(value);}
   writeFloatBuffer(this.device.queue,value.gpu.buffer,matrix);value.snapshot.set(matrix);
  }
  this.owner.use(value.gpu,context);return value;
 }
 private slot():VertexSlot {return {gpu:null,data:new Float32Array(0),count:0,map:null,revision:'',key:null,signature:''};}
 private upload(slot:VertexSlot,map:Tilemap2DComponent,chunks:readonly TileChunk[],context:RenderCommandContext):void {
  const built=buildTileVertices(map,chunks,slot.data),stride=tilemapState(map).atlas?8:6,bytes=built.count*stride*4;slot.data=built.data;slot.count=built.count;
  if(bytes){
   if(!slot.gpu||slot.gpu.bytes<bytes){
    const maximum=chunks.reduce((cells,chunk)=>cells+(chunk.x1-chunk.x0)*(chunk.y1-chunk.y0),0)*6*stride*4;
    const capacity=Math.min(maximum,Math.max(bytes,slot.gpu?slot.gpu.bytes*2:4));
    if(slot.gpu)this.owner.retire(slot.gpu);slot.gpu=this.owner.create(capacity,GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,'Tilemap2D.vertex');
   }
   this.device.queue.writeBuffer(slot.gpu.buffer,0,built.data.buffer as ArrayBuffer,built.data.byteOffset,bytes);this.counters.vertexUploadCalls++;this.counters.vertexUploadBytes+=bytes;
  }
  slot.map=map;if(slot.gpu)this.owner.use(slot.gpu,context);
 }
 private material(entity:EntityGpu,map:Tilemap2DComponent):GPUBindGroup {
  const atlas=tilemapState(map).atlas!,source=atlas.source,texture=source.texture;
  if((texture.width!==undefined&&texture.width!==atlas.sourceWidth)||(texture.height!==undefined&&texture.height!==atlas.sourceHeight)||(texture.sampleCount!==undefined&&texture.sampleCount!==1)||(texture.usage!==undefined&&!(texture.usage&GPUTextureUsage.TEXTURE_BINDING)))throw tilemapInvalid('Borrowed atlas texture dimensions, sample count or usage do not match its declaration.');
  if(!entity.material||entity.material.texture!==texture||!Object.is(entity.material.version,source.version))entity.material={texture,version:source.version,group:this.device.createBindGroup({layout:this.shared.material,entries:[{binding:0,resource:texture.createView()},{binding:1,resource:this.shared.sampler}]})};
  return entity.material.group;
 }
 render(pass:GPURenderPassEncoder,id:number,map:Tilemap2DComponent,world:Float32Array,context:RenderCommandContext):void {
  const state=tilemapState(map);let entity=this.entityCache.get(id);
  if(!entity){entity={pool:[],cache:new Map(),streams:[],objects:[],material:null};this.entityCache.set(id,entity);}
  const range=tileChunks(map,this.viewProjection,world),chunks=range.chunks,wanted=new Set(chunks.map(chunk=>chunk.key));
  this.counters.candidateChunks+=chunks.length;if(range.culled)this.counters.culledRecords++;
  const cap=range.legacy?1:state.maxResident;
  while(entity.pool.length>cap){const slot=entity.pool.pop()!;if(slot.key!==null&&entity.cache.get(slot.key)===slot)entity.cache.delete(slot.key);if(slot.gpu)this.owner.retire(slot.gpu);}
  const camera=this.uniform(this.cameras,this.viewProjection,this.shared.camera,'Tilemap2D.camera',context),object=this.uniform(entity.objects,world,this.shared.object,'Tilemap2D.object',context);
  const atlas=!!state.atlas;pass.setPipeline(this.pipeline(atlas));pass.setBindGroup(0,camera.group);pass.setBindGroup(1,object.group);if(atlas)pass.setBindGroup(2,this.material(entity,map));
  const overflow:TileChunk[]=[];
  for(const chunk of chunks){
   const revision=state.fullRevision+':'+(state.dirty.get(chunk.key)??0)+':'+(atlas?1:0);
   let slot=entity.cache.get(chunk.key);
   if(!slot||slot.map!==map||slot.revision!==revision){
    const old=slot;if(slot?.gpu?.leases.size)slot=undefined;
    if(!slot)slot=entity.pool.find(value=>!value.gpu?.leases.size&&(value.key===null||!wanted.has(value.key)));
    if(!slot&&entity.pool.length<cap){slot=this.slot();entity.pool.push(slot);}
    if(!slot){overflow.push(chunk);continue;}
    if(slot.key!==null&&entity.cache.get(slot.key)===slot)entity.cache.delete(slot.key);
    if(old&&old!==slot)old.key=null;
    this.upload(slot,map,[chunk],context);slot.key=chunk.key;slot.revision=revision;entity.cache.set(chunk.key,slot);this.counters.chunkBuilds++;
   }
   this.draw(pass,slot,context);
  }
  if(overflow.length){
   const signature=state.fullRevision+':'+overflow.map(chunk=>chunk.key+':'+(state.dirty.get(chunk.key)??0)).join(',')+':'+atlas;
   let stream=entity.streams.find(value=>value.map===map&&value.signature===signature);
   if(!stream){stream=entity.streams.find(value=>!value.gpu?.leases.size);if(!stream){if(entity.streams.length>=32)throw unavailable();stream=this.slot();entity.streams.push(stream);}this.upload(stream,map,overflow,context);stream.signature=signature;this.counters.workingBuilds++;}
   this.draw(pass,stream,context);
  }
 }
 private draw(pass:GPURenderPassEncoder,slot:VertexSlot,context:RenderCommandContext):void {if(!slot.count||!slot.gpu)return;this.owner.use(slot.gpu,context);pass.setVertexBuffer(0,slot.gpu.buffer);pass.draw(slot.count);this.counters.draws++;}
 private pipeline(atlas:boolean):GPURenderPipeline {
  const format=this.colorFormat??this.engine.format,depth=this.engine.getDepthFormat(this.reverseZ),key=[format,depth,this.msaaSamples,atlas].join(':');
  let result=this.shared.pipelines.get(key);if(result)return result;const module=atlas?this.shared.atlas:this.shared.palette;
  result=this.device.createRenderPipeline({layout:atlas?this.shared.atlasLayout:this.shared.paletteLayout,vertex:{module,entryPoint:'vs_main',buffers:[{arrayStride:atlas?32:24,attributes:atlas?[{shaderLocation:0,offset:0,format:'float32x2'},{shaderLocation:1,offset:8,format:'float32x2'},{shaderLocation:2,offset:16,format:'float32x4'}]:[{shaderLocation:0,offset:0,format:'float32x2'},{shaderLocation:1,offset:8,format:'float32x4'}]}]},fragment:{module,entryPoint:'fs_main',targets:[{format,blend:{color:{srcFactor:atlas?'one':'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:depth,depthWriteEnabled:false,depthCompare:'always'},multisample:{count:this.msaaSamples}});
  this.shared.pipelines.set(key,result);if(this.shared.pipelines.size>32)this.shared.pipelines.delete(this.shared.pipelines.keys().next().value!);return result;
 }
 releaseEntitiesNotIn(live:ReadonlySet<number>):void {for(const[id,entity]of this.entityCache)if(!live.has(id)){for(const slot of [...entity.pool,...entity.streams])if(slot.gpu)this.owner.retire(slot.gpu);for(const uniform of entity.objects)this.owner.retire(uniform.gpu);this.entityCache.delete(id);}}
 get stats(){let residentChunks=0,workingBytes=0,residentBytes=0,cpuVertexBytes=0,cpuMapBytes=0,dirtyChunks=0,transformEntries=0;const maps=new Set<Tilemap2DComponent>();for(const value of this.entityCache.values()){residentChunks+=value.cache.size;for(const slot of value.pool){residentBytes+=slot.gpu?.bytes??0;cpuVertexBytes+=slot.data.byteLength;if(slot.map)maps.add(slot.map);}for(const slot of value.streams){workingBytes+=slot.gpu?.bytes??0;cpuVertexBytes+=slot.data.byteLength;if(slot.map)maps.add(slot.map);}}for(const map of maps){cpuMapBytes+=map.cells.byteLength;dirtyChunks+=tilemapState(map).dirty.size;transformEntries+=tilemapState(map).transforms.size;}return {...this.counters,residentChunks,residentBytes,workingBytes,cpuVertexBytes,cpuMapBytes,dirtyChunks,transformEntries,...this.owner.stats};}
 destroy():void {if(!this.initialized)return;this.owner.destroy();this.entityCache.clear();this.cameras=[];this.initialized=false;}
}
