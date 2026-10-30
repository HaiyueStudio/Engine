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

function nullable(){const fixture=source();fixture.parts[0].document.models[0].properties[0].nullable=true;return fixture;}
test('an initially null image slot creates neither a fake handle nor image/N-slice geometry',async()=>{
 const fixture=nullable(),data=fixture.parts[0].document;data.models[0].properties[0].defaultValue=null;data.instances[0].values.resource=null;let loads=0;
 const {owner}=await createCandidateComposition(fixture,options({assetOptions:new Map([['layout',{policy:{mode:'same-origin',baseUrl:'https://fixture.test/'},resolver:{async resolve(){loads++;throw Error('cleared slot must not acquire')}}}]])}));
 try{const frame=owner.advance(request(0)),image=frame.layouts.layout.nodes.find(n=>n.node==='image'),slice=frame.layouts.layout.nodes.find(n=>n.node==='slice');assert.equal(owner.read('root',['resource']),null);assert.equal(image.source,undefined);assert.deepEqual(image.rect.slice(2),[0,0]);assert.equal(slice.source,undefined);assert.equal(slice.nSlice,undefined);assert.equal(loads,0);}finally{owner.dispose()}
});
test('nullable image clearing participates in whole-frame rollback, publication and exact retry',async()=>{
 let fail=false,callbacks=0,observations=0;const {owner}=await createCandidateComposition(nullable(),options({host:{invalidate(){},draw(){if(fail)throw Error('draw failed');return{commit(){},rollback(){}}}}}));owner.subscribe(()=>observations++);
 try{await pending(owner,0);const old=owner.advance(request(0));owner.run(write=>{callbacks++;write.set('root',['resource'],null)});fail=true;assert.throws(()=>owner.advance(request(1)),/draw failed/);assert.equal(owner.read('root',['resource']),'old');assert.equal(owner.lastFrame,old);assert.equal(observations,0);fail=false;const cleared=owner.advance(request(1));assert.equal(owner.read('root',['resource']),null);assert.equal(cleared.layouts.layout.nodes.find(n=>n.node==='image').source,undefined);assert.equal(cleared.layouts.layout.nodes.find(n=>n.node==='slice').source,undefined);assert.equal(callbacks,1);assert.equal(observations,1);assert.equal(owner.advance(request(1)),cleared);assert.equal(observations,1);}finally{owner.dispose()}
});
test('a newer null intent aborts a pending image candidate and cannot be overwritten by late bytes',async()=>{
 let resolve,signal;const {owner}=await createCandidateComposition(nullable(),options({assetOptions:new Map([['layout',{policy:{mode:'same-origin',baseUrl:'https://fixture.test/'},resolver:{resolve(_uri,s){signal=s;return new Promise(done=>resolve=done)}}}]])}));
 try{await pending(owner,0);owner.advance(request(0));owner.run(write=>write.set('root',['resource'],'new'));let waiting;try{owner.advance(request(1))}catch(e){waiting=e}assert.equal(waiting.code,'E_HYA_RUNTIME_RESOURCE_PENDING');owner.run(write=>write.set('root',['resource'],null));const cleared=owner.advance(request(2));assert.equal(signal.aborted,true);await assert.rejects(waiting.ready);resolve(Uint8Array.from([4,5,6]));await new Promise(done=>setTimeout(done,0));assert.equal(owner.read('root',['resource']),null);assert.equal(owner.lastFrame,cleared);assert.equal(cleared.layouts.layout.nodes.find(n=>n.node==='image').source,undefined);}finally{owner.dispose()}
});
test('a cleared slot can select another declared image with its actual intrinsic size and UV',async()=>{
 const fixture=nullable();fixture.parts[0].document.instances[0].values.resource=null;const {owner}=await createCandidateComposition(fixture,options({assetOptions:new Map([['layout',{policy:{mode:'same-origin',baseUrl:'https://fixture.test/'},resolver:{async resolve(){return Uint8Array.from([4,5,6])}}}]])}));
 try{owner.advance(request(0));owner.run(write=>write.set('root',['resource'],'new'));await pending(owner,1);const frame=owner.advance(request(1)),image=frame.layouts.layout.nodes.find(n=>n.node==='image'),slice=frame.layouts.layout.nodes.find(n=>n.node==='slice');assert.equal(image.source.id,'new');assert.deepEqual(image.rect.slice(2),[32,24]);assert.deepEqual(slice.nSlice[0].uv,[0,0,4/32,4/24]);}finally{owner.dispose()}
});
test('clearing one font alias uses the remaining real prepared OpenType fallback',async()=>{
 const fixture=nullable(),layout=structuredClone(base.parts.find(value=>value.id==='layout').document);layout.assets.push({...structuredClone(layout.assets[0]),id:'font-two'});layout.textStyles[0].fontAssets=['font','font-two'];layout.artboards=[{id:'main',width:128,height:128,root:'root',nodes:[{id:'root',kind:'container',style:{display:'flex',direction:'column',width:fill,height:fill}},{id:'text',parent:'root',kind:'text',text:'label',style:{width:point(128),height:hug}}]}];layout.instances=[{id:'main',artboard:'main',fit:'fill',alignment:[0,0]}];fixture.parts[1].document=layout;fixture.targets[0].address=['font'];const data=fixture.parts[0].document;data.models[0].properties[0].kind='font';data.models[0].properties[0].defaultValue='font';data.instances[0].values.resource='font';const fonts=createCandidateOutlineFonts(layout),{owner}=await createCandidateComposition(fixture,options({fonts:new Map([['layout',fonts.fonts]])}));
 try{await pending(owner,0);owner.advance(request(0));owner.run(write=>write.set('root',['resource'],null));const cleared=owner.advance(request(1));assert.equal(owner.read('root',['resource']),null);assert.equal(cleared.layouts.layout.nodes.find(n=>n.node==='text').text.runs[0].font,'font-two');}finally{owner.dispose();assert.equal(fonts.stats().references,0);fonts.dispose()}
});
test('a failing second resource prevents a mixed data intent from clearing the first image',async()=>{
 const fixture=nullable(),data=fixture.parts[0].document,layout=fixture.parts[1].document;data.models[0].properties.push({id:'blob',kind:'blob',defaultValue:'wrong-kind'});data.instances[0].values.blob='wrong-kind';data.bindings.push({id:'blob',target:'blob-slot',targetPath:['value'],source:{mode:'explicit',instance:'root',path:['blob']},direction:'read'});fixture.targets.push({id:'blob-slot',part:'layout',kind:'asset',address:['wrong-kind']});layout.assets.push({id:'bad-blob',kind:'blob',source:{kind:'embedded',data:[0],integrity:integrity([7,8,9])}});const {owner}=await createCandidateComposition(fixture,options());let notifications=0;owner.subscribe(()=>notifications++);
 try{await pending(owner,0);const old=owner.advance(request(0));owner.run(write=>{write.set('root',['resource'],null);write.set('root',['blob'],'bad-blob')});await assert.rejects(pending(owner,1),e=>e.code==='E_LAYOUT_ASSET_INTEGRITY');assert.equal(owner.read('root',['resource']),'old');assert.equal(owner.read('root',['blob']),'wrong-kind');assert.equal(owner.lastFrame,old);assert.equal(notifications,0);}finally{owner.dispose()}
});

