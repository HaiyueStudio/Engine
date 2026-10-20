import {Geometry3D,mat4,runRealRendererBenchmarkFrame,resetRealRendererBenchmarkMetrics} from '../../artifacts/engine-0.2.1/g05/fixture.js';
import {readFloatTexture} from './float-texture-readback.mjs';
/** Independent CPU inverse-transpose/baked-position reference, outside all timing populations. */
export async function verifyInstancePoseNormals({state,renderer,material,target}){
 const device=state.device,owned=[],count=9,identity=mat4.identity(),matrices=new Float32Array(count*16),identities=new Float32Array(count*16),colors=new Float32Array(count*4),geometries=[];
 const vertices=[[-.4,-.4,0],[.4,-.4,0],[0,.4,0]],normal=[.3,.4,Math.sqrt(.75)];
 const buffer=data=>{const b=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);owned.push(b);return b;};
 const base=new Geometry3D({positions:new Float32Array(vertices.flat()),normals:new Float32Array(Array.from({length:3},()=>normal).flat()),cullMode:'none'});
 for(let i=0;i<count;i++){
  const c=Math.cos(.13+i*.1),s=Math.sin(.13+i*.1),sx=i%2?-.48:.48,sy=.32,sz=.2;
  const matrix=new Float32Array([c*sx,0,-s*sx,0,0,sy,0,0,s*sz,0,c*sz,0,(i%3-1)*.6,(Math.floor(i/3)-1)*.6,.5,1]);
  matrices.set(matrix,i*16);identities.set(identity,i*16);colors.set([.25+(i%3)*.25,.25+(Math.floor(i/3))*.25,.6,1],i*4);
  const inverse=mat4.inverse(matrix),n=[0,1,2].map(row=>inverse[row*4]*normal[0]+inverse[row*4+1]*normal[1]+inverse[row*4+2]*normal[2]),length=Math.hypot(...n);
  const positions=vertices.flatMap(p=>[0,1,2].map(row=>matrix[row]*p[0]+matrix[4+row]*p[1]+matrix[8+row]*p[2]+matrix[12+row]));
  geometries.push(new Geometry3D({positions:new Float32Array(positions),normals:new Float32Array(Array.from({length:3},()=>n.map(v=>v/length)).flat()),cullMode:'none'}));
 }
 const transforms=buffer(matrices),bakedTransforms=buffer(identities),rgba=buffer(colors),ids=buffer(Uint32Array.from({length:count},(_,i)=>i));
 const sources=Array.from({length:count},(_,id)=>({device,transforms:bakedTransforms,colors:rgba,visibleIndices:buffer(Uint32Array.from({length:count},()=>id)),capacity:count,count:1}));
 const source={device,transforms,colors:rgba,visibleIndices:ids,capacity:count,count},original=state.render3d.record;
 let baked=false;
 const data=new Float32Array(68);data.set(identity);data.set(identity,16);data.set(identity,32);data.set([0,0,2,1,target.width,target.height,1/target.width,1/target.height],48);
 const snapshot={frameId:0,phaseRevision:0,cameraEntityId:1001,data};
 state.render3d.record=(_world,context)=>{
  snapshot.frameId=state.frameId;renderer.updateCamera(snapshot,context);const pass=context.encoder.beginRenderPass({...target.getRenderPassDescriptor(),label:'G05.instance-pose-normal-oracle'});
  if(baked)for(let i=0;i<count;i++)renderer.render(pass,1001+i,geometries[i],material,{externalInstances:sources[i]});
  else renderer.render(pass,1000,base,material,{externalInstances:source});pass.end();
 };
 try{
  resetRealRendererBenchmarkMetrics(state);
  await runRealRendererBenchmarkFrame(state);const actual=await readFloatTexture(device,target.colorTexture);baked=true;
  await runRealRendererBenchmarkFrame(state);const expected=await readFloatTexture(device,target.colorTexture);let maxDelta=0,litPixels=0;
  for(let i=0;i<actual.length;i++){const delta=Math.abs(actual[i]-expected[i]);if(!Number.isFinite(delta)||delta>1/255+1e-6)throw Error(`Instance inverse-transpose/pose mismatch ${i}: ${delta}`);maxDelta=Math.max(maxDelta,delta);if(i%4===0&&actual[i]+actual[i+1]+actual[i+2]>.01)litPixels++;}
  const probes=[];
  for(let id=0;id<count;id++){
   const x=Math.floor(((id%3-1)*.6+1)*target.width/2),y=Math.floor((1-((Math.floor(id/3)-1)*.6-.04))*target.height/2),offset=(y*target.width+x)*4;
   const pixel=Array.from(actual.slice(offset,offset+4));if(pixel.slice(0,3).every(v=>v<=.01))throw Error(`Missing pose/normal probe ${id}`);probes.push({id,mirrored:id%2===1,pixel});
  }
  return {count,mirrored:4,nonuniform:9,probes,maxDelta,litPixels,oracle:'CPU baked world positions and inverse-transpose normals; GPU instance transforms replaced with identity'};
 }finally{state.render3d.record=original;for(const b of owned)b.destroy();}
}
