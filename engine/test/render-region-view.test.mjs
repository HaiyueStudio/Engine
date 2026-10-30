import test from 'node:test';
import assert from 'node:assert/strict';
import {RenderView} from '../dist/core.js';
import {Entity} from '../dist/ecs.js';
import {Scene} from '../dist/scene.js';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

test('public RenderView owns independent region IDs and captures immutable caller configuration',()=>{
 let targetCalls=0;
 const target={key:'borrowed',format:'rgba8unorm',width:800,height:600,displayWidth:800,displayHeight:600,getOutputView(){targetCalls++;throw Error('No presentation should be acquired')},getRenderPassDescriptor(){targetCalls++;throw Error('No pass should be created')}};
 const view=new RenderView({camera:new Entity('camera'),target}),other=new RenderView({camera:new Entity('other'),target});
 const options={id:'tools',bounds:{x:0,y:0,width:320,height:600},updateMode:'once',clearMode:'once',visible:true};
 const handle=view.createRegion(options);other.createRegion(options);assert.equal(handle.id,'tools');assert.ok(Object.isFrozen(handle));
 assert.throws(()=>view.createRegion(options),/unique/);handle.dispose();const replacement=view.createRegion(options);
 const snapshot=view.snapshot();assert.equal(view.snapshot(),snapshot);assert.equal(snapshot.target,target);assert.equal(targetCalls,0);
 view.destroy();view.destroy();assert.throws(()=>replacement.invalidate('font'),/disposed/);assert.throws(()=>view.createRegion(options),/disposed/);
 // Destroying a view releases its regions, never its borrowed target or another view's regions.
 const independent=other.createRegion({...options,id:'preview'});independent.requestOnce();other.destroy();assert.equal(targetCalls,0);
});

test('Scene destruction releases its public region handles without acquiring a presentation target',()=>{
 let acquisitions=0;const target={key:'scene-target',format:'rgba8unorm',width:800,height:600,displayWidth:800,displayHeight:600,getOutputView(){acquisitions++;throw Error('No frame expected')},getRenderPassDescriptor(){acquisitions++;throw Error('No frame expected')}};
 const engine={device:createAuditGpuDevice(),format:'rgba8unorm',renderTarget:target,clearColor:{r:0,g:0,b:0,a:1},msaaSamples:1,reverseZ:false};
 const scene=new Scene(engine,{render3D:false,render2D:false,gui:false});
 const region=scene.renderView.createRegion({id:'sidebar',bounds:{x:0,y:0,width:320,height:600},updateMode:'demand',clearMode:'on-update',visible:true});
 scene.destroy();scene.destroy();assert.equal(scene.state,'destroyed');assert.throws(()=>region.requestOnce(),/disposed/);assert.equal(acquisitions,0);
});
