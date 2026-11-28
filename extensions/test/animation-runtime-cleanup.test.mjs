import test from 'node:test';import assert from 'node:assert/strict';
import {Entity,Transform2D} from '@haiyue/engine';import {parseAnimation} from '@haiyue/animation-spec';
import {importAnimationSource} from './helpers/private-animation-source.mjs';
const {Animation2DRuntime}=await importAnimationSource('animation/Animation2DRuntime.ts');
const {Animation2DExtensionRegistry}=await importAnimationSource('animation/Animation2DExtensionRegistry.ts');
const id=name=>'org.cleanup.'+name+'@1';
const document=(nodes,resources=[])=>parseAnimation({format:'haiyue-animation',version:'1.0',canvas:{width:32,height:32,coordinateSystem:'screen-y-down'},duration:1,extensionsUsed:['one','two','fail'].map(id),resources,nodes,tracks:[]});
function fixture({sameNode=false,failCreate=false,failDestroy=true,reenter=false}={}){
 const owner=new Entity('owner').add(new Transform2D()),registry=new Animation2DExtensionRegistry(),active=new Set(),attempts=[],entities=[],signals=[],creationError=new Error('initialization failed'),cleanupError=new Error('first destroy failed');let runtime;
 for(const name of ['one','two','fail'])registry.register({id:id(name),create(context){signals.push(context.signal);if(name==='fail')throw creationError;active.add(name);const child=new Entity(name);context.parent.addChild(child);entities.push(child);return{destroy(){assert(context.signal.aborted);attempts.push(name);active.delete(name);if(reenter)runtime.destroy();if(name==='one'&&failDestroy)throw cleanupError;}};}});
 const components=(failCreate?['one','two','fail']:['one','two']).map(name=>({type:id(name)}));
 const animation=document(sameNode?[{id:'node',components}]:components.map((component,index)=>({id:'n'+index,components:[component]})));
 return{owner,active,attempts,entities,signals,creationError,cleanupError,create(){runtime=new Animation2DRuntime(owner,animation,registry);return runtime;},close(){owner.destroy();}};
}
test('destroy completes every extension and clears the hierarchy and indexes after an extension error',()=>{
 const f=fixture(),runtime=f.create();try{assert.throws(()=>runtime.destroy(),error=>error instanceof AggregateError&&error.errors.includes(f.cleanupError));assert.deepEqual(f.attempts,['one','two']);assert.equal(f.active.size,0);assert.equal(runtime.stats.nodeCount,0);assert.equal(runtime._nodesById.size,0);assert.equal(runtime._tracksByNode.size,0);assert.equal(runtime._trackIndices.size,0);assert.equal(f.owner.children.length,0);assert(f.entities.every(entity=>entity.destroyed));assert.doesNotThrow(()=>runtime.destroy());assert.deepEqual(f.attempts,['one','two']);}finally{f.close();}
});
for(const sameNode of [false,true])test(`constructor rollback preserves initialization and cleanup errors (${sameNode?'one node':'multiple nodes'})`,()=>{
 const f=fixture({sameNode,failCreate:true});try{assert.throws(()=>f.create(),error=>error instanceof AggregateError&&error.errors[0]===f.creationError&&error.errors.includes(f.cleanupError));assert.deepEqual(f.attempts,['one','two']);assert.equal(f.active.size,0);assert(f.signals.every(signal=>signal.aborted));assert(f.entities.every(entity=>entity.destroyed));assert.equal(f.owner.children.length,0);}finally{f.close();}
});
test('constructor rollback rethrows the original creation error when cleanup succeeds',()=>{
 const f=fixture({failCreate:true,failDestroy:false});try{assert.throws(()=>f.create(),error=>error===f.creationError);assert.deepEqual(f.attempts,['one','two']);assert.equal(f.owner.children.length,0);assert.equal(f.active.size,0);}finally{f.close();}
});
test('normal and reentrant destruction release each extension exactly once',()=>{
 const f=fixture({failDestroy:false,reenter:true}),runtime=f.create();try{runtime.apply(.5);runtime.destroy();runtime.destroy();assert.deepEqual(f.attempts,['one','two']);assert.equal(f.active.size,0);assert.equal(f.owner.children.length,0);}finally{f.close();}
});
test('handle, font, rasterizer and audio failures cannot prevent independent cleanup',()=>{
 const f=fixture({failDestroy:false}),runtime=f.create(),attempts=[],error=new Error('resource release failed'),original=Object.getOwnPropertyDescriptor(globalThis,'document');
 runtime._assetHandles.push({release(){attempts.push('handle-a');throw error;}},{release(){attempts.push('handle-b');}});runtime._fontFaces.push('a','b');runtime._fontLoads.set('a',{});runtime._expressionDataLoads.set('a',{});runtime._opacityMemo.set('n0',1);
 Object.defineProperty(globalThis,'document',{configurable:true,value:{fonts:{delete(face){attempts.push('font-'+face);if(face==='a')throw error;}}}});
 runtime._nodes[0].visuals.push({textRasterizer:{destroy(){attempts.push('rasterizer');throw error;}}});runtime._nodes[0].audio.push({destroy(){attempts.push('audio');throw error;}});
 try{assert.throws(()=>runtime.destroy(),AggregateError);assert.deepEqual(attempts,['handle-a','handle-b','font-a','font-b','rasterizer','audio']);assert.deepEqual(f.attempts,['one','two']);assert.equal(runtime._assetHandles.length,0);assert.equal(runtime._fontFaces.length,0);assert.equal(runtime._fontLoads.size,0);assert.equal(runtime._expressionDataLoads.size,0);assert.equal(runtime._opacityMemo.size,0);assert.equal(f.owner.children.length,0);}finally{if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;f.close();}
});
for(const constructionFailure of [false,true])test(`late asset resolution after ${constructionFailure?'constructor rollback':'destroy'} releases the original handle`,async()=>{
 const owner=new Entity('asset owner').add(new Transform2D()),registry=new Animation2DExtensionRegistry(),failure=new Error('create failed');let resolve,signal,releases=0;
 registry.register({id:id('fail'),create(){throw failure;}});
 const components=[{type:'sprite2d',resource:'sprite',size:[8,8]},...(constructionFailure?[{type:id('fail')}]:[])],animation=document([{id:'sprite',components}],[{id:'sprite',type:'image',uri:'/sprite.png',width:8,height:8}]);
 const resources={loadTexture(_resource,requestSignal){signal=requestSignal;return new Promise(done=>resolve=done);},loadBinary(){throw Error('unexpected font');},loadExpressionData(){throw Error('unexpected data');}};
 try{if(constructionFailure)assert.throws(()=>new Animation2DRuntime(owner,animation,registry,undefined,new Map(),resources),error=>error===failure);else new Animation2DRuntime(owner,animation,registry,undefined,new Map(),resources).destroy();assert(signal.aborted);resolve({value:{},release(){releases++;}});await new Promise(done=>setImmediate(done));assert.equal(releases,1);assert.equal(owner.children.length,0);}finally{owner.destroy();}
});
