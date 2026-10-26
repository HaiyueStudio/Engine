import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpus,platform} from 'node:os';
import {productionFontFixture} from '../../extensions/test/text-production-font-fixture.mjs';
import {productionLayoutWorkload,layoutMutationRequest} from '../fixtures/hya-production/workloads.mjs';
import {createQualificationOutput} from './qualification-output.mjs';
import {snapshotSourceInputs,changedSourceInputs} from './source-snapshot.mjs';

const root=resolve('.'),baseline=process.argv.includes('--baseline'),source=baseline?resolve(root,'../Engine-g12-baseline-20261026'):root;
const output=createQualificationOutput(root,process.argv[process.argv.indexOf('--output')+1]);mkdirSync(output.directory,{recursive:true});
const {loadResponsiveLayoutModules}=await import(pathToFileURL(resolve(source,'extensions/test/responsive-layout-fixture.mjs')));
const modules=await loadResponsiveLayoutModules(),font=productionFontFixture(),contract=JSON.parse(readFileSync(resolve(root,'config/layout-022-contract.json'),'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex'),cohorts=[],errors=[];
const sourceInputs=snapshotSourceInputs(source,['extensions/src/animation','extensions/src/layout','extensions/src/hya-state-machine','animation-spec/src']);
const harnessInputs=snapshotSourceInputs(root,['scripts/hya-corpus/qualify-layout.mjs','scripts/hya-corpus/source-snapshot.mjs','scripts/fixtures/hya-production/workloads.mjs','extensions/test/text-production-font-fixture.mjs','extensions/test/responsive-layout-fixture.mjs','config/layout-022-contract.json']);
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]??0;
for(let round=0;round<contract.sampling.rounds;round++) {
  const workloads=round===1?[...contract.sampling.workloads].reverse():contract.sampling.workloads;
  for(const workload of workloads)for(const mutationPercent of contract.sampling.mutationsPercent) {
    const cold={},sourceDocument=productionLayoutWorkload(workload.nodes,font.document);let start=performance.now();
    const document=modules.spec.parseResponsiveLayoutDocument(sourceDocument);cold.parseMs=performance.now()-start;
    const assets=new modules.runtime.LayoutAssetOwner(document,{policy:{mode:'deny'}});start=performance.now();
    const text=new modules.textProduction.ProductionTextOwner(document,modules.outlineProduction.createProductionOutlineFontPort(assets));await text.prepare();cold.fontPrepareMs=performance.now()-start;
    const layout=new modules.layoutProduction.ProductionLayoutOwner(document,text);const rows=[];let measureMs=0,layoutMs=0,solveCalls=0,shapeCalls=0;
    const shape=layout.shape.bind(layout);layout.shape=(...args)=>{const start=performance.now();try{return shape(...args);}finally{measureMs+=performance.now()-start;shapeCalls++;}};
    const evaluate=layout.evaluator.evaluate.bind(layout.evaluator);layout.evaluator.evaluate=(...args)=>{const start=performance.now(),prior=measureMs;try{return evaluate(...args);}finally{layoutMs+=Math.max(0,performance.now()-start-(measureMs-prior));solveCalls++;}};
    let geometry;
    try {
      for(let frame=0;frame<contract.sampling.warmup+contract.sampling.samplesPerCohort;frame++) {
        measureMs=layoutMs=solveCalls=shapeCalls=0;const request=layoutMutationRequest(workload.nodes,mutationPercent,frame),start=performance.now(),beforeShapes=layout.stats.shapes;
        const value=layout.evaluate(request),totalMs=performance.now()-start;
        assert.equal(value.nodes.length,workload.nodes);const nextGeometry=sha(JSON.stringify(value.nodes.map(node=>node.rect)));
        if(geometry)assert.equal(nextGeometry,geometry,'equal-width text edits must preserve frozen boxes');geometry=nextGeometry;
        for(const [index,node]of value.nodes.slice(1).entries()) {
          const expected=[index%29*44,Math.floor(index/29)*28,40,24];
          assert.ok(node.rect.every((axis,i)=>Math.abs(axis-expected[i])<=contract.oracle.geometryToleranceCssPx),'frozen box geometry changed');
        }
        rows.push({frame,warmup:frame<contract.sampling.warmup,totalMs,layoutMs,measureMs,solveCalls,shapeCalls,shaped:layout.stats.shapes-beforeShapes,geometrySha256:geometry});
      }
      const samples=rows.filter(row=>!row.warmup),budget=contract.acceptance.cpuPhaseLimitsMs[workload.id],summary={layoutP95Ms:p95(samples.map(row=>row.layoutMs)),measureP95Ms:p95(samples.map(row=>row.measureMs)),totalP95Ms:p95(samples.map(row=>row.totalMs)),solveCalls:samples.reduce((sum,row)=>sum+row.solveCalls,0),shaped:samples.reduce((sum,row)=>sum+row.shaped,0)};
      if(!baseline) {
        if(mutationPercent===0 && (summary.solveCalls||summary.shaped))errors.push({round,workload:workload.id,mutationPercent,reason:'static solve or shape'});
        if(budget.layoutP95!==null&&summary.layoutP95Ms>budget.layoutP95)errors.push({round,workload:workload.id,mutationPercent,metric:'layoutP95',limit:budget.layoutP95,actual:summary.layoutP95Ms});
        if(budget.measureP95!==null&&summary.measureP95Ms>budget.measureP95)errors.push({round,workload:workload.id,mutationPercent,metric:'measureP95',limit:budget.measureP95,actual:summary.measureP95Ms});
      }
      cohorts.push({round:round+1,workload,mutationPercent,cold,rows,summary});
      console.log(JSON.stringify({round:round+1,workload:workload.id,mutationPercent,...summary}));
    } finally {layout.dispose();text.dispose();assets.dispose();assert.equal(layout.stats.disposed,true);assert.equal(assets.stats.entries,0);}
    writeFileSync(resolve(output.directory,'partial.json'),JSON.stringify({cohorts,errors},null,2)+'\n');
  }
}
const git=(...args)=>execFileSync('git',['-c','safe.directory='+source.replaceAll('\\','/'),...args],{cwd:source,encoding:'utf8'}).trim();
const changed=[...changedSourceInputs(source,sourceInputs),...changedSourceInputs(root,harnessInputs)];if(changed.length)errors.push({reason:'Inputs changed during capture',changed});
const report={schemaVersion:1,status:errors.length?'failed':'passed',scope:'Three-round source-bound real-font CPU phases; not native GPU, public tarball, product, or full G12 qualification',baseline,sourceRevision:git('rev-parse','HEAD'),dirty:!!git('status','--porcelain'),sourceInputs,harnessInputs,node:process.version,platform:platform(),cpu:cpus()[0]?.model,font:{sha256:font.sha256,license:font.license},contractSha256:sha(readFileSync(resolve(root,'config/layout-022-contract.json'))),workloadSha256:sha(readFileSync(resolve(root,'scripts/fixtures/hya-production/workloads.mjs'))),cohorts,errors};
writeFileSync(resolve(output.directory,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,cohorts:cohorts.length,errors}));if(errors.length)process.exitCode=1;
