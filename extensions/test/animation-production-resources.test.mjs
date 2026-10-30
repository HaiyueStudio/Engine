import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadResponsiveLayoutModules} from './responsive-layout-fixture.mjs';
import {loadG07Modules} from './data-binding-parity-fixture.mjs';
import {productionFontFixture} from './text-production-font-fixture.mjs';
const [modules, dataModules] = await Promise.all([loadResponsiveLayoutModules(), loadG07Modules()]);
async function createCandidateComposition(source, options) {
 const parts = source.parts.map(part => part.extension === 'org.haiyue.layout-2d@1'
  ? {id: part.id, kind: 'layout', dependencies: part.dependencies, document: modules.spec.parseResponsiveLayoutDocument(part.document), ...(options.fonts?.get(part.id) ? {fonts: options.fonts.get(part.id)} : {}), ...(options.assetOptions?.get(part.id) ? {assetOptions: options.assetOptions.get(part.id)} : {})}
  : {id: part.id, kind: 'data', dependencies: part.dependencies, document: dataModules.data.parseHyaDataBinding(part.document)});
 return {owner: await modules.frameProduction.ProductionCompositionOwner.create({parts, targets: source.targets}, options.host)};
}
function createCandidateOutlineFonts(source) {
 const document = modules.spec.parseResponsiveLayoutDocument(source), assets = new modules.runtime.LayoutAssetOwner(document, {policy: {mode: 'deny'}});
 return {fonts: modules.outlineProduction.createProductionOutlineFontPort(assets), stats: () => assets.stats, dispose: () => assets.dispose()};
}
const base={parts:[{id:'layout',document:productionFontFixture().document}]},part=(id,extension,document,dependencies=[])=>({id,extension,required:true,requires:[],dependencies,document});
const request=sequence=>({sequence,deltaSeconds:0,viewport:[128,128],dpr:1}),integrity=bytes=>'sha256-'+createHash('sha256').update(Uint8Array.from(bytes)).digest('base64');
const point=value=>({unit:'point',value}),hug={unit:'hug'},fill={unit:'fill'};
async function pending(owner,sequence){let error;try{owner.advance(request(sequence))}catch(e){error=e}assert.equal(error?.code,'E_HYA_RUNTIME_RESOURCE_PENDING',String(error));await error.ready;}
function source(kind='image'){
 const layout=structuredClone(base.parts.find(value=>value.id==='layout').document);layout.textBlocks=[];layout.textStyles=[];
 layout.assets=[{id:'old',kind:'image',width:16,height:16,source:{kind:'embedded',data:[1,2,3],integrity:integrity([1,2,3])}},{id:'new',kind:'image',width:32,height:24,source:{kind:'referenced',uri:'/new.png',integrity:integrity([4,5,6])}},{id:'wrong-kind',kind:'blob',source:{kind:'embedded',data:[1,2,3],integrity:integrity([1,2,3])}}];
 layout.artboards=[{id:'main',width:128,height:128,root:'root',nodes:[{id:'root',kind:'container',style:{display:'flex',direction:'column',width:fill,height:fill}},{id:'image',parent:'root',kind:'image',asset:'old',style:{width:hug,height:hug}},{id:'slice',parent:'root',kind:'n-slice',style:{width:point(64),height:point(48)},nSlice:{source:{kind:'asset',asset:'old'},sourceSize:[16,16],xCuts:[4,12],yCuts:[4,12]}}]}];
 layout.instances=[{id:'main',artboard:'main',fit:'fill',alignment:[0,0]}];
 const data={format:'haiyue-data-binding',version:1,extension:'org.haiyue.data-binding@1',enums:[],models:[{id:'Root',properties:[{id:'resource',kind,defaultValue:'old'}]}],instances:[{id:'root',model:'Root',scope:'local',values:{resource:'old'}}],converters:[],propertyGroups:[],components:[],bindings:[{id:'pick',target:'asset-slot',targetPath:['value'],source:{mode:'explicit',instance:'root',path:['resource']},direction:'read'}]};
 return{format:'haiyue-composition',version:1,parts:[part('data','org.haiyue.data-binding@1',data,['layout']),part('layout','org.haiyue.layout-2d@1',layout)],targets:[{id:'asset-slot',part:'layout',kind:'asset',address:['old']}]};
}
function options(extra={}){return{capabilities:new Set(['org.haiyue.layout-2d@1','org.haiyue.data-binding@1']),host:{invalidate(){}},...extra}}

test('serialized asset selector atomically updates data, intrinsic dimensions and N-slice UV after SHA readiness',async()=>{
 let resolve,signal,fail=false,draws=0,callbacks=0,observations=0,invalidations=0;
 const assetOptions=new Map([['layout',{policy:{mode:'same-origin',baseUrl:'https://fixture.test/'},resolver:{resolve(_uri,s){signal=s;return new Promise(done=>resolve=done)}}}]]);
 const host={invalidate(){invalidations++},draw(){draws++;if(fail)throw Error('draw unavailable');return{commit(){},rollback(){}}}};
 const {owner}=await createCandidateComposition(source(),options({assetOptions,host}));
 owner.subscribe(()=>observations++);
 try{await pending(owner,0);const old=owner.advance(request(0));assert.equal(old.layouts.layout.nodes.find(n=>n.node==='image').rect[2],16);
 owner.run(write=>{callbacks++;write.set('root',['resource'],'new')});let error;try{owner.advance(request(1))}catch(e){error=e}assert.equal(error?.code,'E_HYA_RUNTIME_RESOURCE_PENDING');assert.equal(owner.read('root',['resource']),'old');assert.equal(owner.lastFrame,old);assert.equal(observations,0);assert.equal(signal.aborted,false);assert.equal(draws,1);
 resolve(Uint8Array.from([4,5,6]));await error.ready;assert.ok(invalidations>=2);fail=true;assert.throws(()=>owner.advance(request(1)),/draw unavailable/);assert.equal(owner.read('root',['resource']),'old');assert.equal(owner.lastFrame,old);assert.equal(observations,0);fail=false;
 const frame=owner.advance(request(1)),image=frame.layouts.layout.nodes.find(n=>n.node==='image'),slice=frame.layouts.layout.nodes.find(n=>n.node==='slice');assert.equal(owner.read('root',['resource']),'new');assert.equal(image.source.id,'new');assert.deepEqual(image.rect.slice(2),[32,24]);assert.equal(slice.source.id,'new');assert.deepEqual(slice.nSlice[0].uv,[0,0,4/32,4/24]);assert.equal(callbacks,1);assert.equal(observations,1);assert.equal(owner.advance(request(1)),frame);assert.equal(observations,1);
 }finally{owner.dispose();owner.dispose()}
});

