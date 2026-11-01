import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import ts from 'typescript';

export const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');

export function declarationExports(source) {
  const ast=ts.createSourceFile('contract.d.ts',source,ts.ScriptTarget.Latest,true);
  assert.equal(ast.parseDiagnostics.length,0,'invalid target declaration syntax');
  assert.ok(!ast.statements.some(s=>!ts.isModuleDeclaration(s)&&s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)),'unassigned top-level declaration');
  return Object.fromEntries(ast.statements.filter(ts.isModuleDeclaration).map(ns=>[
    ns.name.text,ns.body.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(s=>s.name?.text).filter(Boolean)
  ]));
}

/** Pure checks: no file system, process, network or mutation of caller data. */
export function validateContract(c,source,baseline) {
  assert.equal(c.schemaVersion,1);assert.equal(c.contractId,'haiyue-gameplay-023/1');
  assert.equal(c.status,'frozen');assert.equal(c.releaseQualification,false);
  assert.equal(c.api.declarationSha256,hashBytes(source),'target declaration hash');
  assert.deepEqual(c.versions.publish,{'@haiyue/engine':'0.2.3','@haiyue/extensions':'0.2.3','@haiyue/shader-language':'0.2.3'});
  assert.deepEqual(c.versions.unchanged,{'@haiyue/animation-spec':'0.2.2'});
  assert.equal(c.versions.breakingChangesAllowed,false);assert.equal(c.versions.formatChanges,false);
  assert.deepEqual(c.versions.newThirdPartyDependencies,[]);
  const root=baseline.packages['@haiyue/engine'].entrypoints['.'].exports;
  assert.equal(c.api.rootExportCount,30);assert.deepEqual(c.api.rootExports,root);
  assert.equal(c.api.liveBaselineMutationInG01,false);
  const exports=declarationExports(source),ids=new Set();let additions=0;
  assert.equal(c.api.entries.length,14);
  assert.deepEqual(Object.keys(exports).sort(),[...c.api.entries.map(e=>e.namespace),'ExistingTypeAugmentations'].sort(),'unassigned namespace');
  for(const e of c.api.entries){
    const id=e.package+e.subpath;assert.ok(!ids.has(id),'duplicate entry');ids.add(id);
    assert.equal(e.stability,'stable-on-integration');assert.equal(e.unusedSymbolReserve,0);
    assert.ok(/^g\d{2}$/.test(e.owner),'named owner');
    assert.deepEqual(e.baselineExports,baseline.packages[e.package].entrypoints[e.subpath]?.exports??[],'unchanged baseline exports');
    assert.equal(e.targetExportCount,e.baselineExports.length+e.newExports.length,'exact admission count');
    assert.equal(new Set([...e.baselineExports,...e.newExports]).size,e.targetExportCount,'duplicate API symbol');
    assert.deepEqual(exports[e.namespace]?.filter(n=>!e.augmentExisting.includes(n)),e.newExports,'unadmitted or absent declaration');
    additions+=e.newExports.length;
  }
  assert.equal(additions,69,'named symbol total');
  assert.equal(c.backend.package,'box2d.ts');assert.equal(c.backend.version,'1.0.2');
  assert.deepEqual(c.backend.shapes,['box','circle']);assert.equal(c.backend.optionalDriverCapability,true);
  assert.equal(c.backend.rawOutputPointUsable,false);assert.match(c.backend.contactPoint,/witness/);
  assert.match(c.backend.initialPenetration,/point=null,normal=null/);assert.match(c.backend.movingPlatforms,/durationSeconds/);assert.match(c.backend.broadphase,/kinematic/);assert.match(c.backend.unsupported,/no ray\/AABB/);
  assert.match(source,/castShape\?:/,'legacy custom driver method must stay optional');
  assert.deepEqual(c.gui.requiredCapabilities,['tabs-icon-left-right','breadcrumb','badge','collapse']);
  assert.deepEqual(c.gui.iconPositions,['left','right']);assert.equal(c.gui.contentOwnership,'borrowed');
  assert.equal(c.gui.noIconGap,0);assert.equal(c.gui.collapse.preserveContent,true);
  assert.deepEqual(c.sampling.mutationsPercent,[0,1,10]);assert.equal(c.sampling.rounds,3);
  assert.equal(c.sampling.warmup,12);assert.equal(c.sampling.samplesPerCohort,30);
  assert.deepEqual(c.sampling.workloads.map(w=>w.nodes),[128,1000,10000]);
  assert.equal(c.acceptance.gpuRegressionPercent,5);assert.equal(c.acceptance.frameP95Ms,20);
  assert.equal(c.acceptance.frameP99Ms,34);assert.equal(c.acceptance.longFrameRatioMax,.01);
  assert.equal(c.acceptance.productionRounds,2);assert.equal(c.acceptance.retainedRegionsMax,8);
  assert.equal(c.acceptance.retainedColorBytesMax,67108864);assert.equal(c.acceptance.destroyResidue,0);
  assert.deepEqual(c.acceptance.cpuPhaseLimitsMs,{hud:{layoutP95:2,measureP95:2,guiUpdateSubmitP95:4},pressure:{layoutP95:8,measureP95:8,guiUpdateSubmitP95:null},diagnostic:{layoutP95:null,measureP95:null,guiUpdateSubmitP95:null}});
  for(const [group,limits] of Object.entries(c.limits))for(const [key,value] of Object.entries(limits))if(typeof value==='number')assert.ok(Number.isFinite(value)&&value>0,group+'.'+key+' requires a finite bound');
  assert.equal(c.deviceMatrix.owner,'g11-integration-candidate');assert.match(c.deviceMatrix.software,/no inherited timeout exemption/);
  assert.equal(c.reuse.status,'proposal-under-existing-ADR-admission');assert.equal(c.reuse.originalFailurePreserved,true);
  assert.deepEqual(c.reuse.requiredHashes,['runtime','sampler','config','workload','report','environment','rebuilt-executable-blocks']);
  assert.equal(c.errors.length,11);assert.equal(new Set(c.errors.map(e=>e.code)).size,11);
  for(const e of c.errors){assert.equal(e.class,'EngineError');assert.ok(e.docsPath.startsWith('docs/api/errors.md#e-'));}
  assert.ok(c.consumers.native.paths.length>0);assert.equal(c.consumers.Games,'not selected; no write/check scope');
  assert.ok(!c.consumers.native.paths.some(p=>p.includes('tank-battle')));
  return {entries:ids.size,admittedSymbols:additions,rootSymbols:root.length};
}

