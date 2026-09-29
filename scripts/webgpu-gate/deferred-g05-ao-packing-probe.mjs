import {DeferredAmbientOcclusion,registerLightingAmbientOcclusion} from '../../artifacts/engine-0.2.1/g05/pending-runtime/fixture.js';

// Exercise the production owner/copy/reader with a spatial pattern, not a uniform clear.
export async function probeAoPacking(device) {
 const include=await (await fetch('../../shader-language/src/deferred-lighting/lighting-ao.wgslinc')).text();
 const source={};
 registerLightingAmbientOcclusion(source,{composite:()=>true,configure(){},create:()=>({
  prepare(device,format){
   const module=device.createShaderModule({code:`
    @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let p=array<vec2<f32>,3>(vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));return vec4(p[i],0.,1.);}
    @fragment fn fs(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{return vec4(f32((u32(p.x)+7u*u32(p.y))%17u)/16.,0.,0.,1.);}`});
   this.pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]}});
  },setSceneTextures(){},destroy(){},apply(encoder,_source,view){
   const pass=encoder.beginRenderPass({colorAttachments:[{view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});pass.setPipeline(this.pipeline);pass.draw(3);pass.end();
  }
 })});
 const cases=[];
 for(const [width,height]of [[17,9],[129,3],[1920,2]]){
  const owner=new DeferredAmbientOcclusion(device),buffers=[];
  let dummy;
  try{
   dummy=device.createTexture({size:[width,height],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING});
   const encoder=device.createCommandEncoder(),callbacks=[],context={device,encoder,afterSubmit:cb=>callbacks.push(cb)};
   const binding=owner.record(context,'packing',width,height,{passes:[source],prepare:()=>({normal:dummy,depth:dummy,frame:{}})});
   const neutral=owner.record(context,'neutral',width,height);
   const count=width*height+2;
   const module=device.createShaderModule({code:include.replace('@group(3)','@group(0)').replace('__BINDING__','0')+`
    @group(0) @binding(1) var<storage,read_write> result:array<f32>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
     if(id.x>=${count}u){return;}
     var p=vec2(f32(id.x%${width}u)+.5,f32(id.x/${width}u)+.5);
     if(id.x==${width*height}u){p=vec2(-3.,-7.);}
     if(id.x==${width*height+1}u){p=vec2(${width+9}.,${height+9}.);}
     result[id.x]=lightingAmbientVisibility(p);
    }`});
   const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
   const output=device.createBuffer({size:count*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});buffers.push(output);
   const readback=device.createBuffer({size:count*8,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});buffers.push(readback);
   for(const [index,visibility]of [binding,neutral].entries()){
    const pass=encoder.beginComputePass();pass.setPipeline(pipeline);
    pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:visibility},{binding:1,resource:{buffer:output}}]}));pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();
    encoder.copyBufferToBuffer(output,0,readback,index*count*4,count*4);
   }
   owner.destroy();device.queue.submit([encoder.finish()]);for(const callback of callbacks)callback(device.queue);
   await device.queue.onSubmittedWorkDone();await readback.mapAsync(GPUMapMode.READ);
   const values=[...new Float32Array(readback.getMappedRange())];readback.unmap();
   cases.push({width,height,values:values.slice(0,count),neutralValues:values.slice(count)});
  }finally{owner.destroy(true);for(const buffer of buffers)buffer.destroy();dummy?.destroy();}
 }
 return {cases};
}
