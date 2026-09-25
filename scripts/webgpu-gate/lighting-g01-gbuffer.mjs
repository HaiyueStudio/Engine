// Contract-only format/precision probe. This is not a production deferred renderer.
const node=document.querySelector('#result');
try {node.textContent=JSON.stringify(await run());node.dataset.status='passed';}
catch(error){node.textContent=error.stack;node.dataset.status='failed';}
async function run(){
  const results=[];
  for(const powerPreference of ['high-performance','low-power']){
    const adapter=await navigator.gpu.requestAdapter({powerPreference});if(!adapter)throw new Error('Missing adapter');
    const device=await adapter.requestDevice();const textures=[],buffers=[];const errors=[];
    device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
    try{
      const code=`struct Out { @builtin(position) p:vec4f }; @vertex fn vs(@builtin(vertex_index)i:u32)->Out {var a=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.p=vec4f(a[i],.5,1);return o;}
      struct G { @location(0) a:vec4f, @location(1) b:vec4f, @location(2) c:vec4f }; @fragment fn fs()->G {var o:G;o.a=vec4f(.003,1.5,.7,.333);o.b=vec4f(normalize(vec3f(.2,-.4,.7)),.047);o.c=vec4f(16.25,.02,.001,.75);return o;}`;
      const module=device.createShaderModule({code});
      const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:Array.from({length:3},()=>({format:'rgba16float'}))},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}});
      for(let i=0;i<3;i++)textures.push(device.createTexture({size:[1,1],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING}));
      const depth=device.createTexture({size:[1,1],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});textures.push(depth);
      const read=device.createBuffer({size:768,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});buffers.push(read);
      const encoder=device.createCommandEncoder();const pass=encoder.beginRenderPass({colorAttachments:textures.slice(0,3).map(t=>({view:t.createView(),loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'})),depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthClearValue:1,depthStoreOp:'store'}});pass.setPipeline(pipeline);pass.draw(3);pass.end();
      for(let i=0;i<3;i++)encoder.copyTextureToBuffer({texture:textures[i]},{buffer:read,offset:i*256,bytesPerRow:256},{width:1,height:1});
      device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const h=new Uint16Array(read.getMappedRange()), values=Array.from({length:3},(_,i)=>Array.from({length:4},(_,j)=>half(h[i*128+j])));read.unmap();
      const norm=Math.hypot(.2,-.4,.7),expected=[[.003,1.5,.7,.333],[.2/norm,-.4/norm,.7/norm,.047],[16.25,.02,.001,.75]];
      for(let i=0;i<3;i++)for(let j=0;j<4;j++)if(Math.abs(values[i][j]-expected[i][j])>Math.max(.0005,Math.abs(expected[i][j])*.001))throw new Error('Half float precision failed');
      const len=Math.hypot(...values[1].slice(0,3)),dot=values[1].slice(0,3).reduce((s,x,i)=>s+x/len*expected[1][i],0),angle=Math.acos(Math.min(1,Math.max(-1,dot)))*180/Math.PI;
      if(angle>.1)throw new Error('Normal precision failed');
      const validation=await device.popErrorScope();if(validation||errors.length)throw new Error(validation?.message??errors.join(';'));
      results.push({powerPreference,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},deviceLimits:{maxColorAttachments:device.limits.maxColorAttachments,maxColorAttachmentBytesPerSample:device.limits.maxColorAttachmentBytesPerSample},values,expected,normalAngularErrorDegrees:angle,validationErrors:0,logicalBytesPerPixel:28});
    }finally{buffers.forEach(b=>b.destroy());textures.forEach(t=>t.destroy());device.destroy();}
  }
  return {schemaVersion:1,status:'passed',scope:'format and precision only; no scene or bandwidth qualification',results};
}
function half(bits){const s=(bits&32768)?-1:1,e=(bits>>10)&31,m=bits&1023;return e===0?s*m*2**-24:e===31?(m?NaN:s*Infinity):s*(1+m/1024)*2**(e-15);}
