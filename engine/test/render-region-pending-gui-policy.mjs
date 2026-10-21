import assert from 'node:assert/strict';
export const PENDING_GUI_SCENARIOS=Object.freeze(['shape','text','image','image-version','image-source','font','remove','destroy','cancel','growth','viewport']);
export function pendingGuiFixtureSpec(args=[]){if(args.length)throw Error('Pending GUI capture accepts no arguments.');return{id:'pending-gui',fixture:'pending-gui',mounted:false,count:260,query:{},workload:{width:96,height:64,formats:['rgba8unorm','rgba16float'],msaa:[1,4],framesBeforeSubmission:6,pixelTolerance:2,reference:'independent immediately submitted actual GUI renderers',scenarios:PENDING_GUI_SCENARIOS,deviceClass:'native-desktop'}};}
export function validatePendingGuiResult(result){
 assert.equal(result.status,'passed');assert.equal(result.caseCount,260);assert.equal(result.cases.length,260);
 const seen=new Set();for(const format of ['rgba8unorm','rgba16float'])for(const samples of [1,4])for(const kind of PENDING_GUI_SCENARIOS)for(let n=0;n<6;n++){
  if(kind==='cancel'&&n===1)continue;const id=`${kind}-${format}-${samples}-${n}`,rows=result.cases.filter(c=>c.id===id);assert.equal(rows.length,1,`Missing or duplicate ${id}`);const row=rows[0];seen.add(row);
  const width=kind==='viewport'?[96,128,80,112,72,120][n]:96;assert.equal(row.channelsCompared,width*64*4);assert.equal(row.differentChannels,0);assert.ok(Number.isFinite(row.maxRawChannelDifference)&&row.maxRawChannelDifference<=2/255);
 }
 assert.equal(seen.size,260);for(const kind of ['buffer','texture'])assert.equal(result.residue?.[kind]?.current,0,`${kind} residue`);assert.deepEqual(result.errors,[]);return result;
}
