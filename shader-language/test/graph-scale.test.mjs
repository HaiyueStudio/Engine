import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseShaderGraphV1} from '../dist/index.js';
import {compileMaterialGraphDocumentV1} from '../dist/material-graph.js';

function chain(count){return{format:'haiyue-shader-graph',version:1,kind:'material',profile:'webgpu-portable',resources:[{id:'material.factor',space:'material',kind:'uniform',valueType:'f32',frequency:'material'}],nodes:Array.from({length:count},(_,i)=>({id:'N'+i,type:'haiyue.color.multiply',typeVersion:1,inputs:{left:i?{node:'N'+(i-1),output:'color'}:{literal:{type:'color3<f32>',value:[.99,.99,.99],colorSpace:'linear'}},right:{resource:'material.factor'}}})),outputs:{baseColor:{node:'N'+(count-1),output:'color'}}};}
const sha=value=>createHash('sha256').update(value).digest('hex');
test('graph locations identify actual node properties rather than metadata or quoted text',()=>{
 const graph=chain(2),text=JSON.stringify({metadata:{selection:{id:'N0'},note:'"nodes": [{"id":"N1"}]'},...graph},null,2);
 const parsed=parseShaderGraphV1(text),lines=text.split('\n');
 for(const node of parsed.nodes){const line=parsed.nodeLocations[node.id].line;assert.equal(lines[line-1].trim(),`"id": "${node.id}",`);assert.ok(line>text.slice(0,text.indexOf('  "nodes": [')).split('\n').length);}
});
test('escaped keys, CRLF and duplicate JSON properties keep final structural provenance',()=>{
 const text='{"nodes": [{"id":"obsolete"}], "metadata":{"id":"N0"}, "format":"haiyue-shader-graph", "version":1, "kind":"material", "profile":"webgpu-portable", "resources":[],\r\n"nodes":[{"metadata":{"id":"N0"}, "\\u0069d":"discarded",\r\n"id":"N0", "type":"haiyue.color.multiply", "typeVersion":1, "inputs":{}}],"outputs":{"baseColor":{"node":"N0","output":"color"}}}';
 const parsed=parseShaderGraphV1(text);assert.deepEqual(parsed.nodeLocations,{N0:{line:3,column:1}});
});
test('JSON provenance does not repeatedly split a growing document prefix per node',()=>{
 for(const count of [128,256,512,1024]){const text=JSON.stringify(chain(count),null,2),slice=String.prototype.slice;let prefixWork=0;
  try{String.prototype.slice=function(start,end){if(this.valueOf()===text&&start===0&&typeof end==='number')prefixWork+=end;return slice.call(this,start,end);};assert.equal(parseShaderGraphV1(text).nodes.length,count);}finally{String.prototype.slice=slice;}
  assert.ok(prefixWork<=text.length*2,`${count} nodes processed ${prefixWork} prefix characters for ${text.length} source characters`);
 }
});
test('iterative graph and IR traversal compiles a deep nonconstant chain through the public facade',()=>{
 const graph=chain(8192),result=compileMaterialGraphDocumentV1(graph);assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.equal(result.artifact.cost.nodeCount,8192);assert.match(result.artifact.source.code,/@fragment/);
 const fromJson=compileMaterialGraphDocumentV1(JSON.stringify(graph));assert.equal(fromJson.ok,true,JSON.stringify(fromJson.diagnostics));assert.equal(fromJson.artifact.canonicalHash,result.artifact.canonicalHash);assert.equal(fromJson.artifact.source.code,result.artifact.source.code);
});
test('a deep cycle retains the graph reference diagnostic rather than escaping through the JS stack',()=>{
 const graph=chain(8192);graph.nodes[0].inputs.left={node:'N8191',output:'color'};const result=compileMaterialGraphDocumentV1(graph);assert.equal(result.ok,false);assert.equal(result.diagnostics[0].code,'E_SHADER_GRAPH_REFERENCE_INVALID');assert.match(result.diagnostics[0].path,/^outputs\./);assert.match(result.diagnostics[0].message,/cycle/);
});
test('existing shader bytes, reflection and canonical identity remain stable',()=>{
 const golden=[[32,'6cded41c8793b9ae5a9a3b98fa078172cd3048b4684503876a6713874a8a7978','e5a616375530e64008f486e477d839dc729c3ac1f4ebd2dbbd5e894e44709ff8'],[512,'dc784a67d5bfa96325679afa5aa4fdc6b509f1b1f93b292cf3ad09605e75df78','a9dac598493c5db2f894f5c5685fa31c5cd672aae1c38f6622a85e82e72c6219']];
 for(const[count,canonical,source]of golden){const result=compileMaterialGraphDocumentV1(chain(count));assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.equal(result.artifact.canonicalHash,canonical);assert.equal(sha(result.artifact.source.code),source);assert.equal(sha(JSON.stringify(result.artifact.reflection)),'76caabcd511463617a0a637160656918a3e4643b9dc0880f2c0a05e92efbb6c3');}
});
