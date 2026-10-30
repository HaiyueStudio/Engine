import test from 'node:test';
import assert from 'node:assert/strict';
import {loadHyaProductionSource} from './helpers/hya-production-source.mjs';
import {responsiveLayoutFixture} from '../../extensions/test/responsive-layout-fixture.mjs';
import {dataBindingFixture,interactionFixture,semanticsFixture} from '../../extensions/test/data-binding-parity-fixture.mjs';
import {audioEventFixture} from '../../extensions/test/audio-event-parity-fixture.mjs';
import {stateMachineV2Fixture} from '../../extensions/test/state-machine-v2-parity-fixture.mjs';
import {AnimationExtensionRegistry} from '../dist/index.js';

const {spec}=await loadHyaProductionSource();
const {parseHyaComposition:parse,encodeHyaComposition:encode,negotiateHyaComposition:negotiate}=spec;
const core=()=>({format:'haiyue-animation',version:'1.0',canvas:{width:32,height:32,coordinateSystem:'screen-y-down'},duration:1,nodes:[{id:'node',components:[{type:'shape2d',shape:'rect',size:[8,8],fill:[1,0,0,1]}]}],tracks:[]});
const part=(id='scene')=>({id,extension:'org.haiyue.animation-core@1',required:true,requires:[],dependencies:[],document:core()});
const fixture=()=>({format:'haiyue-composition',version:1,parts:[part()],targets:[{id:'visible-node',part:'scene',kind:'animation-node',address:['node']}]});
const caps=new Set(['org.haiyue.animation-core@1']);
const error=(code,path)=>value=>value instanceof spec.HyaCompositionError&&value.code===code&&(!path||value.path===path);

