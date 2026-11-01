import test from'node:test';import assert from'node:assert/strict';import{createAuditGpuDevice,getAuditGpuDeviceState}from'../../scripts/benchmark/real-renderer-audit-device.mjs';import{createRenderFrameContext}from'@haiyue/engine/experimental';import{loadTilemapFixture}from'./tilemap-fixture.mjs';
import{legacyPaletteVertices}from'./tilemap-legacy-reference.mjs';import{fullMapVertices}from'./tilemap-reference.mjs';
import{BUILTIN_RENDER_SHADER_ARTIFACT as shaders}from'../dist/internal/2d-ui-shader-artifact.js';
const {modules:{Tilemap2DComponent:Map2D,Tilemap2DRenderer:Renderer,tilemapState,buildTileVertices,tileChunks}}=await loadTilemapFixture();
const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),projection=(x=0,y=0)=>new Float32Array([2/1280,0,0,0,0,2/720,0,0,0,0,1,0,-1-2*x/1280,-1-2*y/720,0,1]);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};},settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture({deferredFences=false}={}){
 const draws=[],fences=[],loss=deferred(),device=createAuditGpuDevice({behaviors:{'renderPass.draw':({args})=>draws.push(args[0]),'queue.onSubmittedWorkDone':()=>{const d=deferred();fences.push(d);if(!deferredFences)d.resolve();return d.promise;}}});Object.defineProperty(device,'lost',{value:loss.promise});
 const target=device.createTexture({size:[1280,720],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT}),engine={device,format:'rgba8unorm',width:1280,height:720,displayWidth:1280,displayHeight:720,reverseZ:false,msaaSamples:1,getDepthFormat:()=> 'depth24plus'},renderer=new Renderer();renderer.prepare(engine);renderer.updateCamera(projection());
 const frame=()=>createRenderFrameContext(engine,{descriptor:{colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store'}]}});
 return {device,engine,renderer,frame,fences,loss,draws,audit:()=>getAuditGpuDeviceState(device).snapshot(),render(map,options={}){const context=options.context??frame(),pass=context.beginPass();renderer.render(pass,options.id??1,map,options.world??identity(),context);if(!options.context)context.submit();return context;},async close(){renderer.destroy();for(const d of fences)d.resolve();await settle();target.destroy();}};
}
const filled=(n=512,options={})=>new Map2D({columns:n,rows:n,cells:new Int16Array(n*n).fill(1),gap:0,...options});
const atlas=(device,extra={})=>({source:{texture:device.createTexture({size:[8,4],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING})},sourceWidth:8,sourceHeight:4,tileWidth:4,tileHeight:4,...extra});
const invalid=e=>e.code==='E_ASSET_INVALID_DATA';

test('both vertex packers match the original generated production reflection',()=>{
 for(const[id,stride,attributes]of [['tilemap2d',24,[[0,0,'float32x2'],[1,8,'float32x4']]],['spine2d',32,[[0,0,'float32x2'],[1,8,'float32x2'],[2,16,'float32x4']]]]){
  const pass=shaders.passes[id];assert.equal(pass.vertexBuffers[0].arrayStride,stride);assert.deepEqual(pass.vertexBuffers[0].attributes.map(a=>[a.shaderLocation,a.offset,a.format]),attributes);
  assert.deepEqual(pass.uniformBlocks.map(b=>b.byteSize),[64,64]);assert.deepEqual(pass.bindGroups.map(g=>g.physicalGroup),id==='tilemap2d'?[0,1]:[0,1,2]);
 }
});

test('independent full palette reference is byte-identical to the frozen original vertex implementation',()=>{
 for(const [columns,rows]of [[1,1],[17,12],[65,33],[128,128]])for(const gap of [0,1,2.5]){
  const map=new Map2D({columns,rows,cells:Array.from({length:columns*rows},(_,i)=>i%5===0?0:i%3===0?9:1+i%2),originX:-17.5,originY:6.5,cellWidth:32,cellHeight:28,gap,palette:[[0,0,0,0],[.1,.2,.3,.5],[1,.8,.6,1]]});
  assert.deepEqual(fullMapVertices(map),legacyPaletteVertices(map));
 }
});

test('legacy cells identity, coercion, versions and full invalidation remain compatible',()=>{
 const map=filled(4),cells=map.cells;map.setCell(1,1,2);assert.equal(map.cells,cells);assert.equal(map.version,1);assert.equal(tilemapState(map).dirty.size,1);assert.equal(tilemapState(map).fullRevision,0);map.markDirty();assert.equal(tilemapState(map).dirty.size,0);assert(tilemapState(map).fullRevision>0);map.cells=cells;assert.equal(map.cells,cells);map.resize(5,6);assert.equal(map.getCell(1,1),2);assert.notEqual(map.cells,cells);const large=filled(1025);assert.equal(large.cells.length,1050625);assert.throws(()=>filled(1025,{chunkSize:32}),invalid);
});
test('atlas inputs, CPU limits and Int16 indices reject before mutation',async()=>{
 const f=fixture(),a=atlas(f.device),map=filled(2,{atlas:a}),before=map.version,cells=map.cells;
 for(const value of [-1,3,32768,NaN,1.5])assert.throws(()=>map.setCell(0,0,value),invalid);assert.equal(map.version,before);assert.equal(map.cells,cells);assert.equal(map.getCell(0,0),1);
 for(const value of [{...a,sourceWidth:4097},{...a,tileWidth:0},{...a,margin:-1},{...a,spacing:NaN}])assert.throws(()=>map.setAtlas(value),invalid);
 assert.throws(()=>map.resize(1025,1025),invalid);assert.equal(map.columns,2);assert.throws(()=>new Map2D({columns:1,rows:1,cells:[65537],atlas:a}),invalid);assert.throws(()=>new Map2D({chunkSize:65}),invalid);assert.throws(()=>new Map2D({maxResidentChunks:257}),invalid);map.setAtlas(null);map.setCell(0,0,7);assert.equal(map.getCell(0,0),7);assert.throws(()=>map.setAtlas(a),invalid);assert.equal(tilemapState(map).atlas,null);await f.close();a.source.texture.destroy();
});
test('transforms dirty only their chunk and clone/resize preserve coordinates without owning texture',async()=>{
 const f=fixture(),a=atlas(f.device),map=filled(2,{atlas:a});map.setCellTransform(1,1,'rotate-90');assert.equal(tilemapState(map).dirty.size,1);const copy=map.clone();assert.equal(copy.getCellTransform(1,1),'rotate-90');assert.equal(tilemapState(copy).atlas.source,a.source);copy.setCellTransform(1,1,'flip-x');assert.equal(map.getCellTransform(1,1),'rotate-90');copy.resize(3,4);assert.equal(copy.getCellTransform(1,1),'flip-x');assert.throws(()=>copy.setCellTransform(0,0,'bad'),invalid);await f.close();assert.equal(getAuditGpuDeviceState(f.device).snapshot().resources.texture.live,1);a.source.texture.destroy();
});
test('six transforms use the declared texel-centre atlas corners',async()=>{
 const f=fixture(),a=atlas(f.device),map=filled(1,{atlas:a});const cases={none:[[.5/8,.5/4],[3.5/8,.5/4],[3.5/8,3.5/4]],'flip-x':[[3.5/8,.5/4],[.5/8,.5/4],[.5/8,3.5/4]],'flip-y':[[.5/8,3.5/4],[3.5/8,3.5/4],[3.5/8,.5/4]],'rotate-90':[[.5/8,3.5/4],[.5/8,.5/4],[3.5/8,.5/4]],'rotate-180':[[3.5/8,3.5/4],[.5/8,3.5/4],[.5/8,.5/4]],'rotate-270':[[3.5/8,.5/4],[3.5/8,3.5/4],[.5/8,3.5/4]]};
 for(const [transform,expected]of Object.entries(cases)){map.setCellTransform(0,0,transform);const {data,count}=buildTileVertices(map,[{key:0,x0:0,y0:0,x1:1,y1:1}]);assert.equal(count,6);for(let i=0;i<3;i++)assert.deepEqual([...data.slice(i*8+2,i*8+4)],expected[i]);}await f.close();a.source.texture.destroy();
});
test('static windows upload zero; a visible single cell rebuilds one chunk and an offscreen cell uploads nothing',async()=>{
 const f=fixture(),map=filled();f.render(map);const initial=f.renderer.stats;assert(initial.residentChunks<=4);assert(initial.chunkBuilds<=4);f.render(map);assert.equal(f.renderer.stats.vertexUploadCalls,initial.vertexUploadCalls);map.setCell(10,10,2);f.render(map);assert.equal(f.renderer.stats.chunkBuilds,initial.chunkBuilds+1);assert.equal(f.renderer.stats.vertexUploadCalls,initial.vertexUploadCalls+1);const before=f.renderer.stats.vertexUploadCalls;map.setCell(511,511,2);f.render(map);assert.equal(f.renderer.stats.vertexUploadCalls,before);f.renderer.updateCamera(projection(15872,15872));f.render(map);assert(f.renderer.stats.vertexUploadCalls>before);await f.close();assert.equal(f.renderer.stats.totalBytes,0);
});
test('dirty chunk boundaries, raw cells markDirty, palette replacement and same-version component replacement cannot reuse stale geometry',async()=>{
 const f=fixture(),map=filled();f.render(map);let before=f.renderer.stats.chunkBuilds;map.setCell(31,10,2);map.setCell(32,10,2);f.render(map);assert.equal(f.renderer.stats.chunkBuilds,before+2);before=f.renderer.stats.chunkBuilds;map.cells[0]=2;f.render(map);assert.equal(f.renderer.stats.chunkBuilds,before);map.markDirty();f.render(map);assert(f.renderer.stats.chunkBuilds>before);before=f.renderer.stats.chunkBuilds;map.palette=[[0,0,0,0],[1,0,0,1]];f.render(map);assert(f.renderer.stats.chunkBuilds>before);before=f.renderer.stats.chunkBuilds;f.render(filled());assert(f.renderer.stats.chunkBuilds>before);await f.close();
});
test('viewport crossing reuses bounded chunk allocations while conservative rotation and cache pressure draw every tile',async()=>{
 const f=fixture(),map=filled(128,{maxResidentChunks:1});f.render(map);assert.equal(f.renderer.stats.residentChunks,1);assert(f.renderer.stats.workingBytes>0);const rotation=identity();rotation[1]=.1;const range=tileChunks(map,projection(),rotation);assert.equal(range.culled,false);assert.equal(range.chunks.length,16);const context=f.frame(),pass=context.beginPass();const start=f.draws.length;f.renderer.render(pass,1,map,rotation,context);const draws=f.draws.slice(start);context.submit();assert.equal(draws.reduce((n,count)=>n+count,0),128*128*6);assert.equal(f.renderer.stats.residentChunks,1);assert(f.renderer.stats.workingBytes<=map.cells.length*6*24*2);await f.close();
});
test('twenty viewport moves stay within a two-chunk cache and reuse GPU allocations',async()=>{
 const f=fixture(),map=filled(512,{maxResidentChunks:2});for(let i=0;i<20;i++){f.renderer.updateCamera(projection(i*512));f.render(map);assert(f.renderer.stats.residentChunks<=2);assert(f.renderer.stats.buffers<=5);}
 assert.equal(f.fences.length,0,'ordinary frames do not request completion');await f.close();assert.equal(f.renderer.stats.totalBytes,0);
});
test('open recording mutation uses copy-on-write and distinct camera/object snapshots',async()=>{
 const f=fixture(),map=filled(),context=f.frame(),pass=context.beginPass();f.renderer.render(pass,1,map,identity(),context);const first=f.renderer.entityCache.get(1).cache.get(0).gpu.buffer;map.setCell(0,0,2);const world=identity();world[12]=2;f.renderer.updateCamera(projection(32));f.renderer.render(pass,1,map,world,context);assert.notEqual(f.renderer.entityCache.get(1).cache.get(0).gpu.buffer,first);assert.equal(f.renderer.cameras.length,2);assert.equal(f.renderer.entityCache.get(1).objects.length,2);context.submit();assert.equal(f.fences.length,0,'static frames do not request completion fences');await f.close();
});
test('destroy waits for actual submit and completion, cancellation releases unsubmitted storage immediately, repeated destroy is safe',async()=>{
 for(const terminal of ['submit','cancel']){const f=fixture({deferredFences:true}),map=filled(),context=f.frame();f.render(map,{context});f.renderer.destroy();assert(f.renderer.stats.retiredBytes>0);assert.equal(f.fences.length,0);context[terminal]();await settle();if(terminal==='submit'){assert.equal(f.fences.length,1);assert(f.renderer.stats.retiredBytes>0);f.fences[0].resolve();}await settle();assert.equal(f.renderer.stats.totalBytes,0);f.renderer.destroy();await f.close();}
});
test('cancelling one of two encoders cannot free another recording; loss releases old resources and a replacement device rebuilds',async()=>{
 const f=fixture({deferredFences:true}),map=filled(),a=f.frame(),b=f.frame();f.render(map,{context:a});f.render(map,{context:b});f.renderer.destroy();a.cancel();assert(f.renderer.stats.totalBytes>0);b.submit();await settle();assert(f.renderer.stats.retiredBytes>0);f.loss.resolve({reason:'destroyed'});await settle();assert.equal(f.renderer.stats.totalBytes,0);f.fences[0].reject(Error('lost'));await settle();const device=createAuditGpuDevice();f.engine.device=device;f.renderer.prepare(f.engine);f.renderer.updateCamera(projection());const c=createRenderFrameContext(f.engine,{descriptor:{colorAttachments:[]}});f.renderer.render(c.beginPass(),1,map,identity(),c);c.submit();f.renderer.destroy();await settle();assert.equal(f.renderer.stats.totalBytes,0);await f.close();
});
