import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAnimation, encodeAnimationBinary} from '../dist/index.js';

const path = (values = [0,0,10,0,0,10]) => ({type:'path2d',commands:'MLLZ',values,fill:[1,0,0,1]});
const morph = () => ({type:'org.haiyue.vector-path-morph@1',commands:'MLLZ',times:[0,1],values:[0,0,10,0,0,10,0,0,20,0,0,20],valueSize:6,interpolation:'linear',fill:[1,0,0,1]});
const vector = () => ({type:'org.haiyue.vector-shape@1',commands:'MLLZ',values:[0,0,10,0,0,10],morph:{times:[0,1],values:[0,0,10,0,0,10,0,0,20,0,0,20],valueSize:6,interpolation:'linear'},fill:{kind:'solid',color:[1,0,0,1]}});
const document = components => ({format:'haiyue-animation',version:'1.0',canvas:{width:32,height:32,coordinateSystem:'screen-y-down'},duration:1,
  nodes:[{id:'node',components}],tracks:[],extensionsUsed:[...new Set(components.filter(c=>c.type.startsWith('org.')).map(c=>c.type))]});

function allocations(run) {
  const Original = globalThis.Float32Array, lengths = [];
  globalThis.Float32Array = new Proxy(Original, {construct(target,args) {
    // ArrayBuffer-backed views do not allocate a new float pool.
    if (!(args[0] instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && args[0] instanceof SharedArrayBuffer)) lengths.push(typeof args[0] === 'number' ? args[0] : args[0]?.length ?? 0);
    return Reflect.construct(target,args);
  }});
  try {run(); return lengths;} finally {globalThis.Float32Array = Original;}
}
const limited = error => error.code === 'E_ANIMATION_LIMIT_EXCEEDED' && error.path === '$.nodes[0].components';

test('path limits reject before allocating an oversized author array', () => {
  const count = 12000, component = path(new Array(count).fill(0));component.commands = 'M'+'L'.repeat(count/2-1)+'Z';
  const lengths = allocations(() => assert.throws(() => parseAnimation(document([component]),{maxPathValues:6}),limited));
  assert.deepEqual(lengths,[]);
});

test('aggregate path budget is consumed before the next component copy in JSON and compact binary', () => {
  const input = document([path(),path()]), binary = encodeAnimationBinary(input);
  for (const source of [input,binary]) {
    const lengths = allocations(() => assert.throws(() => parseAnimation(source,{maxPathValues:6,copyFloatData:true}),limited));
    assert.deepEqual(lengths,[6]);
  }
});

for (const make of [morph,vector]) test(`${make.name} preflights all coordinate lengths before any float copy`, () => {
  const input = document([make()]), binary = encodeAnimationBinary(input);
  const budget = make === morph ? 6 : 17;
  for (const source of [input,binary]) assert.deepEqual(allocations(() => assert.throws(() => parseAnimation(source,{maxPathValues:budget,copyFloatData:true}),limited)),[]);
});

test('malformed morph times and cubic easings reject before their oversized arrays are converted', () => {
  const times = morph();times.times = new Array(12000).fill(0);
  const easings = morph();easings.interpolation = 'cubic-bezier';easings.easings = new Array(12000).fill(0);
  for (const [component,field] of [[times,'values'],[easings,'easings']]) {
    const lengths = allocations(() => assert.throws(() => parseAnimation(document([component])),error=>error.code==='E_ANIMATION_INVALID_FORMAT'&&error.path===`$.nodes[0].components[0].${field}`));
    assert.deepEqual(lengths,[]);
  }
  const nested = vector();nested.morph.times = new Array(12000).fill(0);
  assert.equal(allocations(() => assert.throws(() => parseAnimation(document([nested])),error=>error.path==='$.nodes[0].components[0].morph.values')).includes(12000),false);
});

test('small paint-array ceilings are checked before gradient and dash allocation', () => {
  const gradient = vector();delete gradient.morph;gradient.fill={kind:'linear-gradient',start:[0,0],end:[1,1],stops:new Array(12000).fill(0)};
  const dashed = vector();delete dashed.morph;dashed.stroke={color:[1,1,1,1],width:1,lineCap:'butt',lineJoin:'miter',miterLimit:4,dash:new Array(12000).fill(1)};
  for(const component of [gradient,dashed]) assert.equal(allocations(()=>assert.throws(()=>parseAnimation(document([component])))).includes(12000),false);
});

test('exact coordinate budget preserves typed-array ownership and copyFloatData', () => {
  const component=morph();component.times=new Float32Array(component.times);component.values=new Float32Array(component.values);
  const input=document([component]),borrowed=parseAnimation(input,{maxPathValues:12}).nodes[0].components[0],copied=parseAnimation(input,{maxPathValues:12,copyFloatData:true}).nodes[0].components[0];
  assert.equal(borrowed.values,component.values);assert.equal(borrowed.times,component.times);
  assert.notEqual(copied.values,component.values);assert.notEqual(copied.times,component.times);
  assert.deepEqual([...copied.values],[...component.values]);
});

test('regular track aggregate keyframe limits precede copies in both codecs', () => {
  const input=document([]);input.tracks=[{node:'node',property:'rotation',interpolation:'linear',times:[0,.5,1],values:[0,1,2]}];
  const binary=encodeAnimationBinary(input);
  for(const source of [input,binary]) assert.deepEqual(allocations(()=>assert.throws(()=>parseAnimation(source,{maxKeyframes:2,copyFloatData:true}),error=>error.code==='E_ANIMATION_LIMIT_EXCEEDED'&&error.path==='$.tracks[0].times')),[]);
});

test('regular malformed value/tangent lengths are rejected before large copies',()=>{
  const input=document([]);input.tracks=[{node:'node',property:'position',interpolation:'linear',times:[0,1],values:new Array(12000).fill(0)}];
  assert.deepEqual(allocations(()=>assert.throws(()=>parseAnimation(input),error=>error.path==='$.tracks[0].values')),[2]);
  input.tracks[0].values=[0,0,1,1];input.tracks[0].spatialTangents=new Array(12000).fill(0);
  assert.deepEqual(allocations(()=>assert.throws(()=>parseAnimation(input),error=>error.path==='$.tracks[0].spatialTangents')),[2]);
});