test('composition round-trips deterministic UTF-8 JSON without changing old core/container data',()=>{
 const source=fixture(),first=encode(source),second=encode({targets:source.targets,parts:source.parts,version:1,format:source.format});
 assert.deepEqual(first,second);assert.deepEqual(parse(first).document,source);assert.deepEqual(parse(first.buffer).document,source);
 assert.deepEqual(parse(JSON.stringify(source)).document,source);assert.equal(Object.isFrozen(parse(source).document.parts[0].document),true);
 assert.equal(source.parts[0].document.nodes[0].id,'node');assert.equal(Object.isFrozen(source),false);
 const result=negotiate(source,caps);assert.equal(result.complete,true);assert.deepEqual(result.activeParts,['scene']);assert.deepEqual(result.targets,source.targets);
});
test('composition version, unknown fields, duplicate identities and target addresses fail precisely',()=>{
 for(const change of ['version','extra','duplicate','target','part','kind']){
  const source=fixture();if(change==='version')source.version=2;if(change==='extra')source.unexpected=true;
  if(change==='duplicate')source.parts.push(part());if(change==='target')source.targets[0].address=['missing'];if(change==='part')source.targets[0].part='missing';if(change==='kind')source.targets[0].kind='dom';
  assert.throws(()=>parse(source),value=>value instanceof spec.HyaCompositionError&&value.path.startsWith(change==='version'?'$.version':change==='extra'?'$.unexpected':change==='duplicate'?'$.parts[1]':'$.targets[0]'));
 }
});
test('unknown required extensions reject even in non-strict mode; optional skipping is explicit and lossless',()=>{
 const source=fixture();source.parts.push({...part('optional'),extension:'org.example.optional@1',required:false});
 assert.throws(()=>parse(source),error('E_HYA_COMPOSITION_OPTIONAL','$.parts[1].extension'));
 const options={strict:false},parsed=parse(source,options);assert.deepEqual(parsed.document,source);assert.equal(parsed.diagnostics[0].capability,'org.example.optional@1');
 const plan=negotiate(source,caps,options);assert.equal(plan.complete,false);assert.deepEqual(plan.activeParts,['scene']);assert.equal(plan.diagnostics.length,1);
 assert.deepEqual(parse(encode(source,options),options).document,source);
 source.parts[1].required=true;assert.throws(()=>parse(source,options),error('E_HYA_COMPOSITION_REQUIRED','$.parts[1].extension'));
});
test('known optional malformed documents fail rather than being silently skipped',()=>{
 const source=fixture();source.parts[0].required=false;source.parts[0].document.version='99';
 assert.throws(()=>parse(source,{strict:false}),value=>error('E_HYA_COMPOSITION_PART','$.parts[0].document.version')(value)&&value.causeCode==='E_ANIMATION_UNSUPPORTED_VERSION');
});
test('part dependencies are bounded, reference checked, cycle checked and topologically planned',()=>{
 const source=fixture();source.parts.unshift({...part('first'),dependencies:['scene']});assert.deepEqual(negotiate(source,caps).activeParts,['scene','first']);
 source.parts[1].dependencies=['first'];assert.throws(()=>parse(source),error('E_HYA_COMPOSITION_GRAPH'));
 source.parts[1].dependencies=['missing'];assert.throws(()=>parse(source),error('E_HYA_COMPOSITION_REFERENCE'));
});
test('host capability negotiation separates valid format from executable features',()=>{
 const source=fixture();source.parts[0].requires=['org.haiyue.production.real-glyphs@1'];parse(source);
 assert.throws(()=>negotiate(source,caps),error('E_HYA_COMPOSITION_CAPABILITY','$.parts[0].requires[0]'));
 const complete=new Set([...caps,'org.haiyue.production.real-glyphs@1']);assert.equal(negotiate(source,complete).complete,true);
 assert.throws(()=>negotiate(source,new Set()),error('E_HYA_COMPOSITION_CAPABILITY','$.parts[0].extension'));
});
test('optional capability loss skips dependants and their targets while required dependants fail',()=>{
 const source=fixture();source.parts[0].required=false;source.parts[0].requires=['org.example.missing@1'];source.parts.push({...part('dependent'),required:false,dependencies:['scene']});
 const options={strict:false},plan=negotiate(source,caps,options);assert.deepEqual(plan.activeParts,[]);assert.deepEqual(plan.targets,[]);assert.equal(plan.diagnostics.length,2);
 source.parts[1].required=true;assert.throws(()=>negotiate(source,caps,options),error('E_HYA_COMPOSITION_REFERENCE','$.parts[1].dependencies'));
});
test('untrusted object graph is checked before validators: cycles, accessors, prototypes and hidden values',()=>{
 let calls=0,reads=0;const validators=new Map([['org.example.safe@1',()=>calls++]]);
 for(const invalid of [NaN,Infinity,undefined,()=>{},Symbol(),new Date(),new Uint8Array(1)]){
  const source=fixture();source.parts[0].document=invalid;assert.throws(()=>parse(source,{validators}),error('E_HYA_COMPOSITION_FORMAT'));
 }
 const cyclic=fixture();cyclic.parts[0].document=cyclic;assert.throws(()=>parse(cyclic,{validators}),error('E_HYA_COMPOSITION_FORMAT'));
 const accessor=fixture();Object.defineProperty(accessor.parts[0].document,'getter',{enumerable:true,get(){reads++;return 1;}});assert.throws(()=>parse(accessor,{validators}),error('E_HYA_COMPOSITION_FORMAT'));
 const hidden=fixture();Object.defineProperty(hidden,'secret',{value:1});assert.throws(()=>parse(hidden,{validators}),error('E_HYA_COMPOSITION_FORMAT'));
 const pollution=JSON.parse('{"format":"haiyue-composition","version":1,"parts":[],"targets":[],"__proto__":{"polluted":true}}');assert.throws(()=>parse(pollution),error('E_HYA_COMPOSITION_FORMAT'));
 assert.equal(reads,0);assert.equal(calls,0);assert.equal({}.polluted,undefined);
});
test('sparse arrays and extra array properties are rejected before canonical encoding',()=>{
 for(const mode of ['hole','extra','getter']){
  const source=fixture();if(mode==='hole')source.parts.length=2;if(mode==='extra')source.parts.extra=true;
  if(mode==='getter')Object.defineProperty(source.parts,'0',{get(){assert.fail('Accessor executed');},enumerable:true});
  assert.throws(()=>parse(source),error('E_HYA_COMPOSITION_FORMAT'));
 }
});
test('UTF-8, string, exact JSON byte, depth, node and part hard ceilings cannot be relaxed',()=>{
 assert.throws(()=>parse(new Uint8Array([0xc0,0xaf])),error('E_HYA_COMPOSITION_FORMAT','$'));
 assert.throws(()=>parse('{'),error('E_HYA_COMPOSITION_FORMAT','$'));
 for(const limits of [{maxInputBytes:1},{maxStringBytes:4},{maxDepth:3},{maxJsonNodes:5}])assert.throws(()=>parse(fixture(),{limits}),error('E_HYA_COMPOSITION_LIMIT'));
 for(const limits of [{maxParts:17},{maxDepth:129},{maxParts:0},{maxParts:NaN},{wrong:1}])assert.throws(()=>parse(fixture(),{limits}),error('E_HYA_COMPOSITION_LIMIT'));
 const source=fixture();source.parts.push(part('second'));assert.throws(()=>parse(source,{limits:{maxParts:1}}),error('E_HYA_COMPOSITION_LIMIT','$.parts'));
 const size=encode(fixture()).byteLength;assert.equal(encode(fixture(),{limits:{maxInputBytes:size}}).byteLength,size);assert.throws(()=>encode(fixture(),{limits:{maxInputBytes:size-1}}),error('E_HYA_COMPOSITION_LIMIT'));
});
test('canonical strings retain quotes, controls, astral Unicode and lone surrogate values',()=>{
 const source=fixture();source.parts[0].document.name='"\\\n😀\ud800';assert.equal(parse(encode(source)).document.parts[0].document.name,source.parts[0].document.name);
 const size=encode(source).byteLength;assert.doesNotThrow(()=>encode(source,{limits:{maxInputBytes:size}}));assert.throws(()=>encode(source,{limits:{maxInputBytes:size-1}}),error('E_HYA_COMPOSITION_LIMIT'));
});
test('trusted extension validators cannot override frozen built-ins and never imply host execution',()=>{
 const source=fixture();source.parts[0].extension='org.example.future@1';let calls=0;const options={validators:new Map([['org.example.future@1',()=>calls++]])};source.targets=[];
 parse(source,options);assert.equal(calls,1);assert.throws(()=>negotiate(source,caps,options),error('E_HYA_COMPOSITION_CAPABILITY'));
 assert.throws(()=>parse(fixture(),{validators:new Map([['org.haiyue.animation-core@1',()=>{}]])}),error('E_HYA_COMPOSITION_FORMAT','$options.validators'));
});
test('part validation receives an immutable copy and cannot inject unvalidated values',()=>{
 const source=fixture();source.parts[0].extension='org.example.immutable@1';source.targets=[];
 const options={validators:new Map([['org.example.immutable@1',document=>{assert.equal(Object.isFrozen(document),true);document.injected=()=>{};}]])};
 assert.throws(()=>parse(source,options),error('E_HYA_COMPOSITION_PART','$.parts[0].document'));
 assert.equal(source.parts[0].document.injected,undefined);
});
test('existing sidecars validate together and typed aliases resolve without a runtime qualification claim',()=>{
 const source=fixture(),layout=responsiveLayoutFixture(),data=dataBindingFixture(),interaction=interactionFixture(),semantics=semanticsFixture(),audio=audioEventFixture(),state=stateMachineV2Fixture();
 const add=(id,extension,document,dependencies=[])=>source.parts.push({id,extension,required:true,requires:[],dependencies,document});
 add('layout','org.haiyue.layout-2d@1',layout);add('data','org.haiyue.data-binding@1',data,['scene']);add('interaction','org.haiyue.interaction@1',interaction);add('semantics','org.haiyue.semantics@1',semantics);add('audio','org.haiyue.audio-events@1',audio);add('state','org.haiyue.animation-state-machine@2',state);
 const aliases=[...new Set(data.bindings.map(binding=>binding.target))];
 for(const name of aliases){source.parts[0].document.nodes.push({id:name});source.targets.push({id:name,part:'scene',kind:'animation-node',address:[name]});}
 source.targets.push({id:'layout-node',part:'layout',kind:'layout-node',address:[layout.artboards[0].id,layout.artboards[0].nodes[0].id]},{id:'text-block',part:'layout',kind:'text-block',address:[layout.textBlocks[0].id]},{id:'font',part:'layout',kind:'asset',address:[layout.assets[0].id]},
  {id:'state-input',part:'state',kind:'state-input',address:[state.stateMachines[0].id,state.stateMachines[0].inputs[0].id]},{id:'interaction-target',part:'interaction',kind:'interaction-target',address:[interaction.targets[0].id]},{id:'semantic-node',part:'semantics',kind:'semantic-node',address:[semantics.nodes[0].id]},{id:'audio-cue',part:'audio',kind:'audio-cue',address:[audio.cues[0].id]});
 const capabilities=new Set(source.parts.map(p=>p.extension));assert.equal(negotiate(source,capabilities).activeParts.length,7);assert.deepEqual(parse(encode(source)).document,source);
 source.targets.find(target=>target.kind==='state-input').address[1]='missing';assert.throws(()=>parse(source),error('E_HYA_COMPOSITION_REFERENCE'));
});
test('data bindings cannot reference undeclared aliases or skipped implicit dependencies',()=>{
 const source=fixture(),data=dataBindingFixture();source.parts.push({id:'data',extension:'org.haiyue.data-binding@1',required:true,requires:[],dependencies:[],document:data});
 assert.throws(()=>parse(source),error('E_HYA_COMPOSITION_REFERENCE','$.parts[1].document.bindings[0].target'));
 for(const target of new Set(data.bindings.map(binding=>binding.target)))source.targets.push({id:target,part:'scene',kind:'animation-node',address:['node']});
 assert.throws(()=>parse(source),error('E_HYA_COMPOSITION_GRAPH','$.parts[1].dependencies'));source.parts[1].dependencies=['scene'];assert.doesNotThrow(()=>parse(source));
});
test('legacy required core extensions retain their existing registry and error code',()=>{
 const source=fixture(),id='org.example.core@1',document=source.parts[0].document;document.extensionsUsed=[id];document.extensionsRequired=[id];document.extensions={[id]:{value:1}};
 assert.throws(()=>parse(source),value=>value.causeCode==='E_ANIMATION_MISSING_EXTENSION');
 const registry=new AnimationExtensionRegistry();let calls=0;const off=registry.register({id,validateDocument(){calls++;}});assert.doesNotThrow(()=>parse(source,{coreExtensions:registry}));assert.equal(calls,1);off();assert.throws(()=>parse(source,{coreExtensions:registry}),value=>value.causeCode==='E_ANIMATION_MISSING_EXTENSION');
});
test('legacy HYLA bytes stay deterministic and malformed old sidecar versions remain rejected',()=>{
 const layout=responsiveLayoutFixture(),bytes=spec.encodeResponsiveLayoutDocument(layout);assert.equal(spec.isResponsiveLayoutBinary(bytes),true);assert.deepEqual(new Uint8Array(bytes),new Uint8Array(spec.encodeResponsiveLayoutDocument(layout)));
 assert.equal(spec.decodeResponsiveLayoutDocument(bytes).version,1);const wrong=bytes.slice(0);new DataView(wrong).setUint16(4,2,true);assert.throws(()=>spec.decodeResponsiveLayoutDocument(wrong),value=>value.code==='E_LAYOUT_BINARY');
 for(const [parse,document]of [[spec.parseHyaDataBinding,dataBindingFixture()],[spec.parseHyaInteraction,interactionFixture()],[spec.parseHyaSemantics,semanticsFixture()],[spec.parseHyaAudioEvents,audioEventFixture()]]){document.version=2;assert.throws(()=>parse(document),value=>typeof value.code==='string'&&value.path==='$.version');}
});
test('segmented aliases retain identifiers containing separators and Unicode',()=>{
 const source=fixture();source.parts[0].id='scene/一';source.parts[0].document.nodes[0].id='node/一';source.targets[0]={id:'view/一',part:'scene/一',kind:'animation-node',address:['node/一']};assert.deepEqual(parse(encode(source)).document,source);
});

test('many aliases resolve a large validated node table without changing limits or losing reference errors',()=>{
 const source=fixture();source.parts[0].document.nodes=Array.from({length:2000},(_,i)=>({id:'node-'+i}));
 source.targets=Array.from({length:12000},(_,i)=>({id:'alias-'+i,part:'scene',kind:'animation-node',address:['node-'+(i%2000)]}));
 assert.equal(parse(source).document.targets.length,12000);
 assert.throws(()=>parse(source,{limits:{maxTargets:11999}}),error('E_HYA_COMPOSITION_LIMIT','$.targets'));
 source.targets.at(-1).address=['missing'];assert.throws(()=>parse(source),error('E_HYA_COMPOSITION_REFERENCE','$.targets[11999].address'));
});
