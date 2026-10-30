import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {loadHyaProductionSource} from '../../animation-spec/test/helpers/hya-production-source.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const read=path=>JSON.parse(readFileSync(resolve(root,path),'utf8'));
const contract=read('config/hya-022-contract.json');
const {spec,record}=await loadHyaProductionSource();
const sourceFile=path=>ts.createSourceFile(path,readFileSync(resolve(root,path),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);

test('HYA capability census separates format, runtime, public examples and evidence with explicit ownership',()=>{
 assert.equal(contract.capabilities.length,40);assert.deepEqual(contract.unclassifiedCapabilities,[]);
 assert.equal(new Set(contract.capabilities.map(c=>c.id)).size,40);assert.equal(new Set(contract.capabilities.map(c=>c.negotiationId)).size,40);
 assert.deepEqual(Object.keys(contract.foundationModules).sort(),readdirSync(resolve(root,'animation-spec/src')).sort());
 const classified=new Set(contract.capabilities.map(c=>c.id));
 for(const rows of Object.values(contract.foundationModules))for(const id of rows)assert.ok(classified.has(id),id);
 const components=sourceFile('animation-spec/src/types.ts').statements.filter(s=>ts.isInterfaceDeclaration(s)&&s.name.text.endsWith('Component')).map(s=>s.name.text);
 assert.deepEqual(Object.keys(contract.coreComponentTypes).sort(),components.sort());
 for(const id of Object.values(contract.coreComponentTypes))assert.ok(classified.has(id));
 for(const item of contract.capabilities){
  assert.ok(item.decision&&item.current.runtime&&item.current.formal022Qualification);
  assert.match(item.failure.code,/^E_[A-Z0-9_]+$/u);assert.ok(item.failure.path.startsWith('$'));
  assert.equal(item.failure.capability,item.id);assert.match(item.negotiationId,/^org\.haiyue\.production\.[a-z0-9-]+@1$/u);
  assert.equal(item.owners.contract,'g10-hya-capability-contracts');assert.equal(item.owners.runtime,'g11-hya-production-runtime');assert.equal(item.owners.qualification,'g12-hya-production-qualification');assert.equal(item.owners.packageAndDevices,'g13-integration-release');
  for(const path of [item.schema,item.parser,item.codec,item.runtime,...item.existingTests])if(path)assert.ok(existsSync(resolve(root,path)),path);
  assert.ok(item.requiredEvidence.length>0);
  assert.equal(item.evidence.currentKind,'module-test-sources-only');assert.deepEqual(item.evidence.paths,item.existingTests);
  assert.equal(item.evidence.formal022,null);assert.deepEqual(item.evidence.productionRequired,item.requiredEvidence);
  assert.equal(item.example.formal022Qualified,false);assert.ok(item.example.coverage.length>0);
  if(item.example.path){
   assert.equal(item.example.status,'existing-public-demo');assert.ok(existsSync(resolve(root,item.example.path)));
   const example=read('examples/manifest.json').entries.find(e=>e.id===item.example.manifestId);
   assert.equal('examples/'+example?.entry,item.example.path);
  }else{assert.equal(item.example.status,'no-capability-specific-public-demo');assert.equal(item.example.manifestId,null);}
  for(const name of item.current.publicEntries){
   const workspace=name.startsWith('@haiyue/animation-spec')?'animation-spec':'extensions';
   const subpath='.'+name.slice(('@haiyue/'+workspace).length);assert.ok(subpath in read(workspace+'/package.json').exports,name);
  }
 }
 for(const name of ['parameterized-text-paints','images-and-nslice'])assert.equal(contract.capabilities.find(c=>c.id===name).current.runtime,'diagnostic-placeholder');
 assert.equal(contract.capabilities.find(c=>c.id==='composition-runtime').current.runtime,'absent');
});
test('exact named HYA source and draft entry budgets are closed and do not aggregate old entry names',()=>{
 const actual=[];
 for(const statement of sourceFile('animation-spec/src/hya-production.ts').statements)if(ts.isExportDeclaration(statement)&&statement.exportClause&&ts.isNamedExports(statement.exportClause))actual.push(...statement.exportClause.elements.map(item=>item.name.text));
 const format=contract.publicEntries[0];assert.equal(format.maximumSymbols,55);assert.deepEqual([...actual].sort(),[...format.symbols].sort());assert.equal(new Set(actual).size,55);
 const drafts=new Map();
 for(const statement of sourceFile('review/engine-0.2.2/hya-api-draft.d.ts').statements)if(ts.isModuleDeclaration(statement)&&statement.body&&ts.isModuleBlock(statement.body))drafts.set(statement.name.text,statement.body.statements.filter(s=>s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)&&s.name).map(s=>s.name.text));
 assert.equal(drafts.size,5);
 for(const entry of contract.publicEntries){
  assert.equal(entry.symbols.length,entry.maximumSymbols);assert.equal(new Set(entry.symbols).size,entry.symbols.length);
  const packageName=entry.package+(entry.subpath.slice(1)),workspace=entry.package==='@haiyue/animation-spec'?'animation-spec':'extensions';
  // The G10 census is frozen before admission; G11 now registers the exact entries.
  assert.equal(entry.currentlyDeclaredInPackage,false,'preserve the original G10 package snapshot');
  assert.ok(entry.subpath in read(workspace+'/package.json').exports,'G11 admitted entry is present: '+packageName);
  if(workspace==='extensions')assert.deepEqual(drafts.get(packageName).sort(),[...entry.symbols].sort());
 }
 assert.deepEqual(contract.publicEntries.map(e=>e.maximumSymbols),[55,9,7,5,9,7]);
});
test('composition JSON schema and implementation retain the frozen byte, count and version ceilings',()=>{
 assert.deepEqual(spec.DEFAULT_HYA_COMPOSITION_LIMITS,contract.limits);
 const schema=read('animation-spec/schema/hya-composition.schema.json');
 assert.equal(schema.properties.version.const,contract.versions.composition);
 assert.equal(schema.properties.parts.maxItems,contract.limits.maxParts);assert.equal(schema.properties.targets.maxItems,contract.limits.maxTargets);
 assert.equal(schema.$defs.part.properties.requires.maxItems,contract.limits.maxRequirementsPerPart);
 assert.equal(schema.additionalProperties,false);assert.equal(schema.$defs.part.additionalProperties,false);assert.equal(schema.$defs.target.additionalProperties,false);
 assert.deepEqual(contract.versions.coreBinaryDecode,[1,2]);assert.equal(contract.versions.coreBinaryEncode,2);assert.equal(contract.versions.layout,'HYLA-1.0');assert.equal(contract.versions.rig,'HYRG-2.0');
});
test('proposed format graph has no Engine, GUI, GPU, DOM, source adapter or heavy font dependency',()=>{
 assert.ok(record.sourceFiles.length>5);
 for(const file of record.sourceFiles){assert.match(file.path,/\/animation-spec\/src\//u);assert.doesNotMatch(file.path,/\/(?:lottie|live2d|conversion|script)\//u);}
 const code=readFileSync(record.path,'utf8');assert.doesNotMatch(code,/@haiyue\/engine|opentype|createElement\(|requestAdapter\(/u);
 assert.equal(contract.hostDeclarationNeverOverridesRejection,true);
});
test('the nine selected state paths, old rejection families and stage order are explicit',()=>{
 assert.deepEqual(contract.newStatePaths['vector-paint'],['components.{index}.paint.fill.color','components.{index}.paint.stroke.color','components.{index}.paint.stroke.width','components.{index}.paint.opacity']);
 assert.deepEqual(contract.newStatePaths['text-animator'],['components.{index}.text.value','components.{index}.text.fontSize','components.{index}.text.tracking','components.{index}.text.color','components.{index}.text.opacity']);
 assert.deepEqual(contract.newStatePaths.remainingFamiliesRejected,['visual-effect','composite-expansion']);assert.equal(contract.newStatePaths.notAnUpgradeToOldRegistry,true);
 assert.deepEqual(contract.requiredStages,['input-queue','atomic-data','state-timeline','text-layout','geometry-draw','observable-commit']);
 assert.deepEqual(contract.audioRateRange,[.0625,16]);
});
test('the real corpus population, license sources and degraded expectation are not relabeled',()=>{
 const q=contract.qualification,bytes=readFileSync(resolve(root,q.corpusManifest)),manifest=JSON.parse(bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),q.manifestSha256);assert.equal(manifest.entries.length,q.unchangedDenominator);
 assert.equal(q.preserveAllCohortsAndFailures,true);assert.equal(q.repetitions,3);assert.equal(q.currentOfficialPackageQualified,false);
 for(const id of q.requiredRealIds)assert.ok(manifest.entries.some(entry=>entry.id===id),id);
 assert.equal(manifest.entries.find(e=>e.id==='large/footage-images-text').expectation,'degraded');
 assert.ok(manifest.entries.some(e=>e.sizeClass==='large'));assert.ok(manifest.entries.some(e=>!e.sizeClass));
 assert.equal(manifest.sources['google-fonts'].dataLicense,'OFL-1.1');
 for(const id of ['download','parse','prepare','font-ready','first-usable-frame','cpu','gpu','queue-wait','upload-bytes','draw-count','gpu-resource-residue'])assert.ok(q.metrics.includes(id));
});
