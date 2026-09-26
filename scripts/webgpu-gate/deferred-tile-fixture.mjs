import { getPrecompiledShaderPassRuntime } from '/engine/dist/internal/precompiled-shader-runtime.js';
const resultNode=document.querySelector('#result');
try { const result=await run();resultNode.textContent=JSON.stringify(result);resultNode.dataset.status='passed'; }
catch(error){resultNode.textContent=JSON.stringify({error:`${error.message}\n${error.stack}`});resultNode.dataset.status='failed';}
async function run(){
  const adapter=await navigator.gpu.requestAdapter({powerPreference:new URLSearchParams(location.search).get('powerPreference')??'high-performance'});
  if(!adapter||adapter.info.isFallbackAdapter)throw Error('Native adapter required');
  const device=await adapter.requestDevice(),resources=[];
  const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  try {
    const artifact=await (await fetch('/artifacts/engine-0.2.1/g03/tiled-artifact.json')).json();
    const cull=getPrecompiledShaderPassRuntime(device,artifact,'deferred-tile-cull');
    for(const pass of Object.values(artifact.passes)){
      const module=device.createShaderModule({code:pass.code});const info=await module.getCompilationInfo();
      const failures=info.messages.filter(m=>m.type==='error');if(failures.length)throw Error(`${pass.id}: ${failures.map(m=>m.message).join('\n')}`);
    }
    const pipeline=await device.createComputePipelineAsync({layout:cull.pipelineLayout,compute:{module:cull.module,entryPoint:'cs_main'}});
    const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);resources.push(b);return b;};
    const scene=new Float32Array(68);for(const offset of [0,16,32])for(let i=0;i<4;i++)scene[offset+i*5]=1;scene.set([32,32,1/32,1/32],52);
    const frame=buffer(scene,GPUBufferUsage.UNIFORM);
    const source=new ArrayBuffer(16+256*64),su=new Uint32Array(source),sf=new Float32Array(source);su.set([1,7,256,0]);
    for(let i=0;i<256;i++){const start=4+i*16;sf.set([0,0,.5,10],start);su[start+12]=2;su[start+13]=i+1;}
    const sourceBuffer=buffer(source,GPUBufferUsage.STORAGE),view=buffer(new Uint32Array([7,256,0,0,0,0,0,0]),GPUBufferUsage.UNIFORM);
    const indices=buffer(Uint32Array.from({length:256},(_,i)=>i),GPUBufferUsage.STORAGE);
    const params=new ArrayBuffer(32);new Uint32Array(params).set([2,2,128,4]);new Float32Array(params).set([0,0,32,32],4);
    const parameters=buffer(params,GPUBufferUsage.UNIFORM),tiles=buffer(new Uint32Array(4*132),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const readback=device.createBuffer({size:4*528,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});resources.push(readback);
    const groups=[device.createBindGroup({layout:cull.bindGroupLayouts[0],entries:[{binding:0,resource:{buffer:frame,size:272}}]}),
      ...[1,2].map(i=>device.createBindGroup({layout:cull.bindGroupLayouts[i],entries:[]})),
      device.createBindGroup({layout:cull.bindGroupLayouts[3],entries:[[0,sourceBuffer],[1,view],[2,indices],[15,tiles],[16,parameters]].map(([binding,b])=>({binding,resource:{buffer:b}}))})];
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);
    groups.forEach((g,i)=>pass.setBindGroup(i,g,i===0?[0]:[]));pass.dispatchWorkgroups(2,2);pass.end();encoder.copyBufferToBuffer(tiles,0,readback,0,4*528);device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);const words=new Uint32Array(readback.getMappedRange()).slice();readback.unmap();
    for(let tile=0;tile<4;tile++){
      const base=tile*132;if(words[base]!==base+4||words[base+1]!==256||words[base+2]!==1)throw Error(`Invalid overflow header ${Array.from(words.slice(base,base+4))}`);
      for(let i=0;i<128;i++)if(words[base+4+i]!==i)throw Error('Unstable source order');
    }
    const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join('\n'));
    return {status:'passed',schemaVersion:1,scope:'initial compute and shader compilation smoke; not G03 acceptance',adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},artifactHash:artifact.artifactHash,overflowTiles:4,acceptedPerTile:256,storedPrefix:128,validationErrors:errors};
  }finally{for(const resource of resources)resource.destroy();device.destroy();}
}
