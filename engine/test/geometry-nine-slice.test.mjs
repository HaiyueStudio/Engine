import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../..',import.meta.url));
execFileSync(process.execPath,[fileURLToPath(new URL('../../node_modules/typescript/bin/tsc',import.meta.url)),
 '--target','ES2022','--module','ESNext','--moduleResolution','bundler','--strict','--noUncheckedIndexedAccess','--skipLibCheck',
 '--outDir','artifacts/engine-0.2.2/g07/geometry-compiled','engine/src/geometry/NineSlice.ts'],{cwd:root,stdio:'pipe'});
const {computeNineSlicePatches:slice}=await import('../../artifacts/engine-0.2.2/g07/geometry-compiled/NineSlice.js');
const options={width:120,height:80,sourceWidth:40,sourceHeight:30,cuts:[8,6,12,4]};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('corners retain source size, edges stretch in one axis and center stretches in both',()=>{
 const p=slice(options);assert.equal(p.length,9);
 assert.deepEqual(p[0].rect,{x:0,y:0,width:8,height:6});
 assert.deepEqual(p[4].rect,{x:8,y:6,width:100,height:70});
 assert.deepEqual(p[8].rect,{x:108,y:76,width:12,height:4});
 assert.deepEqual(p[4].sourceRect,[8,6,20,20]);
 assert.equal(Object.isFrozen(p),true);assert.equal(Object.isFrozen(p[4].rect),true);assert.equal(Object.isFrozen(p[4].uv),true);
});

test('small and zero destinations proportionally shrink opposite borders without overlap or negative patches',()=>{
 for(const [width,height]of [[10,5],[0,0],[20,10],[19.5,9.5]]){
  const p=slice({...options,width,height});
  for(const x of p)assert.ok(x.rect.width>=0&&x.rect.height>=0);
  close(p[0].rect.width+p[1].rect.width+p[2].rect.width,width);
  close(p[0].rect.height+p[3].rect.height+p[6].rect.height,height);
  if(width<20){close(p[0].rect.width/8,p[2].rect.width/12);close(p[1].rect.width,0);}
 }
});

test('zero-width source center still anchors opposite borders to the destination edges',()=>{
 const p=slice({...options,sourceWidth:20,sourceHeight:10});
 assert.equal(p[4].rect.width,100);assert.equal(p[4].rect.height,70);
 assert.deepEqual(p[8].rect,{x:108,y:76,width:12,height:4});
 assert.deepEqual(p[4].sourceRect,[8,6,0,0]);
});

test('atlas UVs preserve border samples and fractional logical coordinates stay continuous at any DPR',()=>{
 for(const dpr of [1,1.25,1.5,2,3]){
  const p=slice({...options,width:123.4,height:78.9,uv:[.25,.125,.5,.75]});
  p[0].uv.forEach((value,index)=>close(value,[.25,.125,.1,.15][index]));
  for(let row=0;row<3;row++)for(let col=0;col<2;col++)close((p[row*3+col].rect.x+p[row*3+col].rect.width)*dpr,p[row*3+col+1].rect.x*dpr);
  close((p[8].rect.x+p[8].rect.width)*dpr,123.4*dpr);
 }
});

test('arbitrary paired stretch regions preserve legacy HYA alternating fixed/stretch distribution',()=>{
 const p=slice({width:150,height:20,sourceWidth:100,sourceHeight:10,xCuts:[10,30,50,90],yCuts:[]});
 assert.deepEqual(p.map(p=>p.rect.width),[10,110/3,20,220/3,10]);
 assert.deepEqual(p.map(p=>p.sourceRect),[[0,0,10,10],[10,0,20,10],[30,0,20,10],[50,0,40,10],[90,0,10,10]]);
 const small=slice({width:20,height:0,sourceWidth:100,sourceHeight:10,xCuts:[10,30,50,90],yCuts:[]});
 assert.deepEqual(small.map(p=>p.rect.width),[5,0,10,0,5]);
});

test('invalid dimensions, borders, cuts, UVs and patch allocations reject before a result is published',()=>{
 for(const bad of [{width:NaN},{height:-1},{sourceWidth:0},{cuts:[30,0,20,0]},{cuts:[1,2,3]},{uv:[.8,0,.4,1]},{uv:[0,0,Infinity,1]},{maxPatches:8}])assert.throws(()=>slice({...options,...bad}),RangeError);
 for(const xCuts of [[20],[30,20],[0,110],[NaN,2]])assert.throws(()=>slice({width:10,height:10,sourceWidth:100,sourceHeight:100,xCuts,yCuts:[]}),RangeError);
 assert.throws(()=>slice({...options,xCuts:[]}),RangeError);
 assert.throws(()=>slice({width:10,height:10,sourceWidth:10,sourceHeight:10}),RangeError);
 assert.deepEqual(slice(options)[0].rect,{x:0,y:0,width:8,height:6});
});