export function validateDiagnosticReports({source,cpu,native,icons,published}) {
  for(const r of [source,cpu,native,icons])assert.equal(r.qualification,false,'diagnostics cannot grant release qualification');
  assert.equal(source.status,'completed-expected-baseline-observations');assert.equal(source.checks.length,9);
  const cast=source.checks.find(c=>c.id==='box2d-real-shape-sweep').actual;
  assert.equal(cast.sweep.length,10);assert.equal(cast.manifolds.length,6);assert.equal(cast.rawPointAssignmentDefect,true);
  assert.equal(cast.sweep.find(c=>c.id==='initial-overlap-needs-distance-check').point,null,'overlap has no reconstructed impact point');
  assert.equal(cpu.cpu.length,27);assert.equal(cpu.structural.length,3);
  for(const c of cpu.structural){assert.equal(c.unchangedLayoutCalls,0);assert.equal(c.visualLayoutCalls,0);for(const kind of ['buffer','texture'])assert.equal(c.auditAfterDestroy.resources[kind].live,0,'destroyable GPU resource residue');}
  for(const c of cpu.cpu){assert.equal(c.samples.length,30);assert.ok(c.samples.every(n=>Number.isFinite(n)&&n>=0));}
  assert.equal(native.status,'passed');assert.equal(native.cohorts.length,2);
  assert.equal(native.adapter.vendor,'nvidia');assert.equal(native.adapter.architecture,'pascal');
  assert.deepEqual(native.validationErrors,[]);
  for(const c of native.cohorts){assert.equal(c.warmupFrames,60);assert.equal(c.measuredFrames,120);assert.equal(c.cpuMs.length,120);}
  assert.equal(icons.status,'passed');assert.equal(icons.cases.length,8);
  assert.equal(icons.cases.filter(c=>c.targetOnly).length,4);
  assert.equal(published.packages.length,4);assert.equal(published.receiptSha256,'0aff32d45c727b85cae88de8109d50008225acdcad33db9968e71d9440ccfa43');
  assert.deepEqual(published.packages.map(p=>p.version),Array(4).fill('0.2.2'));
  return {sourceGroups:9,sweeps:10,manifolds:6,cpuCohorts:27,structuralCohorts:3,nativeCohorts:2,iconCases:8,publishedPackages:4};
}

export function validateFileReference(reference,read) {
  const path=reference.path;
  assert.ok(typeof path==='string'&&path.length>0&&!path.includes('\\')&&!path.startsWith('/')&&!path.includes(':')&&!path.split('/').some(p=>p==='..'||p==='.'),'unsafe evidence path');
  assert.match(reference.sha256,/^[a-f0-9]{64}$/);
  assert.equal(hashBytes(read(path)),reference.sha256,'evidence bytes changed: '+path);
}
