import assert from 'node:assert/strict';
import test from 'node:test';
import { importEngineSource } from './helpers/internal-source.mjs';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {HaiyueEngine}=await importEngineSource('core/Engine.ts');
const {Scene}=await importEngineSource('scene/Scene.ts');
const {World}=await importEngineSource('ecs/World.ts');
const {Entity}=await importEngineSource('ecs/Entity.ts');
const {Component}=await importEngineSource('ecs/Component.ts');
const {System}=await importEngineSource('ecs/System.ts');
const {AssetManager}=await importEngineSource('assets/AssetManager.ts');
const {registerWorldResourceCleanup}=await importEngineSource('ecs/WorldResourceCleanup.ts');
const leaves=error=>error instanceof AggregateError?error.errors.flatMap(leaves):[error];
test('Scene unload errors preserve original failures while releasing plugins, assets, entities and regions',async()=>{
 const calls=[],failure=new Error('uninstall failed'),disable=new Error('disable failed'),manager=new AssetManager(createAuditGpuDevice());
 manager.registerLoader({type:'test/owned',load:async()=>42,dispose:()=>calls.push('asset')});
 const engine={assetManager:manager,defaults:{},clearColor:{r:0,g:0,b:0,a:1},reverseZ:false,msaaSamples:1,renderTarget:{}};
 const scene=new Scene(engine,{render3D:false,render2D:false,gui:false});scene.add(new Entity('owned'));
 scene.installPlugin({name:'first',version:'1',uninstallScene(){calls.push('first');}});
 scene.installPlugin({name:'bad',version:'1',disableScene(){calls.push('disable');throw disable;},uninstallScene(){calls.push('bad');scene.destroy();throw failure;}});
 await scene.load({url:'owned.test',type:'test/owned'});
 let caught;try{scene.destroy();}catch(e){caught=e;}
 assert.ok(leaves(caught).includes(failure));assert.ok(leaves(caught).some(e=>e.cause===disable));
 assert.deepEqual(calls,['disable','bad','first','asset']);assert.equal(scene.state,'destroyed');assert.equal(scene.world.entities.size,0);assert.equal(manager.size,0);assert.equal(scene.hasPlugin('bad'),false);assert.equal(scene.hasPlugin('first'),false);
 assert.doesNotThrow(()=>scene.destroy());manager.dispose();
});
test('Engine finishes independent cleanup after scene teardown fails and ignores reentrant destroy',()=>{
 const engine=new HaiyueEngine({canvas:{}}),scene=engine.createScene({render3D:false,render2D:false,gui:false});let engineUninstalled=0;
 const failure=new Error('scene teardown');scene.installPlugin({name:'bad',version:'1',uninstallScene(){engine.destroy();throw failure;}});
 engine.installPlugin({name:'independent',version:'1',uninstallEngine(){engineUninstalled++;}});engine.switchScene(scene);engine.on('retained',()=>{});
 assert.throws(()=>engine.destroy(),e=>leaves(e).includes(failure));
 assert.equal(engine.state,'destroyed');assert.equal(scene.state,'destroyed');assert.equal(engine.activeScene,null);assert.equal(engine.hasPlugin('independent'),false);assert.equal(engine.listenerCount('retained'),0);assert.equal(engineUninstalled,1);assert.doesNotThrow(()=>engine.destroy());
});
test('World failures detach all systems, destroy entities and release each independent resource and integration',()=>{
 const world=new World('owner'),other=new World('borrower'),calls=[],failures=[new Error('system'),new Error('resource'),new Error('detach')];
 class Failing extends System {destroy(){calls.push('bad');throw failures[0];}}
 class Good extends System {destroy(){calls.push('good');return super.destroy();}}
 const bad=new Failing(),good=new Good(),shared=new Good();world.addSystem(bad);world.addSystem(good);world.addSystem(shared);other.addSystem(shared);world.addEntity(new Entity('owned'));
 registerWorldResourceCleanup(world,{},()=>{calls.push('resource-a');throw failures[1];});registerWorldResourceCleanup(world,{},()=>calls.push('resource-b'));
 world.addRuntimeIntegration({onSystemRemoved(){throw failures[2];},onDetach(){calls.push('detach-a');throw failures[2];}});
 world.addRuntimeIntegration({onDetach(){calls.push('detach-b');}});
 let caught;try{world.destroy();}catch(e){caught=e;}
 for(const error of failures)assert.ok(leaves(caught).includes(error));
 assert.equal(world.entities.size,0);assert.equal(world.systems.size,0);assert.equal(bad.usedBy.length,0);assert.equal(good.usedBy.length,0);
 assert.deepEqual(shared.usedBy,[other]);assert.equal(other.hasSystem(shared),true);assert.equal(calls.filter(x=>x==='good').length,1);assert.ok(calls.includes('resource-b'));assert.ok(calls.includes('detach-b'));
 assert.doesNotThrow(()=>world.destroy());other.destroy();assert.equal(calls.filter(x=>x==='good').length,2);
});
test('destroying a hierarchy completes every child and component after a component failure',()=>{
 const world=new World('tree'),root=new Entity('root'),a=new Entity('a'),b=new Entity('b'),failure=new Error('component cleanup'),calls=[];
 class Bad extends Component {destroy(){calls.push('bad');throw failure;}}
 class Good extends Component {destroy(){calls.push('good');return super.destroy();}}
 root.addChild(a);root.addChild(b);a.add(new Bad());a.add(new Good());b.add(new Good());root.add(new Good());world.addEntity(root);
 assert.throws(()=>world.destroy(),e=>leaves(e).includes(failure));assert.equal(calls.filter(x=>x==='good').length,3);assert.equal(world.entities.size,0);
 for(const entity of [root,a,b]){assert.equal(entity.destroyed,true);assert.equal(entity.components.size,0);assert.equal(entity.parent,null);}
});
