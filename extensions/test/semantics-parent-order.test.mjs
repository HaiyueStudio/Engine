import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHyaSemantics} from '@haiyue/animation-spec/hya-production';
import {importAnimationSource} from './helpers/private-animation-source.mjs';
const {SemanticsRuntime}=await importAnimationSource('animation/interaction/SemanticsRuntime.ts');
const {createProductionSemantics}=await importAnimationSource('animation/production/createProductionSemantics.ts');
const document=nodes=>parseHyaSemantics({format:'haiyue-semantics',version:1,extension:'org.haiyue.semantics@1',nodes,reducedMotion:{mode:'ignore'}});
const parent={id:'parent',target:'group',role:'group',state:{hidden:{kind:'binding',binding:'hide'}},readingOrder:10,navigationOrder:10};
const child={id:'child',parent:'parent',target:'button',role:'button',label:{kind:'binding',binding:'label'},live:'polite',actions:['tap'],readingOrder:0,navigationOrder:0};
const grandchild={id:'grandchild',parent:'child',target:'leaf',role:'button',actions:['tap'],readingOrder:1,navigationOrder:1};
function permutations(values){return values.length<2?[values]:values.flatMap((v,i)=>permutations(values.filter((_,j)=>i!==j)).map(rest=>[v,...rest]));}

test('every valid author-array order suppresses descendants and rejects actions under a hidden ancestor',()=>{
  for(const nodes of permutations([parent,child,grandchild])) {
    let hidden=true,emit;const actions=[];
    const owner=createProductionSemantics(document(nodes),{bindings:{readBinding:id=>id==='hide'?hidden:'Ready'},action:(...args)=>actions.push(args),host:{update(){},subscribeActions(cb){emit=cb;return {unsubscribe(){}};}}});
    const frame={revision:1,geometry:{group:[0,0,100,100],button:[0,0,20,20],leaf:[0,0,10,10]}};
    const first=owner.update(frame);assert.deepEqual(first.nodes,[]);assert.deepEqual(first.navigationOrder,[]);assert.throws(()=>emit('child','tap'));assert.throws(()=>emit('grandchild','tap'));assert.deepEqual(actions,[]);
    hidden=false;const shown=owner.update({...frame,revision:2});assert.deepEqual(shown.readingOrder,['child','grandchild','parent']);assert.deepEqual(shown.navigationOrder,['child','grandchild']);emit('child','tap');assert.deepEqual(actions,[['button','tap']]);
    hidden=true;assert.deepEqual(owner.update({...frame,revision:3}).nodes,[]);assert.throws(()=>emit('child','tap'));owner.dispose();
  }
});

test('checkpoint restore preserves prior visibility, revision, actions and live-announcement baseline',()=>{
  let hidden=false,label='Before';const publications=[],actions=[];
  const runtime=new SemanticsRuntime(document([grandchild,child,parent]),{read:id=>id==='hide'?hidden:label},{update:value=>publications.push(value)},{invoke:(...args)=>actions.push(args)});
  const first=runtime.snapshot,checkpoint=runtime.captureFrame();hidden=true;runtime.update();assert.deepEqual(runtime.snapshot.nodes,[]);runtime.restoreFrame(checkpoint);assert.equal(runtime.snapshot,first);assert.equal(runtime.stats.revision,first.revision);
  hidden=false;label='After';const next=runtime.update();assert.deepEqual(next.announcements,[{node:'child',mode:'polite',text:'After'}]);runtime.perform('child','tap');assert.deepEqual(actions,[['button','tap']]);
  const committed=runtime.captureFrame();runtime.releaseFrame(committed);assert.throws(()=>runtime.restoreFrame(committed));runtime.dispose();
});
