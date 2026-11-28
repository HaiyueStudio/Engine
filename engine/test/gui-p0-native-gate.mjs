import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {rollup} from 'rollup';
import {haiyuePlugins} from '../../config/rollup.shared.js';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';
import {decodePng} from '../../scripts/visual-regression/png.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),out=resolve(root,'artifacts/gui-p0/native');mkdirSync(out,{recursive:true});
const bundle=await rollup({input:resolve(root,'engine/test/gui-p0-native-fixture.mjs'),plugins:haiyuePlugins({resolveExtensions:['.js','.mjs'],typescriptPlugin:{name:'p0-public-javascript-consumer'}})});
await bundle.write({file:resolve(out,'bundle.js'),format:'es'});const files=bundle.watchFiles;await bundle.close();
const fingerprints=Object.fromEntries(files.map(p=>[relative(root,p),createHash('sha256').update(readFileSync(p)).digest('hex')]));
const smoke=process.argv.includes('--smoke'),reports=[];
const cases=smoke?[{id:'dark-comfortable',theme:'dark',density:'comfortable'}]:['dark','light'].flatMap(theme=>['compact','comfortable','touch'].map(density=>({id:theme+'-'+density,theme,density}))).concat([{id:'dark-msaa1-dpr2',theme:'dark',density:'comfortable',msaa:'1',dpr:'2'},{id:'light-modal',theme:'light',density:'comfortable',modal:'1'}]);
const deep={id:'deep-clip-128',theme:'dark',density:'comfortable',deep:'1'};
for(const {id,...query}of process.argv.includes('--deep')?[deep]:smoke?cases:[...cases,deep]){
 const report=await runChromeWebGpuFixture({root,fixture:'engine/test/gui-p0-native.html',query,timeoutMs:90000,acceptedStatuses:['passed','failed'],visualCapture:{viewportWidth:1200,viewportHeight:880}});
 if(report.visualCapture?.pngBase64){const png=Buffer.from(report.visualCapture.pngBase64,'base64');writeFileSync(resolve(out,id+'.png'),png);if(query.deep){const decoded=decodePng(png),pixel=Array.from(decoded.data.subarray((812*decoded.width+1112)*4,(812*decoded.width+1112)*4+4));report.deepClipPixel=pixel;if(pixel[0]>100||pixel[1]<150||pixel[2]<90){report.status='failed';report.error='The maximum-depth clipped leaf is not visible.';}}delete report.visualCapture.pngBase64;}
 writeFileSync(resolve(out,id+'.json'),JSON.stringify(report,null,2)+'\n');reports.push({id,status:report.status,error:report.error});console.log(JSON.stringify(reports.at(-1)));if(report.status!=='passed')break;
}
writeFileSync(resolve(out,'summary.json'),JSON.stringify({status:reports.every(r=>r.status==='passed')?'passed':'failed',fingerprints,reports},null,2)+'\n');if(reports.some(r=>r.status!=='passed'))process.exitCode=1;
