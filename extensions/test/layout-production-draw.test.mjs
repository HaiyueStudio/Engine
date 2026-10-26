import test from 'node:test';
import assert from 'node:assert/strict';
import {loadResponsiveLayoutModules} from './responsive-layout-fixture.mjs';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {drawProduction:{compileProductionDrawPlan,writeAnimationVisualMatrix}}=await loadResponsiveLayoutModules();
const node=(extra={})=>({part:'layout',instance:'root',artboard:'main',node:'n',kind:'leaf',rect:[10,20,40,30],opacity:1,borderWidth:[0,0,0,0],cornerRadius:[0,0,0,0],...extra});
const frame=nodes=>({revision:1,viewport:[200,100],dpr:1,nodes,instances:[]});
const style={id:'s',fontAssets:['f'],fontFamily:'Fixture',fontWeight:400,fontStyle:'normal',fontSize:20,lineHeight:24,tracking:0,alignment:'start',fills:[{source:{kind:'solid',color:[.8,.2,.1,.6]},opacity:.7}]};
const glyph=(paint,extra={})=>({id:1,clusterUtf16:0,sequence:'A',rect:[0,0,10,20],advance:11,transform:[1,0,0,1,0,0],opacity:1,paint,...extra});
const text=(glyphs,extra={})=>({block:'b',size:[100,30],contentSize:[100,30],runs:[{font:'f',style,glyphs}],lines:[],controls:[],...extra});
const outline={kind:'outline',commands:'MLLLZMLLLZ',values:[0,0,10,0,10,20,0,20,3,5,3,15,7,15,7,5]};
function resources(){const device=createAuditGpuDevice(),texture=device.createTexture({size:[8,8],format:'rgba8unorm',usage:4});let acquired=0,released=0;return {device,texture,get acquired(){return acquired},get released(){return released},port:{image(){acquired++;return {texture,alphaMode:'premultiplied',release(){released++}}},bitmap(){acquired++;return {texture,alphaMode:'premultiplied',release(){released++}}}}};}
function contains(visual,x,y){const {positions:p,indices}=visual.geometry,ids=indices??Uint32Array.from({length:p.length/2},(_,i)=>i);for(let i=0;i<ids.length;i+=3){const points=[...ids.slice(i,i+3)].map(id=>[p[id*2],p[id*2+1]]),cross=(a,b)=>(b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]),s=points.map((a,j)=>cross(a,points[(j+1)%3]));if(s.every(v=>v>=-1e-6)||s.every(v=>v<=1e-6))return true;}return false;}
const point=(m,x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];

test('layout draw lowering rejects only fully offscreen geometry after the original affine',()=>{
 const nodes=[node({node:'inside',background:[1,0,0,1]}),node({node:'outside',rect:[220,20,20,20],background:[1,0,0,1]}),node({node:'brought-back',rect:[220,20,20,20],transform:[1,0,0,1,-100,0],background:[1,0,0,1]}),node({node:'rotated',rect:[-25,0,20,20],transform:[0,1,-1,0,100,40],background:[1,0,0,1]}),node({node:'edge',rect:[200.25,0,10,10],background:[1,0,0,1]})];
 const plan=compileProductionDrawPlan([frame(nodes)]),resized=compileProductionDrawPlan([{...frame(nodes),viewport:[300,100]}]);
 try{assert.equal(plan.visuals.length,4);assert.ok(!plan.visuals.some(v=>v.nodeId.includes('outside')));assert.equal(resized.visuals.length,5);assert.equal(plan.geometryBytes,resized.geometryBytes,'culling cannot hide staging-budget bytes');}finally{plan.release();resized.release();}
});
test('offscreen layout boxes keep overflowing visible glyphs and all clip sources',()=>{
 const plan=compileProductionDrawPlan([frame([node({rect:[250,20,10,20],text:text([glyph(outline,{transform:[1,0,0,1,-150,0]})]),clipShapes:[{rect:[300,0,10,10],radii:[0,0,0,0]}]}),node({node:'away',rect:[250,20,10,20],background:[1,0,0,1]})])]);
 try{assert.equal(plan.visuals.length,2);assert.equal(plan.visuals[0].sourceOnly,true);assert.ok(plan.visuals[1].nodeId.includes('/glyph/'));assert.equal(plan.visuals[1].compositeKey,plan.visuals[0].nodeKey);}finally{plan.release();}
});
test('offscreen resources and geometry limits are still validated and released',()=>{
 const value=frame([node({rect:[250,0,10,10],source:{kind:'asset',id:'outside'}})]),r=resources();
 assert.throws(()=>compileProductionDrawPlan([value]),e=>e.code==='E_HYA_RUNTIME_HOST_PORT');assert.throws(()=>compileProductionDrawPlan([value],r.port,1),e=>e.code==='E_HYA_RUNTIME_LIMIT');
 const plan=compileProductionDrawPlan([value],r.port);assert.equal(plan.visuals.length,0);assert.equal(r.acquired,2);plan.release();assert.equal(r.released,2);
});

