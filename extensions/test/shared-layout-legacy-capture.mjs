import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {loadResponsiveLayoutModules,responsiveLayoutFixture} from './responsive-layout-fixture.mjs';
import {cases,documentFor} from '../../scripts/fixtures/layout-contracts/cases.mjs';

const {spec,runtime}=await loadResponsiveLayoutModules();
const observations=[];
for(const c of cases){
  const evaluator=new runtime.LayoutEvaluator(spec.parseResponsiveLayoutDocument(documentFor(responsiveLayoutFixture(),c)));
  try{observations.push({id:c.id,request:{viewport:[c.width,c.height],dpr:1,time:0},evaluation:evaluator.evaluate({viewport:[c.width,c.height],dpr:1,time:0})});}
  finally{evaluator.dispose();}
}
for(const [index,request] of [
  {viewport:[320,180],dpr:1,time:0},
  {viewport:[640,360],dpr:2,time:0.75,strings:{inputText:'AB'},lists:{items:Array.from({length:20},(_,id)=>({id}))},scroll:{'stage/list':{offset:[0,44],settled:true},'stage/scroller':{offset:[47,0],settled:true}}},
  {viewport:[200,100],dpr:1,time:0.5,componentReplacements:{'stage/component':'alternate'},componentInputs:{'stage/component':{phase:0.75,mix:0.2}},lists:{items:[{id:'x'}]}}
].entries()){
  const evaluator=new runtime.LayoutEvaluator(spec.parseResponsiveLayoutDocument(responsiveLayoutFixture()));
  try{observations.push({id:`canonical-${index}`,request,evaluation:evaluator.evaluate(request)});}
  finally{evaluator.dispose();}
}
const output=resolve(process.argv[2]??'artifacts/engine-0.2.2/g02/hya-before.json');
if(!output.startsWith(resolve('artifacts/engine-0.2.2/g02')+'\\')&&!output.startsWith(resolve('artifacts/engine-0.2.2/g02')+'/'))throw Error('Output outside G02 evidence');
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify({schemaVersion:1,capturedAt:new Date().toISOString(),purpose:'migration geometry, text, nested instances, scrolling, N-slice and virtual-list comparison; not performance qualification',sourceSha256:createHash('sha256').update(readFileSync('extensions/src/animation/layout/parameterized/LayoutEvaluator.ts')).digest('hex'),observations},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,cases:observations.length}));
