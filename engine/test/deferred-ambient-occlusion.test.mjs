import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {importEngineSource} from './helpers/internal-source.mjs';
const {DeferredAmbientOcclusion}=await importEngineSource('renderer/DeferredAmbientOcclusion.ts');
const {registerLightingAmbientOcclusion}=await importEngineSource('postprocess/LightingAmbientOcclusion.ts');

function setup(limits={}){
  const device=createAuditGpuDevice({limits}),owner=new DeferredAmbientOcclusion(device),events=[],callbacks=[];
  const source={intensity:1},created=[];
  registerLightingAmbientOcclusion(source,{composite:()=>true,create(){const pass={prepare(){},setSceneTextures(){},apply(encoder,src,dst){events.push({pass,encoder,src,dst,intensity:pass.intensity,first:pass.first});},destroy(){pass.destroyed=true;}};created.push(pass);return pass;},configure(pass,first){pass.intensity=source.intensity;pass.first=first;}});
  const normal=device.createTexture({size:[17,9],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING}),depth=device.createTexture({size:[17,9],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING});
  const input={passes:[source],prepare:()=>({normal,depth,frame:{}})};
  function context(){const after=[];callbacks.push(after);return {device,encoder:device.createCommandEncoder(),afterSubmit:callback=>after.push(callback)};}
  return {device,owner,source,created,events,input,context,callbacks,destroy(){owner.destroy(true);normal.destroy();depth.destroy();}};
}
test('lighting AO isolates unsubmitted views/configuration and copies padded half-float visibility after AO',()=>{
  const f=setup();try{
    const a=f.context(),b=f.context();
    const first=f.owner.record(a,'left',17,9,f.input);f.source.intensity=3;
    const second=f.owner.record(b,'right',17,9,f.input);
    assert.notEqual(first.buffer,second.buffer);assert.notEqual(f.created[0],f.created[1]);
    assert.deepEqual(f.events.map(e=>e.intensity),[1,3]);
    assert.equal(f.created[0].intensity,1,'a pending view must retain its original uniform configuration');
    assert.equal([...f.owner._slots][0].bytesPerRow,256);
    assert.ok(getAuditGpuDeviceState(f.device).calls.some(c=>c.method==='commandEncoder.copyTextureToBuffer'));
    const c=f.context();const third=f.owner.record(c,'left',17,9,f.input);
    assert.notEqual(third.buffer,first.buffer,'same view recorded twice before submission needs separate uniforms and visibility');
    f.owner.destroy();assert.ok(f.created.every(p=>!p.destroyed),'teardown cannot destroy unsubmitted resources');
  }finally{f.destroy();}
});
test('lighting AO reuses submitted slots, retires resized generations after completion and chains visibility',async()=>{
  const f=setup();try{
    const done=[];const queue={onSubmittedWorkDone:()=>new Promise(resolve=>done.push(resolve))};
    const a=f.context(),first=f.owner.record(a,'view',17,9,f.input);
    for(const callback of f.callbacks[0])callback(queue);
    const b=f.context(),second=f.owner.record(b,'view',17,9,f.input);assert.equal(second.buffer,first.buffer);
    const c=f.context();f.owner.record(c,'view',33,9,{...f.input,passes:[f.source,f.source]});
    assert.equal(f.created[0].destroyed,undefined);
    const chain=f.events.slice(-2);assert.deepEqual(chain.map(e=>e.first),[true,false]);assert.notEqual(chain[0].dst,chain[1].dst);
    for(const callback of f.callbacks[1])callback(queue);
    done.forEach(resolve=>resolve());await Promise.resolve();await Promise.resolve();
    assert.equal(f.created[0].destroyed,true);
    const neutral=f.owner.record(f.context(),'view',33,9);assert.equal(neutral,f.owner.neutral);
  }finally{f.destroy();}
});
test('pre-light surface statistics survive the later outline-only phase and composite AO is not applied twice',async()=>{
  const {Render3DPostScenePasses}=await importEngineSource('systems/Render3DPostScenePasses.ts');
  const f=setup(),post=new Render3DPostScenePasses({device:f.device});
  try{
    const other={label:'other'},debug={label:'debug'};
    registerLightingAmbientOcclusion(debug,{composite:()=>false});
    assert.deepEqual(post.outputChain([f.source,other,debug]),[f.source,other,debug,post.output]);
    post._lightingAoPrepared=true;
    assert.deepEqual(post.outputChain([f.source,other,debug]),[other,debug,post.output]);
    const stats={surfacePassCount:1,surfaceDrawCount:3,unmergedPassCount:2,unmergedDrawCount:6,sharedMotionSurface:false};
    Object.assign(post.auxiliaryStats,stats);
    post.renderAuxiliaryBuffers({requirements:{needsDepth:true,needsNormal:true,needsMotion:false,needsOutlineMask:true},items:[],motionItems:[]});
    assert.deepEqual(post.auxiliaryStats,stats);
  }finally{post.destroy();f.destroy();}
});
test('failed AO preparation releases every partially allocated resource',()=>{
  const f=setup();try{
    const bad={};let destroyed=false;
    registerLightingAmbientOcclusion(bad,{composite:()=>true,create:()=>({prepare(){throw Error('injected prepare failure');},destroy(){destroyed=true;}})});
    assert.throws(()=>f.owner.record(f.context(),'view',17,9,{...f.input,passes:[bad]}),/injected prepare/);
    assert.equal(destroyed,true);assert.equal(f.owner._slots.size,0);
  }finally{f.destroy();}
});

test('AO storage capacity fails explicitly before allocating a visibility slot',()=>{
  const f=setup({maxStorageBufferBindingSize:1024});try{
    assert.throws(()=>f.owner.record(f.context(),'view',33,9,f.input),{reason:'ao-visibility-bytes'});
    assert.equal(f.owner._slots.size,0);assert.equal(f.created.length,0);
  }finally{f.destroy();}
});
