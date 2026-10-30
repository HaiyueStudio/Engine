import test from 'node:test';
import assert from 'node:assert/strict';
import {productionFontFixture} from './text-production-font-fixture.mjs';
import {productionLayoutWorkload,layoutMutationRequest} from '../../scripts/fixtures/hya-production/workloads.mjs';
test('G12 workloads retain G01 node counts, text ratio, geometry and mutation populations',()=>{
  const font=productionFontFixture();
  for(const count of [128,1000,10000]) {
    const document=productionLayoutWorkload(count,font.document),nodes=document.artboards[0].nodes;
    assert.equal(nodes.length,count);assert.equal(nodes.filter(n=>n.kind==='text').length,Math.round(count*.25));
    assert.ok(nodes.slice(1).every(n=>n.style.width.value===40&&n.style.height.value===24));
    for(const percent of [0,1,10])assert.equal(Object.keys(layoutMutationRequest(count,percent,1).strings??{}).length,Math.ceil(count*percent/100));
  }
});
