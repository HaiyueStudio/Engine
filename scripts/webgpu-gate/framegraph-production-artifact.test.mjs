import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { sha256 } from './deferred-fixture-policy.mjs';
import { productionPlan, validateProductionScreenshot } from './framegraph-production-policy.mjs';
import { auditProductionReport } from './framegraph-production-artifact.mjs';
const config = JSON.parse(readFileSync(new URL('../../config/framegraph-production-021.json', import.meta.url)));
function png(red=150, green=40, blue=20) {
  const width=1280,height=720,rows=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3;rows[i]=red;rows[i+1]=green;rows[i+2]=blue;}
  const chunk=(name,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);
    let crc=0xffffffff;for(const value of b.subarray(4,-4)){crc^=value;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
function fixture() {
  const files=new Map(), put=(name,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));files.set(name,bytes);return {file:name,sha256:sha256(bytes)};};
  const plan=productionPlan(config), inputs='a'.repeat(64), build=[{file:'fixture.js',sha256:sha256('runtime')}];
  put('runtime/fixture.js',Buffer.from('runtime'));
  const screenshot=put('canvas.png',png());
  const report={schemaVersion:1,tier:'production-local',config,configSha256:sha256(JSON.stringify(config)),plan,inputs,inputsAfter:inputs,
    build,buildSha256:sha256(JSON.stringify(build)),entries:[]};
  report.registration=put('registration.json',{registeredAt:'2026-10-13T00:00:00Z',configSha256:report.configSha256,inputs,buildSha256:report.buildSha256,plan});
  for(const [i,job] of plan.entries()) {
    const spec=config.workloads.find(w=>w.id===job.caseId), snapshot={width:spec.resolution[0],height:spec.resolution[1],lights:spec.lights,boxes:256,
      views:spec.views+Number(spec.effect==='rtt'),lighting:{completeCoverage:true,effective:`deferred-${spec.algorithm}`,submittedPoints:spec.lights},
      effects:spec.effect==='gtao'?['GtaoPass']:spec.effect==='taa-blur'?['TaaPass','GaussianBlurPass']:[]};
    const raw={schemaVersion:1,contractId:config.contractId,caseId:spec.id,status:'captured',startedAt:'2026-10-13T00:01:00Z',
      finishedAt:'2026-10-13T00:01:42Z',startMs:50,
      measurement:'engine-rAF-cadence-visible-canvas',browserEvidence:{presentationMode:'visible-window',nativeBackend:true,
        userAgent:`Windows Chrome/140.0${job.browserId==='edge-windows'?' Edg/140.0':''}`},browserDiagnostics:{unclassifiedFailureCount:0},
      adapter:{vendor:'nvidia',architecture:'pascal',isFallbackAdapter:false},initial:snapshot,final:snapshot,cleanup:{resources:0,estimatedBytes:0},
      errors:[],events:[],screen:{innerWidth:1300,innerHeight:760},firstFrameMs:100,firstSubmissionMs:102,
      sceneInitializedMs:60,readyMs:90,preparation:[{start:60,submitted:65,completed:72,visible:'visible',focused:true},{start:73,submitted:80,completed:85,visible:'visible',focused:true}],
      frames:Array.from({length:2401},(_,j)=>{const t=100+j*1000/60;return [t,t+1,t+2,1,1];}),
      httpProvenance:{files:[{sourcePath:'production-runtime/fixture.js',sha256:build[0].sha256}]}};
    report.entries.push({job,raw:put(`${i}.json`,raw),screenshot,status:'forged-cached-status'});
  }
  return {report,files,put,read:name=>{if(!files.has(name))throw Error('Missing file');return files.get(name);}};
}
test('screenshot guard rejects a blank/occluded room, independently of pacing',()=>{
  assert.throws(()=>validateProductionScreenshot(png(80,80,80)),/Empty or occluded/);
  assert.equal(validateProductionScreenshot(png()).coloredRatio,1);
});
test('artifact audit recomputes every cohort and never grants release or G09 completion',async()=>{
  const f=fixture(),result=await auditProductionReport(f.report,f.read);
  assert.equal(result.status,'passed');assert.equal(result.entries.length,36);assert.equal(result.releaseQualified,false);assert.equal(result.g09Complete,false);
});
test('artifact audit rejects omitted rounds, source changes, altered raw bytes and registration after measurement',async()=>{
  for(const mutate of [f=>f.report.entries.pop(),f=>f.report.inputsAfter='b'.repeat(64),f=>f.files.set('0.json',Buffer.from('{}')),
    f=>f.files.set('runtime/fixture.js',Buffer.from('changed')),
    f=>{const reg=JSON.parse(f.read('registration.json'));reg.registeredAt='2026-10-14T00:00:00Z';f.report.registration=f.put('registration.json',reg);}]) {
    const f=fixture();mutate(f);await assert.rejects(()=>auditProductionReport(f.report,f.read));
  }
});
test('incomplete and contaminated captures cannot be hidden behind a successful cached status',async()=>{
  const f=fixture(),raw=JSON.parse(f.read('0.json'));raw.frames[100][4]=0;f.report.entries[0].raw=f.put('0.json',raw);
  const result=await auditProductionReport(f.report,f.read);assert.equal(result.status,'inconclusive');
  delete f.report.entries[0].raw;assert.equal((await auditProductionReport(f.report,f.read)).status,'invalid');
});
