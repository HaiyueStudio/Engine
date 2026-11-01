import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { npmCommand, npmArgs } from '../../scripts/npm-process.mjs';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function prepareSceneFlowCandidate(output, { packageReport } = {}) {
  const out = resolve(root, output), consumer = resolve(out, 'consumer');
  if (existsSync(resolve(out, 'candidate.json'))) throw Error('Candidate evidence already exists; select a new output.');
  mkdirSync(consumer, { recursive: true });
  const reportPath = packageReport ? resolve(root, packageReport) : null;
  const publicReport = reportPath ? JSON.parse(readFileSync(reportPath)) : null;
  if (publicReport && publicReport.gate?.status !== 'passed') throw Error('The deterministic public-package gate must pass first.');
  const packages = [];
  for (const workspace of ['engine', 'extensions', 'animation-spec']) {
    const pkg = JSON.parse(readFileSync(resolve(root, workspace, 'package.json')));
    let path, integrity;
    if (publicReport) {
      const packed = publicReport.packages.find(p => p.name === pkg.name);
      if (!packed || packed.version !== pkg.version || packed.sha256 !== packed.deterministicRepackSha256) throw Error('Missing or non-deterministic public package: '+pkg.name);
      path = resolve(root, packed.artifact);
      if (sha(readFileSync(path)) !== packed.sha256) throw Error('Qualified public tarball changed: '+pkg.name);
      integrity = 'sha512-'+createHash('sha512').update(readFileSync(path)).digest('base64');
    } else {
      const pack = JSON.parse(execFileSync(npmCommand(), npmArgs(['pack', './'+workspace, '--offline', '--ignore-scripts', '--json', '--pack-destination', out]), { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4*1024*1024 }))[0];
      path = resolve(out, pack.filename); integrity = pack.integrity;
    }
    const bytes = readFileSync(path);
    packages.push({ workspace, name: pkg.name, version: pkg.version, file: path, sha256: sha(bytes), integrity, bytes: bytes.length });
  }
  const dependencies = Object.fromEntries(packages.map(p => [p.name, 'file:'+p.file.replaceAll('\\','/')]));
  const overrides = {};
  for (const workspace of ['engine','extensions','animation-spec']) {
    const manifest = JSON.parse(readFileSync(resolve(root, workspace, 'package.json')));
    for (const name of Object.keys(manifest.dependencies ?? {})) overrides[name] = JSON.parse(readFileSync(resolve(root,'node_modules',name,'package.json'))).version;
  }
  writeFileSync(resolve(consumer,'package.json'), JSON.stringify({ name:'g03-public-consumer', version:'0.0.0', private:true, type:'module', dependencies, overrides },null,2)+'\n');
  const install = execFileSync(npmCommand(),npmArgs(['install','--offline','--ignore-scripts','--no-audit','--no-fund']),{ cwd:consumer, encoding:'utf8', windowsHide:true, maxBuffer:1024*1024 });
  writeFileSync(resolve(out,'npm-install.log'),install);
  for (const p of packages) {
    if (sha(readFileSync(p.file))!==p.sha256) throw Error('Packed bytes changed.');
    const installed=JSON.parse(readFileSync(resolve(consumer,'node_modules',p.name,'package.json')));
    if (installed.name!==p.name||installed.version!==p.version) throw Error('Installed package identity mismatch.');
  }
  const source = readFileSync(resolve(root,'examples/scene-flow/application.ts'));
  writeFileSync(resolve(consumer,'application.ts'),source);
  writeFileSync(resolve(consumer,'api-contract.d.ts'),readFileSync(resolve(root,'review/engine-0.2.3/api-contract.d.ts')));
  writeFileSync(resolve(consumer,'typecheck.ts'),"import {createSceneFlow} from '@haiyue/extensions/scene-flow';\nimport type {SceneFlow as Frozen} from './api-contract.js';\nconst forward:typeof Frozen.createSceneFlow=createSceneFlow;\nconst backward:typeof createSceneFlow=forward;\nvoid backward;\n");
  writeFileSync(resolve(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'bundler',strict:true,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,skipLibCheck:false,types:['@webgpu/types'],typeRoots:[resolve(root,'node_modules')],outDir:'browser'},include:['application.ts','typecheck.ts']},null,2));
  const typecheck=execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],{cwd:consumer,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
  writeFileSync(resolve(out,'installed-typecheck.log'),typecheck);
  writeFileSync(resolve(consumer,'smoke.mjs'),"import assert from 'node:assert/strict';import {createSceneFlow} from '@haiyue/extensions/scene-flow';import * as root from '@haiyue/extensions';assert.deepEqual(Object.keys(root),['RenderSystem2DBase']);const flow=createSceneFlow({engine:{activeScene:null,switchScene(){return this;}}});flow.dispose();assert.equal(flow.progress.phase,'disposed');console.log(JSON.stringify({status:'passed',publicEsm:true,rootUnchanged:true}));\n");
  const smoke=execFileSync(process.execPath,['smoke.mjs'],{cwd:consumer,encoding:'utf8',windowsHide:true});
  writeFileSync(resolve(out,'installed-esm.log'),smoke);
  const imports={},mounts=[{prefix:'/g03-consumer',directory:consumer},{prefix:'/g03-deps',directory:resolve(consumer,'node_modules')}];
  for (const p of packages) {
    const directory=resolve(consumer,'node_modules',p.name),pkg=JSON.parse(readFileSync(resolve(directory,'package.json'))),prefix='/g03-packages/'+p.workspace;
    mounts.push({prefix,directory});
    for(const [key,value] of Object.entries(pkg.exports??{})){
      const file=typeof value==='string'?value:value.import;
      if(file?.endsWith('.js'))imports[p.name+(key==='.'?'':key.slice(1))]=prefix+'/'+file.replace(/^\.\//,'');
    }
  }
  Object.assign(imports,{'wgpu-matrix':'/g03-deps/wgpu-matrix/dist/3.x/wgpu-matrix.module.js','earcut':'/g03-deps/earcut/src/earcut.js','opentype.js':'/g03-deps/opentype.js/dist/opentype.module.js','tslib':'/g03-deps/tslib/tslib.es6.mjs'});
  const record={schemaVersion:1,status:'passed',role:'g03-feature-candidate-only',fullReleaseQualification:false,node:process.version,platform:process.platform,packages,consumer,sourceApplicationSha256:sha(source),installedApplicationSha256:sha(readFileSync(resolve(consumer,'application.ts'))),compiledApplicationSha256:sha(readFileSync(resolve(consumer,'browser/application.js'))),strictInstalledTypecheck:true,skipLibCheck:false,exactFrozenFactoryType:true,installedEsm:true,imports,mounts,dependencyVersions:overrides,...(reportPath?{publicPackageReport:{path:reportPath,sha256:sha(readFileSync(reportPath))}}:{})};
  writeFileSync(resolve(out,'candidate.json'),JSON.stringify(record,null,2)+'\n');
  return {out,consumer,record,imports,mounts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const output=process.argv[2];if(!output||process.argv.length>4)throw Error('Usage: scene-flow-candidate.mjs OUTPUT [PUBLIC_PACKAGE_REPORT]');
  const candidate=prepareSceneFlowCandidate(output,{packageReport:process.argv[3]});console.log(JSON.stringify({output:candidate.out,status:candidate.record.status,packages:candidate.record.packages.length}));
}
