import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProductionDrawCandidate} from './layout-production-draw-fixture.mjs';

const candidate = await buildProductionDrawCandidate({composition:true});
const {ProductionCompositionDrawAdapter, ProductionDrawOwner} = await candidate.load();
const node = color => Object.freeze({part:'layout', instance:'root', artboard:'main', node:'box', kind:'leaf',
  rect:[0,0,40,24], opacity:1, background:color, borderWidth:[0,0,0,0], cornerRadius:[0,0,0,0]});
const frame = (revision, nodes, viewport = [128,128], dpr = 1) => ({layouts:{layout:{revision,nodes,viewport,dpr,instances:[]}}});
const commit = step => {step.commit(); step.finalize?.();};

test('advancing a static composition clock preserves its committed draw generation', () => {
  const draw = new ProductionDrawOwner({}), adapter = new ProductionCompositionDrawAdapter(draw, [{id:'layout',kind:'layout'}]);
  const nodes = Object.freeze([node([1,0,0,1])]);
  try {
    commit(adapter.prepare(frame(1,nodes),new Map())); const first = draw.stats.generation;
    for (let revision=2;revision<=43;revision++) commit(adapter.prepare(frame(revision,nodes),new Map()));
    assert.equal(draw.stats.generation,first,'layout timing metadata must not rebuild identical immutable paint');
    assert.equal(draw.stats.retainedGenerations,1);
  } finally {draw.dispose();}
  assert.equal(draw.stats.retainedGenerations,0);
});

test('paint, viewport, DPR and texture revisions invalidate independently; rolled-back preparation preserves old paint', () => {
  const textures = {revision:0}, draw = new ProductionDrawOwner({});
  const adapter = new ProductionCompositionDrawAdapter(draw,[{id:'layout',kind:'layout'}],textures);
  let nodes = Object.freeze([node([1,0,0,1])]);
  try {
    commit(adapter.prepare(frame(1,nodes),new Map())); let generation=draw.stats.generation;
    const pending=adapter.prepare(frame(2,Object.freeze([node([0,1,0,1])])),new Map()); pending.rollback();
    assert.equal(draw.stats.generation,generation);
    commit(adapter.prepare(frame(3,nodes),new Map())); assert.equal(draw.stats.generation,generation);
    for (const input of [frame(4,nodes=Object.freeze([node([0,0,1,1])])),frame(5,nodes,[256,128]),frame(6,nodes,[256,128],2)]) {
      commit(adapter.prepare(input,new Map())); assert.ok(draw.stats.generation>generation); generation=draw.stats.generation;
    }
    textures.revision++; commit(adapter.prepare(frame(7,nodes,[256,128],2),new Map())); assert.ok(draw.stats.generation>generation);
  } finally {draw.dispose();}
  assert.equal(draw.stats.retainedGenerations,0);
});