test('resource validation failure leaves committed data, geometry and observers unchanged',async()=>{
 let resolve;const {owner}=await createCandidateComposition(source(),options({assetOptions:new Map([['layout',{policy:{mode:'same-origin',baseUrl:'https://fixture.test/'},resolver:{resolve(){return new Promise(done=>resolve=done)}}}]])}));let observations=0;owner.subscribe(()=>observations++);
 try{await pending(owner,0);const old=owner.advance(request(0));owner.run(write=>write.set('root',['resource'],'new'));let error;try{owner.advance(request(1))}catch(e){error=e}resolve(Uint8Array.from([9,9,9]));await assert.rejects(error.ready,e=>e.code==='E_LAYOUT_ASSET_INTEGRITY');assert.throws(()=>owner.advance(request(1)),e=>e.code==='E_LAYOUT_ASSET_INTEGRITY');assert.equal(owner.read('root',['resource']),'old');assert.equal(owner.lastFrame,old);assert.equal(observations,0);
 }finally{owner.dispose()}
});

test('disposing a pending composition aborts original resource loading and prevents a late invalidation',async()=>{
 let resolve,signal,invalidations=0;const {owner}=await createCandidateComposition(source(),options({assetOptions:new Map([['layout',{policy:{mode:'same-origin',baseUrl:'https://fixture.test/'},resolver:{resolve(_uri,s){signal=s;return new Promise(done=>resolve=done)}}}]]),host:{invalidate(){invalidations++}}}));
 await pending(owner,0);owner.advance(request(0));owner.run(write=>write.set('root',['resource'],'new'));let error;try{owner.advance(request(1))}catch(e){error=e}owner.dispose();const before=invalidations;assert.equal(signal.aborted,true);resolve(Uint8Array.from([4,5,6]));await assert.rejects(error.ready);assert.equal(invalidations,before);assert.throws(()=>owner.advance(request(1)),e=>e.code==='E_HYA_RUNTIME_DISPOSED');
});

test('wrong-kind selection fails before acquisition and rolls back the queued write',async()=>{
 let loads=0;const {owner}=await createCandidateComposition(source(),options({assetOptions:new Map([['layout',{policy:{mode:'same-origin',baseUrl:'https://fixture.test/'},resolver:{async resolve(){loads++;throw Error('must not load')}}}]])}));
 try{await pending(owner,0);const old=owner.advance(request(0));owner.run(write=>write.set('root',['resource'],'wrong-kind'));assert.throws(()=>owner.advance(request(1)),e=>e.code==='E_HYA_RUNTIME_BINDING');assert.equal(loads,0);assert.equal(owner.lastFrame,old);assert.equal(owner.read('root',['resource']),'old');}finally{owner.dispose()}
});

test('font asset selection reaches the original prepared OpenType host in the same committed frame',async()=>{
 const fixture=source('font'),layout=structuredClone(base.parts.find(value=>value.id==='layout').document);layout.assets.push({...structuredClone(layout.assets[0]),id:'font-two'});layout.artboards=[{id:'main',width:128,height:128,root:'root',nodes:[{id:'root',kind:'container',style:{display:'flex',direction:'column',width:fill,height:fill}},{id:'text',parent:'root',kind:'text',text:'label',style:{width:point(128),height:hug}}]}];layout.instances=[{id:'main',artboard:'main',fit:'fill',alignment:[0,0]}];
 fixture.parts[1].document=layout;fixture.targets[0].address=['font'];const data=fixture.parts[0].document;data.models[0].properties[0].defaultValue='font';data.instances[0].values.resource='font';const fonts=createCandidateOutlineFonts(layout);let fail=false;
 const host={invalidate(){},draw(){if(fail)throw Error('later draw failed');return{commit(){},rollback(){}}}};
 const {owner}=await createCandidateComposition(fixture,options({fonts:new Map([['layout',fonts.fonts]]),host}));
 try{await pending(owner,0);const old=owner.advance(request(0));assert.equal(old.layouts.layout.nodes.find(n=>n.node==='text').text.runs[0].font,'font');owner.run(write=>write.set('root',['resource'],'font-two'));await pending(owner,1);fail=true;assert.throws(()=>owner.advance(request(1)),/later draw failed/);assert.equal(owner.read('root',['resource']),'font');assert.equal(owner.lastFrame,old);fail=false;const next=owner.advance(request(1));assert.equal(next.layouts.layout.nodes.find(n=>n.node==='text').text.runs[0].font,'font-two');assert.equal(owner.read('root',['resource']),'font-two');}finally{owner.dispose();assert.equal(fonts.stats().references,0);fonts.dispose()}
});
