import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {loadResponsiveLayoutModules,responsiveLayoutFixture} from './responsive-layout-fixture.mjs';
import {documentFor} from '../../scripts/fixtures/layout-contracts/cases.mjs';
const baseline=JSON.parse(readFileSync(new URL('./shared-layout-hya-baseline.json',import.meta.url),'utf8'));
const {spec,runtime}=await loadResponsiveLayoutModules();
test('64 frozen legacy cases preserve HYA units, edge order, fill/fraction, ratio, RTL, hidden and Grid placement',()=>{
  assert.equal(baseline.cases.length,64);assert.equal(baseline.referenceRevision,'7d0df288285834e2583f563478f322fdf6743c09');
  const differences=[];
  for(const c of baseline.cases){
    const evaluator=new runtime.LayoutEvaluator(spec.parseResponsiveLayoutDocument(documentFor(responsiveLayoutFixture(),c)));
    try{
      const nodes=evaluator.evaluate({viewport:[c.width,c.height],dpr:1,time:0}).nodes;
      assert.deepEqual(nodes.map(n=>n.nodeId),c.expected.map(n=>n.nodeId),c.id+' stable tree/visual traversal');
      for(let i=0;i<nodes.length;i++)for(const k of ['x','y','width','height'])if(Math.abs(nodes[i].rect[k]-c.expected[i].rect[k])>1e-9)differences.push({case:c.id,node:nodes[i].nodeId,axis:k,actual:nodes[i].rect[k],expected:c.expected[i].rect[k]});
    }finally{evaluator.dispose();}
  }
  assert.deepEqual(differences,[]);
});
test('legacy large spans do not acquire the unrelated GUI occupancy budget',()=>{
  const c={width:202,height:101,root:{display:'grid',gridColumns:Array.from({length:101},()=>({min:{unit:'fraction',value:1}})),gridRows:Array.from({length:101},()=>({min:{unit:'fraction',value:1}}))},children:[{id:'a',parent:'root',kind:'leaf',style:{gridPlacement:{column:0,row:0,columnSpan:101,rowSpan:101}}}]};
  const evaluator=new runtime.LayoutEvaluator(spec.parseResponsiveLayoutDocument(documentFor(responsiveLayoutFixture(),c)));
  try{const rect=evaluator.evaluate({viewport:[202,101],dpr:1,time:0}).nodes.find(n=>n.nodeId==='a').rect;assert.ok(Math.abs(rect.width-202)<1e-9);assert.ok(Math.abs(rect.height-101)<1e-9);}
  finally{evaluator.dispose();}
});