function dataOnly(values){
 const properties=[{id:'label',kind:'string',defaultValue:'default'},{id:'score',kind:'number',defaultValue:7},{id:'count',kind:'integer',defaultValue:2},{id:'enabled',kind:'boolean',defaultValue:true},{id:'color',kind:'color',defaultValue:[1,0,0,1]},{id:'child',kind:'model',model:'Child',defaultValue:'child'},{id:'items',kind:'list',item:{kind:'model',model:'Child'},defaultValue:['child']},...['image','font','artboard','blob'].map(kind=>({id:kind,kind,defaultValue:kind+'-default'}))].map(p=>({...p,nullable:true}));
 const document={format:'haiyue-data-binding',version:1,extension:'org.haiyue.data-binding@1',enums:[],models:[{id:'Child',properties:[{id:'name',kind:'string',defaultValue:'child'}]},{id:'Root',properties:[...properties,{id:'missing',kind:'string',defaultValue:'absent-default'},{id:'zero',kind:'number',defaultValue:99},{id:'false',kind:'boolean',defaultValue:true},{id:'empty',kind:'string',defaultValue:'non-empty'}]}],instances:[{id:'child',model:'Child',scope:'local',values:{}},{id:'root',model:'Root',scope:'local',values:{zero:0,false:false,empty:'',...values}}],bindings:[],converters:[],propertyGroups:[],components:[]};
 return{properties,source:{format:'haiyue-composition',version:1,parts:[part('data','org.haiyue.data-binding@1',document)],targets:[]}};
}
test('explicit null is preserved separately from absent defaults across all nullable data kinds',async()=>{
 const fixture=dataOnly({});fixture.source.parts[0].document.instances[1].values={zero:0,false:false,empty:'',...Object.fromEntries(fixture.properties.map(p=>[p.id,null]))};const {owner}=await createCandidateComposition(fixture.source,options());
 try{for(const property of fixture.properties)assert.equal(owner.read('root',[property.id]),null,property.id);assert.equal(owner.read('root',['missing']),'absent-default');assert.equal(owner.read('root',['zero']),0);assert.equal(owner.read('root',['false']),false);assert.equal(owner.read('root',['empty']),'');assert.throws(()=>owner.read('root',['child','name']),e=>e.code==='E_DATA_RUNTIME_PATH');}finally{owner.dispose()}
});
test('queued nullable primitive/model/list/resource writes survive rollback and publish the actual null once',async()=>{
 const fixture=dataOnly({});let fail=false,callbacks=0,notifications=0;const {owner}=await createCandidateComposition(fixture.source,options({host:{invalidate(){},draw(){if(fail)throw Error('later frame failed');return{commit(){},rollback(){}}}}}));owner.subscribe(()=>notifications++);
 try{owner.advance(request(0));owner.run(write=>{callbacks++;for(const property of fixture.properties)write.set('root',[property.id],null)});fail=true;assert.throws(()=>owner.advance(request(1)),/later frame failed/);for(const property of fixture.properties)assert.deepEqual(owner.read('root',[property.id]),property.defaultValue);assert.equal(notifications,0);fail=false;const frame=owner.advance(request(1));for(const property of fixture.properties)assert.equal(owner.read('root',[property.id]),null,property.id);assert.equal(callbacks,1);assert.equal(notifications,1);assert.equal(owner.advance(request(1)),frame);assert.equal(notifications,1);}finally{owner.dispose()}
});
