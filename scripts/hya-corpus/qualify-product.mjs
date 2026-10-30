import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {rollup} from 'rollup';
import {nodeResolve} from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import ts from 'typescript';
import {runChromeWebGpuFixture} from '../webgpu-gate/chrome-runner.mjs';
import {createQualificationOutput} from './qualification-output.mjs';
import {stageQualifiedPackages,verifyServedBytes,sha256} from './packed-browser.mjs';
import {snapshotSourceInputs,changedSourceInputs} from './source-snapshot.mjs';
const root=process.cwd(),games=resolve(root,'../Games'),arg=(key,fallback)=>{const at=process.argv.indexOf(key);return at<0?fallback:process.argv[at+1];};
const output=createQualificationOutput(root,arg('--output','artifacts/engine-0.2.2/g12/product-'+Date.now())).directory;mkdirSync(output,{recursive:true});
const staged=stageQualifiedPackages(root,resolve(root,arg('--packages','artifacts/engine-0.2.2/g12/packed-final-20261026/public-packages.json')),output),sources=new Set(),entry=resolve(games,'games/gravity-maze/main.ts');
const manifest=JSON.parse(readFileSync(resolve(games,'games/manifest.json'),'utf8')),descriptor=manifest.entries.find(e=>e.id==='gravity-maze');if(!descriptor?.capabilities.includes('hya-production'))throw Error('Real product manifest admission is missing');
const paths={};for(const entry of staged.report.packages){const directory=resolve(output,'packages',entry.workspace),pkg=JSON.parse(readFileSync(resolve(directory,'package.json'),'utf8'));for(const[key,value]of Object.entries(pkg.exports??{})){const file=typeof value==='object'?value.types:undefined;if(file)paths[pkg.name+(key==='.'?'':key.slice(1))]=[resolve(directory,file)];}}
for(const [name,files]of Object.entries(paths))if(name.startsWith('@haiyue/engine'))paths[name.replace('@haiyue/engine','@haiyue/engine-gamepad')]=files;
const compiled=resolve(output,'compiled'),options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,strict:true,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,skipLibCheck:true,baseUrl:games,paths,types:['@webgpu/types'],typeRoots:[resolve(root,'node_modules/@types'),resolve(root,'node_modules')],rootDir:games,outDir:compiled,noEmitOnError:true},host=ts.createCompilerHost(options),read=host.readFile.bind(host);
host.readFile=id=>{let source=read(id);const file=resolve(id);if(source===undefined||!file.startsWith(games)||!file.endsWith('.ts'))return source;sources.add(file);
  if(file===entry){
   const anchor='game.loadLevel(saved?.level ?? 1);';if(!source.includes(anchor))throw Error('Actual product setup anchor changed');
   source=source.replace(anchor,anchor+`\nObject.defineProperty(globalThis,'__g12Product',{value:{engine,scene,hud,game,physics,tilt,ballBody},configurable:true});`);
   source=source.replace('result.dataset.status = status;','result.dataset.productStatus = status;');
  }
 return source;
};
const program=ts.createProgram([entry],options,host),diagnostics=ts.getPreEmitDiagnostics(program);writeFileSync(resolve(output,'typecheck.log'),ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>games,getCanonicalFileName:file=>file,getNewLine:()=> '\n'}));if(diagnostics.length)throw Error('Actual product typecheck failed; see '+resolve(output,'typecheck.log'));program.emit();
if(!sources.has(entry))throw Error('Actual product source identity is missing');
const bundle=await rollup({input:resolve(compiled,'games/gravity-maze/main.js'),external:id=>id.startsWith('@haiyue/')||id==='wgpu-matrix',plugins:[{
 name:'g12-real-product-source',resolveId(id,importer){if(!id.startsWith('.')||!importer)return null;const path=resolve(dirname(importer),id);return [path,path+'.js',resolve(path,'index.js')].find(file=>existsSync(file)&&/\.(?:js|mjs|wgsl)$/.test(file))??null;}
},nodeResolve({browser:true,preferBuiltins:false,modulePaths:[resolve(games,'node_modules'),resolve(root,'node_modules')]}),commonjs()]});
const build=resolve(output,'build');await bundle.write({dir:build,format:'es',entryFileNames:'product.js',chunkFileNames:'chunks/[name]-[hash].js'});await bundle.close();
const inputs=snapshotSourceInputs(games,[...sources,...descriptor.assets.map(file=>'games/'+file),'games/manifest.json']);
const harnessInputs=snapshotSourceInputs(root,['scripts/hya-corpus','scripts/fixtures/hya-production','scripts/webgpu-gate']);
for(const [name,path]of Object.entries(staged.imports))if(name.startsWith('@haiyue/engine'))staged.imports[name.replace('@haiyue/engine','@haiyue/engine-gamepad')]=path;
staged.imports['@dimforge/rapier3d-compat']='/node_modules/@dimforge/rapier3d-compat/rapier.mjs';
const html=resolve(output,'fixture.html');writeFileSync(html,'<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{width:1280px;height:720px}</style><canvas id="canvas" width="1280" height="720" tabindex="0"></canvas><output id="result" hidden></output><pre id="g12-result"></pre><script type="importmap">'+JSON.stringify({imports:staged.imports})+'</script><script type="module" src="/g12-product/build/product.js"></script><script type="module" src="/scripts/fixtures/hya-production/product-browser.mjs"></script>');
const mounts=[staged.mount,{prefix:'/g12-product',directory:output},{prefix:'/assets',directory:resolve(games,'games/gravity-maze/assets')},{prefix:'/'+output.slice(root.length+1).replaceAll('\\','/')+'/assets',directory:resolve(games,'games/gravity-maze/assets')}];
let screenshot,browser;try{browser=await runChromeWebGpuFixture({root,fixture:html.slice(root.length+1).replaceAll('\\','/'),mounts,timeoutMs:180000,acceptedStatuses:['passed','failed'],chunkedResult:true,visualCapture:{viewportWidth:1280,viewportHeight:720},interact:async cdp=>{
 const start=Date.now();while(Date.now()-start<150000){const response=await cdp.call('Runtime.evaluate',{expression:'({ready:globalThis.__g12ProductScreenshotReady,failed:document.querySelector("#result")?.dataset.status==="failed"})',returnByValue:true}),state=response.result?.result?.value;if(state?.failed)return;if(state?.ready){const capture=await cdp.call('Page.captureScreenshot',{format:'png',fromSurface:true}),bytes=Buffer.from(capture.result.data,'base64');writeFileSync(resolve(output,'product.png'),bytes);screenshot={file:'product.png',sha256:sha256(bytes),boundary:'Actual victory rendered, before owner teardown'};await cdp.call('Runtime.evaluate',{expression:'globalThis.__g12ProductProceed=true'});return;}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Actual product screenshot readiness timed out');
}});}catch(error){browser={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const servedBytes=verifyServedBytes(root,mounts,browser),changed=[...changedSourceInputs(games,inputs),...changedSourceInputs(root,harnessInputs)];if(changed.length||servedBytes.status!=='passed')browser.status='failed';
writeFileSync(resolve(output,'result.json'),JSON.stringify({schemaVersion:1,tarballs:staged.tarballs,sourceInputs:inputs,harnessInputs,changed,servedBytes,screenshot,product:'gravity-maze',physicalInputAccepted:false,fullG12Complete:false,...browser},null,2)+'\n');console.log(JSON.stringify({output,status:browser.status,error:browser.error,cases:browser.caseCount}));if(browser.status!=='passed')process.exitCode=1;
