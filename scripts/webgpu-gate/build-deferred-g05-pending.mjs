import {runRollupOnce} from '../shared-rollup-runner.mjs';
import { rollup } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import { haiyuePlugins } from '../../config/rollup.shared.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { deferredRuntimeFingerprint, sha256 } from './deferred-fixture-policy.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv.length>3||(process.argv[2]&&process.argv[2]!=='--worker'))throw Error('Unexpected build arguments');
if(process.argv[2]!=='--worker'){
 await runRollupOnce({command:process.execPath,args:[fileURLToPath(import.meta.url),'--worker'],cwd:root,expectedOutputs:['g05-pending-runtime'],timeoutMs:120000});
}else{
const outputDirectory=resolve(root,'artifacts/engine-0.2.1/g05/pending-runtime');
await mkdir(outputDirectory,{recursive:true});
const inputs=await deferredRuntimeFingerprint(root);
const entrypoint=resolve(root,'scripts/webgpu-gate/deferred-g05-pending-runtime.mjs');
const entrypointSha256=sha256(await (await import('node:fs/promises')).readFile(entrypoint));
const bundle=await rollup({input:resolve(root,'scripts/webgpu-gate/deferred-g05-pending-runtime.mjs'),external:id=>id.startsWith('node:'),plugins:[{
  name:'private-engine-fixture-source',
  resolveId(id,importer){if(importer && id.includes('engine/dist/')){const path=resolve(dirname(importer),id).replace('/engine/dist/','/engine/src/').replace(/\.js$/,'.ts');return path;}return null;},
},...haiyuePlugins({typescriptPlugin:typescript({tsconfig:resolve(root,'scripts/webgpu-gate/deferred-fixture.tsconfig.json'),outDir:outputDirectory,declaration:false})})]});
try {
  const result=await bundle.write({dir:outputDirectory,format:'es',sourcemap:true,entryFileNames:'fixture.js',chunkFileNames:'fixture-[name]-[hash].js'});
  if(inputs.sha256!==(await deferredRuntimeFingerprint(root)).sha256)throw new Error('Deferred runtime sources changed during build.');
  const outputs=result.output.filter(item=>item.type==='chunk').map(item=>({file:item.fileName,sha256:sha256(item.code)}));
  await writeFile(resolve(outputDirectory,'fixture-build.json'),JSON.stringify({schemaVersion:1,inputs,entrypointSha256,outputs},null,2)+'\n');
}
finally {await bundle.close();}

console.log('created g05-pending-runtime in private source build');
}
