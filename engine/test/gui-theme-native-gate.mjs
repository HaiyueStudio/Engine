import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {rollup} from 'rollup';
import ts from 'typescript';
import {haiyuePlugins} from '../../config/rollup.shared.js';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),out=resolve(root,'artifacts/engine-0.2.2/g07/native-fixture');mkdirSync(out,{recursive:true});
const bundle=await rollup({input:resolve(root,'engine/test/gui-theme-native-fixture.mjs'),plugins:haiyuePlugins({resolveExtensions:['.js','.mjs','.ts'],typescriptPlugin:{name:'g07-source-transpile',transform(code,id){if(!id.endsWith('.ts'))return null;return {code:ts.transpileModule(code,{fileName:id,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,experimentalDecorators:true}}).outputText,map:null};}}})});
await bundle.write({file:resolve(out,'bundle.js'),format:'es',sourcemap:true});await bundle.close();
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const inputs=[...bundle.watchFiles,resolve(root,'engine/test/gui-theme-native-gate.mjs'),resolve(root,'engine/test/gui-theme-native.html')];
const fingerprints=Object.fromEntries(inputs.map(path=>[path,hash(path)]));
let report;try{report=await runChromeWebGpuFixture({root,fixture:'engine/test/gui-theme-native.html',timeoutMs:90000,acceptedStatuses:['passed','failed']});}catch(error){report={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const served=report.httpProvenance?.files??[],mismatches=served.filter(file=>createHash('sha256').update(readFileSync(resolve(root,file.sourcePath))).digest('hex')!==file.sha256);
const changed=inputs.filter(path=>hash(path)!==fingerprints[path]);
if(!served.length||mismatches.length||changed.length)report={...report,status:'failed',servedByteMismatch:mismatches,changedInputs:changed};
const path=resolve(out,`result-${Date.now()}.json`);writeFileSync(path,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceFingerprints:fingerprints,...report},null,2)+'\n');console.log(JSON.stringify({path,status:report.status,cases:report.caseCount,error:report.error,browserFailure:report.browserFailure}));if(report.status!=='passed')process.exitCode=1;
