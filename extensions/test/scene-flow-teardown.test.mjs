import test from 'node:test';
import assert from 'node:assert/strict';
import {importAnimationSource} from './helpers/private-animation-source.mjs';
import {HaiyueEngine} from '@haiyue/engine/core';
const {createSceneFlow}=await importAnimationSource('scene-flow/SceneFlow.ts');
test('one retained scene failing teardown cannot retain another scene or active ownership',async()=>{
 const engine=new HaiyueEngine({canvas:{}}),flow=createSceneFlow({engine,previous:'retain'}),calls=[],failure=new Error('first failed');
 const fresh=()=>engine.createScene({render3D:false,render2D:false,gui:false});
 const a=await flow.transition({id:'a',create:()=>{const scene=fresh();scene.installPlugin({name:'first',version:'1',uninstallScene(){calls.push('first');throw failure;}});return scene;}});
 const b=await flow.transition({id:'b',create:()=>{const scene=fresh();scene.installPlugin({name:'second',version:'1',uninstallScene(){calls.push('second');}});return scene;}});
 assert.throws(()=>flow.dispose());assert.deepEqual(calls,['first','second']);assert.equal(a.state,'destroyed');assert.equal(b.state,'destroyed');assert.equal(engine.activeScene,null);assert.equal(flow.progress.phase,'disposed');assert.equal(a.world.entities.size,0);assert.equal(b.world.entities.size,0);assert.doesNotThrow(()=>flow.dispose());engine.destroy();
});
