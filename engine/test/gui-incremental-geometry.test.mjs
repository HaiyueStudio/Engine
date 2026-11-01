import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {GuiBatch}=await importEngineSource('gui/rendering/GuiBatch.ts'),{GuiTextBatch}=await importEngineSource('gui/rendering/GuiTextBatch.ts'),{GuiGpuResources}=await importEngineSource('gui/rendering/GuiGpuResources.ts'),{guiGeometryWork,guiVertexChanges}=await importEngineSource('gui/rendering/GuiVertexChanges.ts');
const {guiTextClusters}=await importEngineSource('gui/rendering/GuiTextGlyphs.ts'),{guiGraphemeBoundaries}=await importEngineSource('gui/input/GuiGraphemes.ts');
const {GuiRenderer}=await importEngineSource('gui/rendering/GuiRenderer.ts'),{GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts'),{GuiElement}=await importEngineSource('gui/components/GuiElement.ts'),{GuiLabel}=await importEngineSource('gui/components/GuiLabel.ts'),{GuiProgress}=await importEngineSource('gui/components/GuiProgress.ts');
function font(){return{id:91,size:10,lineHeight:10,scaleW:128,scaleH:128,chars:new Map([...('ABC0123456789?')].map((c,i)=>[c.codePointAt(0),{id:c.codePointAt(0),x:i*5,y:0,width:5,height:8,xoffset:0,yoffset:1,xadvance:6,page:0}])),kernings:new Map(),pages:[]};}
const text=(value='AB',x=0)=>({text:value,x,y:0,width:100,height:30,fontSize:10,color:[1,1,1,1],multiline:true,wrap:true});
const shape=(x=0)=>({x,y:0,width:10,height:12,radius:2,color:[1,1,1,1],clip:{x:0,y:0,width:1000,height:100}});
function update(batch,commands,f){batch.clear();for(const c of commands)f?batch.addText(c):batch.addShape(c);batch.rebuild(f);}
function equalFresh(batch,commands,f){const full=f?new GuiTextBatch():new GuiBatch();update(full,commands,f);assert.equal(batch.vertexCount,full.vertexCount);assert.deepEqual(batch.commandRanges,full.commandRanges);const length=batch.vertexCount*(f?12:15);assert.deepEqual(batch.vertexData.subarray(0,length),full.vertexData.subarray(0,length));}

test('a local text change lays out one command and packs one changed glyph',()=>{
 const f=font(),batch=new GuiTextBatch(),commands=Array.from({length:128},(_,i)=>text('A1',i*3));update(batch,commands,f);const base=batch.version;
 commands[63].text='A2';update(batch,commands,f);assert.deepEqual(guiGeometryWork(batch),{commands:128,layouts:1,vertices:6});assert.deepEqual(guiVertexChanges(batch,base,batch.version),[{offset:(63*12+6)*12*4,size:6*12*4}]);equalFresh(batch,commands,f);
 update(batch,commands,f);assert.deepEqual(guiGeometryWork(batch),{commands:128,layouts:0,vertices:0});
});
test('text color changes repack without layout; mutable font glyphs, kerning and maps invalidate layouts',()=>{
 const f=font(),batch=new GuiTextBatch(),commands=[text('AB'),text('BA',30)];update(batch,commands,f);
 commands[0].color[0]=.5;update(batch,commands,f);assert.equal(guiGeometryWork(batch).layouts,0);equalFresh(batch,commands,f);
 for(const change of [()=>f.chars.get(65).xadvance++,()=>f.kernings.set(65*65536+66,2),()=>f.chars.set(66,{...f.chars.get(66),x:40}),()=>f.lineHeight++,()=>f.scaleW*=2]){change();update(batch,commands,f);assert.equal(guiGeometryWork(batch).layouts,2);equalFresh(batch,commands,f);}
});
test('text insertion/deletion, wrapping, clipping, reordering and clearing match a fresh full build',()=>{
 const f=font(),batch=new GuiTextBatch(),a=text('ABC'),b=text('BA',30);let commands=[a,b];
 for(const change of [()=>{},()=>a.text='A',()=>a.text='ABCABC',()=>a.width=7,()=>a.verticalAlign='center',()=>a.clip={x:0,y:10,width:18,height:15},()=>commands.reverse(),()=>commands.splice(1,0,text('C',20)),()=>commands.splice(0,1),()=>commands=[],()=>commands=[text('123',2)]]){change();update(batch,commands,f);equalFresh(batch,commands,f);}
});
test('shapes rebuild only changed commands and safely shift strokes/rounded geometry',()=>{
 const batch=new GuiBatch(),commands=Array.from({length:128},(_,i)=>shape(i*3));update(batch,commands);commands[63].width=5;update(batch,commands);assert.equal(guiGeometryWork(batch).vertices,6);equalFresh(batch,commands);
 for(const change of [()=>commands[20].strokeWidth=1,()=>commands[40].roundedMesh=true,()=>commands[20].strokeWidth=undefined,()=>commands.reverse(),()=>commands.splice(10,1),()=>commands[12].clip.width=50]){change();update(batch,commands);equalFresh(batch,commands);}
 batch.clear({releaseVertexData:true});assert.equal(batch.vertexData.byteLength,0);update(batch,commands);equalFresh(batch,commands);
});
function recording(device){const submits=[],cancels=[];return{device,afterSubmit:cb=>submits.push(cb),afterCancel:cb=>cancels.push(cb),submit(){submits.splice(0).forEach(cb=>cb(device.queue));cancels.length=0;},cancel(){cancels.splice(0).forEach(cb=>cb());submits.length=0;}};}
test('partial uploads preserve bytes and pending recordings use completely initialized new buffers',async()=>{
 const writes=[],device=createAuditGpuDevice({behaviors:{'queue.writeBuffer':({args:[buffer,offset,source,start=0,size]})=>{writes.push({buffer,offset,bytes:new Uint8Array(source,start,size).slice()});}}}),audit=getAuditGpuDeviceState(device),pool=new GuiGpuResources(device),batch=new GuiBatch(),commands=Array.from({length:128},(_,i)=>shape(i*3));
 const gpu=new Map(),usage=GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST;
 function draw(context){const buffer=pool.upload(batch,batch.version,batch.vertexData,batch.vertexCount*15*4,usage,'partial-test',context);for(const write of writes.splice(0)){if(!gpu.has(write.buffer))gpu.set(write.buffer,new Uint8Array(write.buffer.size));gpu.get(write.buffer).set(write.bytes,write.offset);}assert.deepEqual(gpu.get(buffer).subarray(0,batch.vertexCount*15*4),new Uint8Array(batch.vertexData.buffer,0,batch.vertexCount*15*4));return buffer;}
 update(batch,commands);let context=recording(device);const first=draw(context);context.submit();const before=audit.snapshot().uploads;
 commands[60].width=7;update(batch,commands);context=recording(device);assert.equal(draw(context),first);assert.equal(audit.snapshot().uploads.bytes-before.bytes,6*15*4);
 commands[61].width=8;update(batch,commands);const other=recording(device),next=draw(other);assert.notEqual(next,first,'unsubmitted buffer remains immutable');context.cancel();other.submit();
 commands[62].width=6;update(batch,commands);commands[63].width=6;update(batch,commands);context=recording(device);const skipped=audit.snapshot().uploads.bytes;draw(context);assert.equal(audit.snapshot().uploads.bytes-skipped,batch.vertexCount*15*4,'skipped CPU generations require a full upload');context.submit();pool.destroy();for(let i=0;i<12;i++)await Promise.resolve();assert.equal(audit.snapshot().resources.buffer.live,0);
});
test('scattered glyph updates bound queue ranges and skipped upload generations never use a stale delta',()=>{
 const f=font(),batch=new GuiTextBatch(),commands=Array.from({length:256},(_,i)=>text('A1',i*3));update(batch,commands,f);const before=batch.version;for(const c of commands)c.text='A2';update(batch,commands,f);const ranges=guiVertexChanges(batch,before,batch.version);assert.ok(ranges.length<=32);assert.ok(ranges.every(r=>r.offset%4===0&&r.size%4===0));const old=batch.version;commands[0].text='A3';update(batch,commands,f);assert.equal(guiVertexChanges(batch,before,batch.version),undefined);assert.ok(guiVertexChanges(batch,old,batch.version));equalFresh(batch,commands,f);
});
test('ASCII fast clusters retain CRLF semantics and all Unicode uses the same UAX boundaries',()=>{
 for(const value of ['','A\r\nB\rC\n','\x00\x7f','你好','e\u0301','👩‍👩‍👧‍👦','🇨🇳','क्ष']){const boundaries=guiGraphemeBoundaries(value),expected=boundaries.slice(1).map((end,i)=>value.slice(boundaries[i],end));assert.deepEqual(guiTextClusters(value),expected);}
});
test('custom font getters retain the original live layout reads without snapshot side effects',()=>{
 const f=font(),glyph=f.chars.get(65);let reads=0;Object.defineProperty(glyph,'xadvance',{get(){reads++;return 6;},configurable:true});
 const batch=new GuiTextBatch(),commands=[text('AA')];for(let i=0;i<3;i++){update(batch,commands,f);assert.equal(reads,(i+1)*2);assert.equal(guiGeometryWork(batch).layouts,1);}
});
test('a failed partial rebuild forces a complete recovery upload, including its already-written prefix',()=>{
 const batch=new GuiBatch(),commands=Array.from({length:8},(_,i)=>shape(i*3));update(batch,commands);const base=batch.version;let failing=true,reads=0;
 commands[0].width=7;Object.defineProperty(commands[3],'width',{enumerable:true,configurable:true,get(){if(failing&&++reads===2)throw Error('injected shape failure');return 10;}});
 assert.throws(()=>update(batch,commands),/injected shape failure/);assert.equal(batch.version,base);assert.equal(guiVertexChanges(batch,base,base+1),undefined);
 failing=false;update(batch,commands);assert.deepEqual(guiVertexChanges(batch,base,batch.version),[{offset:0,size:batch.vertexCount*15*4}]);equalFresh(batch,commands);
});
test('registered painters retain private theme copies rather than mutating their parent or siblings',()=>{
 const root=new GuiRoot(),a=root.add(new GuiElement({id:'a'})),b=root.add(new GuiElement({id:'b'})),renderer=new GuiRenderer();let seen;
 renderer.registerElementRenderer(GuiElement,(element,theme)=>{if(element===a)theme.colors.text='changed by custom painter';if(element===b)seen=theme.colors.text;});
 try{const original=root.theme.colors.text;root.layout(100,100);renderer.collectElement(root.root,root.theme);assert.equal(seen,original);assert.equal(root.theme.colors.text,original);}finally{renderer.destroy();root.destroy();}
});
test('non-text stock controls avoid per-node font resolution; custom skins retain the old font path',()=>{
 const device=createAuditGpuDevice(),engine={device,format:'rgba8unorm',displayWidth:200,displayHeight:100,msaaSamples:1,reverseZ:false,getDepthFormat:()=> 'depth24plus'},root=new GuiRoot(),label=root.add(new GuiLabel({text:'AB',width:80,height:20}));
 root.add(new GuiElement({width:40,height:20}));root.add(new GuiProgress({showText:false}));
 const renderer=new GuiRenderer({chars:'AB?',atlasSize:64,canvasFactory(width,height){return{width,height,getContext:()=>({measureText:t=>({width:t.length*6,actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}),clearRect(){},fillText(){}})};}});renderer.prepare(engine);
 let families=0,custom=0;const family=renderer.fontOwner.forFamily,forRoot=renderer.fontOwner.forRoot;
 renderer.fontOwner.forFamily=function(...args){families++;return family.apply(this,args);};renderer.fontOwner.forRoot=function(r,e){if(e===label)custom++;return forRoot.call(this,r,e);};
 const draw=()=>{root.layout(200,100);const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,[root],engine);pass.end();device.queue.submit([encoder.finish()]);root.clearDirty();};
 try{draw();assert.equal(families,3,'two root cache lookups and one text leaf; no font lookup for the other stock nodes');assert.equal(custom,0);const resolve=label.getResolvedStyle;label.getResolvedStyle=function(){return{...resolve.call(this),fontFamily:'Custom skin'};};label.markDirty();draw();assert.equal(custom,1);}finally{renderer.destroy();root.destroy();}
});
test('a failing collector releases its current root/batch context and can retry the complete frame',()=>{
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device),engine={device,format:'rgba8unorm',displayWidth:100,displayHeight:100,msaaSamples:1,reverseZ:false,getDepthFormat:()=> 'depth24plus'},root=new GuiRoot(),element=root.add(new GuiElement({width:40,height:20}));
 const renderer=new GuiRenderer({chars:'?',atlasSize:64,canvasFactory(width,height){return{width,height,getContext:()=>({measureText:()=>({width:6,actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}),clearRect(){},fillText(){}})};}});let fail=true;
 renderer.registerElementRenderer(GuiElement,(item)=>{renderer.currentBatch.addShape(shape());if(item===element&&fail)throw Error('injected collector failure');});
 const draw=()=>{root.layout(100,100);const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,[root],engine);pass.end();device.queue.submit([encoder.finish()]);};
 try{assert.throws(draw,/injected collector failure/);assert.equal(renderer.currentRoot,null);assert.equal(renderer.currentCache,null);assert.equal(renderer.currentBatch,renderer.batch);fail=false;assert.doesNotThrow(draw);}finally{renderer.destroy();root.destroy();assert.equal(audit.snapshot().resources.buffer.live,0);assert.equal(audit.snapshot().resources.texture.live,0);}
});
test('a large external font does not scan its unused glyphs just to cache one short label',()=>{
 const f=font();let reads=0;const unused=new Proxy({...f.chars.get(65)},{getOwnPropertyDescriptor(...args){reads++;return Reflect.getOwnPropertyDescriptor(...args);}});for(let i=0;i<1000;i++)f.chars.set(1000+i,unused);
 const batch=new GuiTextBatch(),commands=[text('A')];update(batch,commands,f);update(batch,commands,f);assert.equal(reads,0);assert.equal(guiGeometryWork(batch).layouts,1);equalFresh(batch,commands,f);
});
