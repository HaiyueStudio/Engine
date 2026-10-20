const progress=document.querySelector('#progress'),output=document.querySelector('#result');
let device;
try{
  const response=await fetch('/artifacts/engine-0.2.2/g02/hya-pixel-input.json');if(!response.ok)throw Error('Missing bound pixel input');
  const data=await response.json(),{LayoutEvaluator,LayoutGpuRenderer}=await import('/hya-layout-build/animation/layout/parameterized/index.js');
  if(!navigator.gpu)throw Error('WebGPU unavailable');const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('Adapter unavailable');
  device=await adapter.requestDevice();device.pushErrorScope('validation');const results=[];
  for(const c of data.cases){
    progress.textContent=c.id;const evaluator=new LayoutEvaluator(c.document);
    try{
      const actual=evaluator.evaluate(c.request),reference=await pixels(paint(c.reference)),current=await pixels(paint(actual));let differences=0;
      if(reference.bytes.length!==current.bytes.length)throw Error('Pixel populations differ');
      for(let i=0;i<reference.bytes.length;i++)if(reference.bytes[i]!==current.bytes[i])differences++;
      const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
      results.push({id:c.id,width:actual.viewport[0],height:actual.viewport[1],differentBytes:differences,referenceSha256:await hash(reference.bytes),actualSha256:await hash(current.bytes),opaquePixels:current.opaque});
      if(differences||current.opaque===0)throw Error('Actual evaluated geometry raster mismatch: '+JSON.stringify(results.at(-1)));
    }finally{evaluator.dispose();}
  }
  const validation=await device.popErrorScope();if(validation)throw validation;
  output.textContent=JSON.stringify({status:'passed',suite:'g02-hya-evaluated-pixel-parity',purpose:'diagnostic layout renderer, not real glyph/image production qualification',strictValidation:true,cases:results.length,results,adapter:adapter.info?.description??'unavailable'});output.dataset.status='passed';
}catch(error){output.textContent=JSON.stringify({status:'failed',error:String(error.stack??error)});output.dataset.status='failed';}
finally{device?.destroy();}

function paint(evaluation){return {...evaluation,nodes:evaluation.nodes.map((node,i)=>({...node,background:node.background??[(i%3+1)/4,((i+1)%3+1)/4,((i+2)%3+1)/4,1]}))};}
async function pixels(evaluation){
  const [width,height]=evaluation.viewport,renderer=new (await import('/hya-layout-build/animation/layout/parameterized/index.js')).LayoutGpuRenderer(device);
  const stride=Math.ceil(width*4/256)*256;
  const texture=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const buffer=device.createBuffer({size:stride*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try{
    renderer.upload(evaluation);const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});renderer.render(pass);pass.end();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:stride},[width,height]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
    const mapped=new Uint8Array(buffer.getMappedRange()),bytes=new Uint8Array(width*height*4);let opaque=0;
    for(let y=0;y<height;y++){bytes.set(mapped.subarray(y*stride,y*stride+width*4),y*width*4);for(let x=0;x<width;x++)if(mapped[y*stride+x*4+3]>200)opaque++;}
    buffer.unmap();return {bytes,opaque};
  }finally{renderer.dispose();if(renderer.stats.bufferCount||renderer.stats.allocatedBytes)throw Error('Renderer residual resources');buffer.destroy();texture.destroy();}
}
