import {SceneOutputPass} from '/region-target-build/region-copy.js';
import {RttEngine} from '/engine/dist/rtt.js';

// Diagnostic render-to-copy bridge: production motion attachments do not need COPY_SRC.
// Mode 0 preserves signed half-float values, including the -1 history sentinel.
export async function readMotion(device,engine,source){
 const width=source.width,height=source.height,target=new RttEngine(engine,width,height,{r:0,g:0,b:0,a:0},'g04-motion-probe',null,'rgba16float'),copy=new SceneOutputPass();
 const bytesPerRow=Math.ceil(width*8/256)*256,read=device.createBuffer({label:'g04-motion-read',size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 try{
  copy.prepare(device);copy.configure('rgba16float',1,'none',{key:'motion-probe',target,sampleCount:1,viewport:null,scissor:null,loadOp:'clear'});copy.setFrameIdentity(1,'motion-probe');
  const encoder=device.createCommandEncoder();copy.apply(encoder,source,target.getOutputView(),device);encoder.copyTextureToBuffer({texture:target.colorTexture},{buffer:read,bytesPerRow},[width,height]);device.queue.submit([encoder.finish()]);
  const start=performance.now();await read.mapAsync(GPUMapMode.READ);const view=new DataView(read.getMappedRange()),values=new Float32Array(width*height*4);let covered=0,valid=0,invalid=0,maxVelocity=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const i=(y*width+x)*4;for(let c=0;c<4;c++)values[i+c]=half(view.getUint16(y*bytesPerRow+x*8+c*2,true));
   if(Math.abs(values[i+3])>.5){covered++;if(values[i+3]>.5)valid++;else invalid++;maxVelocity=Math.max(maxVelocity,Math.abs(values[i]),Math.abs(values[i+1]));}
  }
  return{values,stats:{width,height,covered,valid,invalid,maxVelocity,queueAndReadbackWaitMs:performance.now()-start,format:'rgba16float',copyBridge:'raw SceneOutput mode 0; no production usage change'}};
 }finally{if(read.mapState==='mapped')read.unmap();read.destroy();copy.destroy();target.destroy();}
}
function half(n){const sign=n&32768?-1:1,e=(n>>>10)&31,m=n&1023;return sign*(e===0?m*2**-24:e===31?(m?NaN:Infinity):(1+m/1024)*2**(e-15));}
