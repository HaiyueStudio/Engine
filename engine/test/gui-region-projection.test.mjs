import test from 'node:test';
import assert from 'node:assert/strict';
import {GuiSystem,GuiRoot} from '../dist/gui.js';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

for(const fail of [false,true])test(`fractional GUI projection preserves shared-pass viewport/scissor${fail?' when drawing fails':''}`,()=>{
 const viewports=[],scissors=[];
 const device=createAuditGpuDevice({behaviors:{'renderPass.setViewport':({args})=>viewports.push(args),'renderPass.setScissorRect':({args})=>scissors.push(args)}});
 const engine={device,format:'rgba16float',displayWidth:97.75,displayHeight:63.25,msaaSamples:1,reverseZ:false},system=new GuiSystem(engine),root=new GuiRoot();system.roots.add(root);
 const view={displayWidth:97.75,displayHeight:63.25,target:{width:99,height:64,format:'rgba16float'},viewport:{x:.75,y:.5,width:97.75,height:63.25},scissor:{x:0,y:0,width:99,height:64}};
 const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});let surface;
 system.renderer.render=(_pass,_roots,_engine,_reverse,_samples,value)=>{surface=value;if(fail)throw Error('draw failed')};
 const draw=()=>system.render({device,encoder,passEncoder:pass,view});if(fail)assert.throws(draw,/draw failed/);else draw();
 assert.deepEqual(surface,{width:99,height:64,format:'rgba16float',originX:-.75,originY:-.5});
 assert.deepEqual(viewports,[[0,0,99,64,0,1],[.75,.5,97.75,63.25,0,1]]);assert.deepEqual(scissors,[[0,0,99,64],[0,0,99,64]]);
 pass.end();system.destroy();root.destroy();
});

test('an ordinary full-output GUI view honors its explicit scissor without a viewport',()=>{
 const scissors=[],device=createAuditGpuDevice({behaviors:{'renderPass.setScissorRect':({args})=>scissors.push(args)}}),system=new GuiSystem({device}),root=new GuiRoot();system.roots.add(root);
 const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});system.renderer.render=()=>{};
 system.render({device,encoder,passEncoder:pass,view:{target:{width:128,height:80,format:'rgba16float'},displayWidth:128,displayHeight:80,viewport:null,scissor:{x:11,y:13,width:65,height:52}}});
 assert.deepEqual(scissors,[[11,13,65,52]]);pass.end();system.destroy();root.destroy();
});
