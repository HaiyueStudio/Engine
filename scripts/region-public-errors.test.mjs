import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from '../engine/test/helpers/internal-source.mjs';
const {RenderRegionCollection}=await importEngineSource('core/RenderRegionState.ts');
const {EngineError,EngineErrorCode}=await importEngineSource('core/EngineError.ts');
const settings={id:'tools',bounds:{x:0,y:0,width:10,height:10},updateMode:'demand',clearMode:'on-update',visible:true};
const rejects=(run,code=EngineErrorCode.RenderPipelineInvalidPassState)=>assert.throws(run,e=>e instanceof EngineError&&e.code===code&&e.toJSON().code===code);
test('public region validation uses serializable existing errors and preserves valid handles after failure',()=>{
  const collection=new RenderRegionCollection();
  for(const value of [null,{...settings,id:''},{...settings,bounds:{x:0,y:0,width:-1,height:1}},
    {...settings,updateMode:'bad'},{...settings,clearMode:'bad'},{...settings,visible:3}])rejects(()=>collection.create(value));
  const region=collection.create(settings),generation=collection.generation;
  rejects(()=>collection.create(settings));rejects(()=>region.invalidate(''));rejects(()=>region.setMode('bad'));
  rejects(()=>region.setVisible(1));rejects(()=>region.setBounds({...settings.bounds,x:Infinity}));
  assert.equal(collection.generation,generation);region.invalidate('valid');assert.equal(collection.generation,generation+1);
  region.dispose();rejects(()=>region.invalidate('later'),EngineErrorCode.EngineInvalidState);
  collection.dispose();rejects(()=>collection.create(settings),EngineErrorCode.EngineInvalidState);
});