test('drawable affine composes with the existing full world matrix and preserves uniform tail',()=>{
 const world=Float32Array.from([2,1,.5,0, -1,3,0,0, 0,0,1,0, 7,9,2,1]),local=[1.5,.25,-.75,2,3,-4],target=new Float32Array(20).fill(77);writeAnimationVisualMatrix(target,world,local);
 for(const [x,y]of [[0,0],[1,2],[-3,4]]){const [u,v]=point(local,x,y);const actual=Array.from({length:4},(_,r)=>target[r]*x+target[r+4]*y+target[r+12]),expected=Array.from({length:4},(_,r)=>world[r]*u+world[r+4]*v+world[r+12]);assert.deepEqual(actual,expected);}
 assert.deepEqual([...target.slice(16)],[77,77,77,77]);writeAnimationVisualMatrix(target,world,null);assert.deepEqual([...target.slice(0,16)],[...world]);
});
test('real outline holes survive original tessellation, normalization and glyph affine placement',()=>{
 const plan=compileProductionDrawPlan([frame([node({text:text([glyph(outline,{transform:[0,2,-1,0,30,5]})])})])]);
 try{const visual=plan.visuals[0];assert.ok(contains(visual,.1,.1));assert.equal(contains(visual,.5,.5),false);assert.deepEqual(point(visual.localTransform,0,0),[40,25]);assert.deepEqual(point(visual.localTransform,1,1),[20,45]);assert.deepEqual(visual.color,[.8,.2,.1,.6*.7]);}finally{plan.release();}
});
test('normalized radial paint stays attached to a non-square glyph under its affine',()=>{
 const radial={...style,fills:[{source:{kind:'radial-gradient',center:[.25,.75],radius:.5,stops:[{offset:0,color:[1,0,0,1]},{offset:1,color:[0,0,1,0]}]}}]};
 const plan=compileProductionDrawPlan([frame([node({text:text([glyph(outline)],{runs:[{font:'f',style:radial,glyphs:[glyph(outline)]}]})})])]);
 try{const visual=plan.visuals[0];assert.deepEqual(point(visual.localTransform,.25,.75),[12.5,35]);assert.deepEqual(visual.gradient.start,[.25,.75]);assert.deepEqual(visual.gradient.end,[.75,.75]);}finally{plan.release();}
});
test('actual bitmap paint alpha is applied once and atlas generations share one acquired lease',()=>{
 const r=resources(),source={value:{atlas:true},generation:3,bytes:256},bitmap={kind:'bitmap',source,uv:[.25,.5,.5,.25]};
 const plan=compileProductionDrawPlan([frame([node({opacity:.5,text:text([glyph(bitmap,{opacity:.4}),glyph({...bitmap,source:{...source}},{opacity:.4})])})])],r.port);
 assert.equal(r.acquired,1);for(const visual of plan.visuals){assert.deepEqual(visual.color,[1,1,1,.2]);assert.equal(visual.textureAlphaMode,'premultiplied');assert.deepEqual(visual.uvRect,[.25,.5,.5,.25]);}plan.release();plan.release();assert.equal(r.released,1);
});
test('N-slice uses real texture UVs including mirrored partial tiles without duplicating the lease',()=>{
 const r=resources(),source={kind:'asset',id:'skin'},plan=compileProductionDrawPlan([frame([node({kind:'n-slice',source,nSlice:[{rect:[10,20,8,8],uv:[.75,.25,-.25,.5],tile:'mirror'},{rect:[18,20,3,8],uv:[.75,.25,-3/32,.5],tile:'mirror'}]})])],r.port);
 assert.equal(r.acquired,1);assert.equal(plan.visuals.length,2);assert.deepEqual(plan.visuals[1].uvRect,[.75,.25,-3/32,.5]);assert.equal(plan.visuals[1].resolveTexture(),r.texture);assert.deepEqual(point(plan.visuals[1].localTransform,0,0),[18,20]);plan.release();assert.equal(r.released,1);
});
test('image source identities include player part and expanded instance',()=>{
 const r=resources(),source={kind:'asset',id:'same'},plan=compileProductionDrawPlan([frame([node({source}),node({node:'peer',source}),node({instance:'other',source}),node({part:'peer',source})])],r.port);
 assert.equal(r.acquired,3);plan.release();assert.equal(r.released,3);
});
test('successful acquire calls each release once even when the host returns the same opaque lease object',()=>{
 const r=resources();let acquired=0,released=0;const shared={texture:r.texture,alphaMode:'premultiplied',release(){released++}},source={kind:'asset',id:'same'};
 const plan=compileProductionDrawPlan([frame([node({source}),node({instance:'peer',source})])],{image(){acquired++;return shared},bitmap(){throw Error('unused')}});
 plan.release();plan.release();assert.equal(acquired,2);assert.equal(released,2);
});
test('deep rounded clip stacks lower to one dependency per source and output, preserving sharing',()=>{
 const clipShapes=Array.from({length:40},(_,i)=>({rect:[i/10,i/10,100-i/5,80-i/5],radii:[3,3,3,3]}));
 const plan=compileProductionDrawPlan([frame([node({background:[1,0,0,1],clipShapes}),node({node:'b',background:[0,1,0,1],clipShapes})])]);
 try{assert.equal(plan.visuals.filter(v=>v.sourceOnly).length,40);assert.ok(plan.visuals.every(v=>v.compositeLayers.length<=1));const outputs=plan.visuals.filter(v=>!v.sourceOnly);assert.equal(outputs[0].compositeKey,outputs[1].compositeKey);assert.equal(plan.visuals[0].geometry.positions.length>8,true);}finally{plan.release();}
});
test('rounded border is one ring, with no center fill or overlapping alpha at corners',()=>{
 const plan=compileProductionDrawPlan([frame([node({rect:[0,0,40,30],borderWidth:[2,3,4,5],borderColor:[1,0,0,.4],cornerRadius:[8,8,8,8]})])]);
 try{const visual=plan.visuals[0];assert.equal(contains(visual,20,15),false);assert.equal(contains(visual,.1,.1),false);assert.equal(contains(visual,20,1),true);assert.equal(contains(visual,1,15),true);assert.equal(visual.color[3],.4);}finally{plan.release();}
});
test('failed later geometry preparation releases earlier image leases without returning a partial plan',()=>{
 const r=resources();assert.throws(()=>compileProductionDrawPlan([frame([node({source:{kind:'asset',id:'a'}}),node({node:'bad',text:text([glyph(outline)],{runs:[{font:'f',style:{...style,fills:[{source:{kind:'linear-gradient',start:[0,0],end:[1,0],stops:Array.from({length:9},(_,i)=>({offset:i/8,color:[1,0,0,1]}))}}]},glyphs:[glyph(outline)]}]})})])],r.port),error=>error.code==='E_HYA_RUNTIME_CAPABILITY');assert.equal(r.acquired,1);assert.equal(r.released,1);
});
test('missing ready texture ports and exceeded geometry ceilings fail explicitly and unwind leases',()=>{
 const value=frame([node({source:{kind:'asset',id:'a'}})]);assert.throws(()=>compileProductionDrawPlan([value]),e=>e.code==='E_HYA_RUNTIME_HOST_PORT');const r=resources();assert.throws(()=>compileProductionDrawPlan([value],r.port,1),e=>e.code==='E_HYA_RUNTIME_LIMIT');assert.equal(r.released,1);
});
test('selection paints before real glyphs and cursor after them, without changing input values',()=>{
 const value=text([glyph(outline)],{controls:[{kind:'cursor',rect:[11,0,1,20]},{kind:'selection',rect:[0,0,11,20]}]}),before=JSON.stringify(value),plan=compileProductionDrawPlan([frame([node({text:value})])]);
 try{assert.ok(plan.visuals[0].nodeId.includes('/selection/'));assert.ok(plan.visuals.at(-1).nodeId.includes('/cursor/'));assert.equal(JSON.stringify(value),before);const copy=plan.visuals[1].clone();assert.deepEqual(copy.localTransform,plan.visuals[1].localTransform);assert.notEqual(copy.localTransform,plan.visuals[1].localTransform);}finally{plan.release();}
});
test('the original control radius reaches actual rounded selection geometry',()=>{
 const value=text([],{controls:[{kind:'selection',rect:[0,0,20,20],radius:4}]}),plan=compileProductionDrawPlan([frame([node({text:value})])]);
 try{assert.equal(contains(plan.visuals[0],.1,.1),false);assert.equal(contains(plan.visuals[0],10,10),true);assert.equal(plan.visuals[0].color[3],.35);}finally{plan.release();}
});
test('authored texture sampling survives lowering and clone without mutable host aliasing',()=>{
 const r=resources(),sampling={filter:'nearest',wrapX:'repeat',wrapY:'mirror'},port={...r.port,image(){const lease=r.port.image();return {...lease,sampling};}};
 const plan=compileProductionDrawPlan([frame([node({source:{kind:'asset',id:'a'}})])],port);
 try{const visual=plan.visuals[0];assert.deepEqual(visual.textureSampling,sampling);sampling.filter='linear';assert.equal(visual.textureSampling.filter,'nearest');assert.ok(Object.isFrozen(visual.textureSampling));const copy=visual.clone();assert.deepEqual(copy.textureSampling,visual.textureSampling);assert.notEqual(copy.textureSampling,visual.textureSampling);}finally{plan.release();}
 assert.equal(r.acquired,1);assert.equal(r.released,1);
});
