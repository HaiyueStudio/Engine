/** One-off evidence capture from the frozen pre-migration revision. Never used as a runtime fallback. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadResponsiveLayoutModules,responsiveLayoutFixture} from './responsive-layout-fixture.mjs';
import {documentFor} from '../../scripts/fixtures/layout-contracts/cases.mjs';
const revision='7d0df288285834e2583f563478f322fdf6743c09';
const source=execFileSync('git',['show',`${revision}:extensions/src/animation/layout/parameterized/LayoutEvaluator.ts`],{encoding:'utf8'});
const sha=s=>createHash('sha256').update(s).digest('hex');
const prior=JSON.parse(readFileSync('artifacts/engine-0.2.2/g02/hya-before.json','utf8'));
if(![source,source.replace(/\r?\n/g,'\r\n')].some(s=>sha(s)===prior.sourceSha256))throw Error('Frozen source differs from independently captured pre-migration evaluator');
const {spec,runtime}=await loadResponsiveLayoutModules({evaluatorSource:source});
const point=value=>({unit:'point',value}),percent=value=>({unit:'percent',value}),fraction=value=>({unit:'fraction',value});
const cases=[];
for(let i=0;i<64;i++){
  const grid=i%8===0;
  const root=grid?{display:'grid',gridColumns:[{min:point(30),max:point(80)},{min:fraction(i%16?2:.25)}],gridRows:[{min:point(20)},{min:fraction(1)}],gap:[point(7),point(4)]}
    :{display:'flex',direction:i%2?'column':'row',writingDirection:i%3?'ltr':'rtl',wrap:i%4===0,justify:['start','center','end','space-between','space-around','space-evenly'][i%6],align:['start','center','end','stretch'][i%4],padding:[point(2),percent(3),point(4),point(1)],gap:[point(5),point(3)]};
  const children=Array.from({length:5},(_,j)=>{
    const width=[point(30),{unit:'fill'},fraction(.25),{unit:'hug'},percent(20),undefined][(i+j)%6];
    const height=[point(15),{unit:'hug'},fraction(2),undefined,percent(10)][(i+2*j)%5];
    const style={...(width?{width}:{}),...(height?{height}:{}),minWidth:point(j===0?45:0),maxWidth:point(j===1?40:250),margin:[point(1),percent(1),point(2),point(3)],...(j===4&&i%7===0?{display:'none'}:{}),...(j===3&&i%5===0?{position:'absolute',inset:[point(0),point(3),point(5),point(7)]}:{}),...(i%3===0?{aspectRatio:2}:{}),...(grid&&j===0?{gridPlacement:{column:0,row:0,rowSpan:2}}:{})};
    return {id:`n${j}`,parent:'root',kind:'leaf',intrinsicSize:[12+j*4,8+j],style};
  });
  const c={id:`hya-compat-${i}`,width:160+i,height:100+i%11,root,children};
  const parsed=spec.parseResponsiveLayoutDocument(documentFor(responsiveLayoutFixture(),c)),evaluator=new runtime.LayoutEvaluator(parsed);
  try{c.expected=evaluator.evaluate({viewport:[c.width,c.height],dpr:1,time:0}).nodes.map(({nodeId,rect})=>({nodeId,rect}));}
  finally{evaluator.dispose();}
  cases.push(c);
}
const output='extensions/test/shared-layout-hya-baseline.json';
writeFileSync(output,JSON.stringify({schemaVersion:1,referenceRevision:revision,sourceSha256:sha(source),originalWorkingFileSha256:prior.sourceSha256,purpose:'frozen legacy expected geometry; no legacy solver retained',cases},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,cases:cases.length,sha256:sha(readFileSync(output))}));
