import test from 'node:test';
import assert from 'node:assert/strict';
import {Entity} from '@haiyue/engine/ecs';
import {Transform2D} from '@haiyue/engine/components';
import {parseAnimation} from '@haiyue/animation-spec';
import {importAnimationSource} from './helpers/private-animation-source.mjs';
const {Animation2DRuntime}=await importAnimationSource('animation/Animation2DRuntime.ts');
const {ProductionCoreStateVisualRuntime}=await importAnimationSource('animation/production/ProductionCoreStateVisualRuntime.ts');
const {createHyaPlayer}=await importAnimationSource('hya-player.ts');
const rect=()=>({type:'shape2d',shape:'rect',size:[20,20],fill:[1,0,0,1]});
const track=(from,to)=>({times:[0,1],values:[from,to],valueSize:1,interpolation:'linear'});
const document=nodes=>({format:'haiyue-animation',version:'1.0',canvas:{width:64,height:64,coordinateSystem:'screen-y-down'},duration:1,nodes,tracks:[]});
const morph={...document([{id:'node',components:[{type:'org.haiyue.vector-path-morph@1',commands:'MLLLZ',times:[0,1],valueSize:8,values:[0,0,20,0,20,20,0,20,10,0,30,0,20,20,0,20],interpolation:'linear',fill:[1,0,0,1]}]}]),extensionsUsed:['org.haiyue.vector-path-morph@1']};
const cases=[
 {id:'legacy path morph',document:morph,read:r=>[...r._nodes[0].visuals[0].component.geometry.positions]},
 {id:'node opacity effect',document:document([{id:'node',components:[rect()],effects:[{kind:'opacity',opacity:1,opacityTrack:track(1,0)}]}]),read:r=>r._nodes[0].visuals[0].component.effects[0].values[0]},
 ...[false,true].map(stack=>({id:stack?'stack composite expansion':'compact composite expansion',document:document([{id:'mask',components:[rect()]},{id:'node',components:[rect()],composite:stack?{layers:[{kind:'mask',source:'mask',mode:'alpha',expansion:0,expansionTrack:track(0,10)}]}:{kind:'mask',source:'mask',mode:'alpha',expansion:0,expansionTrack:track(0,10)}}]),read:r=>r._nodes[1].visuals[0].component.compositeLayers[0].expansion})),
];
for(const entry of cases)test(`production core samples ${entry.id} without an unrelated transform track`,()=>{
 const animation=parseAnimation(entry.document),owners=[new Entity('ordinary').add(new Transform2D()),new Entity('production').add(new Transform2D())];
 const ordinary=new Animation2DRuntime(owners[0],animation),production=new ProductionCoreStateVisualRuntime(owners[1],animation,[]);
 try{
  const samples=[];
  for(const time of [0,.5,1,.25,0,.5]){ordinary.apply(time,false,1);production.applyAuthoredMixedChannels([],time);assert.deepEqual(entry.read(production),entry.read(ordinary),`time ${time}`);samples.push(entry.read(production));}
  assert.notDeepEqual(samples[1],samples[0]);
 }finally{ordinary.destroy();production.destroy();owners.forEach(owner=>owner.destroy());}
});
test('a truly static production core retains its authored and presentation early returns',()=>{
 const owner=new Entity('static').add(new Transform2D()),runtime=new ProductionCoreStateVisualRuntime(owner,parseAnimation(document([{id:'node',components:[rect()]}])),[]);
 try{for(const time of [0,.25,.5,1,.5,0])runtime.applyAuthoredMixedChannels([],time);assert.equal(runtime.stats.authoredEvaluations,1);}
 finally{runtime.destroy();owner.destroy();}
});
test('public HYA player advances, seeks backwards, and republishes an isolated legacy morph',async()=>{
 const composition={format:'haiyue-composition',version:1,parts:[{id:'core',extension:'org.haiyue.animation-core@1',required:true,requires:[],dependencies:[],document:morph}],targets:[]};
 const player=await createHyaPlayer(composition,{mode:'evaluate',viewport:[64,64],host:{capabilities:new Set(['org.haiyue.animation-core@1']),invalidate(){}}});
 try{player.advance({sequence:1,deltaSeconds:0,viewport:[64,64],dpr:1});const moved=player.advance({sequence:2,deltaSeconds:.5,viewport:[64,64],dpr:1});assert.equal(moved.time,.5);assert.equal(moved.ready,true);assert.equal(moved.changed.geometry,true);const restored=player.seek(0);assert.equal(restored.time,0);assert.equal(restored.changed.geometry,true);}
 finally{player.dispose();}
});
