import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAnimation, encodeAnimationBinary} from '../dist/index.js';

function chain(count) {
  return {format:'haiyue-animation',version:'1.0',canvas:{width:1,height:1,coordinateSystem:'screen-y-down'},duration:1,
    nodes:Array.from({length:count},(_,i)=>({id:'n'+i,...(i+1<count?{composite:{kind:'mask',source:'n'+(i+1),mode:'alpha'}}:{})})),tracks:[]};
}
function rewrite(buffer, update) {
  const header=new DataView(buffer),offset=header.getUint32(8,true),length=header.getUint32(12,true),floats=header.getUint32(20,true);
  const metadata=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,offset,length)));update(metadata);
  const bytes=new TextEncoder().encode(JSON.stringify(metadata)),floatOffset=(offset+bytes.length+3)&~3,result=new ArrayBuffer(floatOffset+floats*4);
  new Uint8Array(result,0,24).set(new Uint8Array(buffer,0,24));const out=new DataView(result);out.setUint32(12,bytes.length,true);out.setUint32(16,floatOffset,true);
  new Uint8Array(result,offset,bytes.length).set(bytes);new Uint8Array(result,floatOffset,floats*4).set(new Uint8Array(buffer,header.getUint32(16,true),floats*4));return result;
}
// Reverse source order before encoding so an old recursive validator can produce the oracle too.
function binaryChain(count) {
  const doc=chain(count);doc.nodes.reverse();
  return rewrite(encodeAnimationBinary(doc),metadata=>{metadata[8].reverse();for(const node of metadata[8])if(node[6]!==0)node[6][1]=count-1-node[6][1];});
}
for(const count of [100,20000])for(const kind of ['json','binary'])test(`${kind} accepts an acyclic ${count}-node composite chain within existing limits`,()=>{
  const source=kind==='json'?JSON.stringify(chain(count)):binaryChain(count),parsed=parseAnimation(source);
  assert.equal(parsed.nodes.length,count);assert.equal(parsed.nodes[0].composite.source,'n1');assert.equal(parsed.nodes.at(-1).id,'n'+(count-1));
});
for(const kind of ['json','binary'])test(`${kind} reports a deep cycle with a structured format error`,()=>{
  const count=20000;let source;
  if(kind==='json'){const doc=chain(count);doc.nodes.at(-1).composite={kind:'mask',source:'n0',mode:'alpha'};source=JSON.stringify(doc);}
  else source=rewrite(binaryChain(count),metadata=>{metadata[8].at(-1)[6]=[...metadata[8][0][6]];metadata[8].at(-1)[6][1]=0;});
  assert.throws(()=>parseAnimation(source),error=>!(error instanceof RangeError)&&typeof error.code==='string'&&error.code.startsWith('E_ANIMATION_')&&/cycle/.test(error.message)&&typeof error.path==='string');
});
test('deep graph traversal preserves reference, byte and node-count rejection',()=>{
  const doc=chain(100);doc.nodes.at(-1).composite={kind:'mask',source:'missing',mode:'alpha'};
  assert.throws(()=>parseAnimation(JSON.stringify(doc)),error=>error.path==='$.nodes[99].composite.source');
  for(const source of [JSON.stringify(chain(100)),binaryChain(100)]){
    assert.throws(()=>parseAnimation(source,{maxNodes:99}),error=>error.code==='E_ANIMATION_LIMIT_EXCEEDED');
    assert.throws(()=>parseAnimation(source,{maxInputBytes:10}),error=>error.code==='E_ANIMATION_LIMIT_EXCEEDED');
  }
});
