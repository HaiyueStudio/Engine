const pixels=['initial','warm','restore-first','visible-ready-first','warm-ready','font-confirmed','font-warm','modal-close','modal-reopen','disabled-restore-first','disabled-image-ready','reenable-first','reenable-warm','wake'];
const warm=new Set(['warm','warm-ready','font-warm','reenable-warm','wake']);
const zero=['encoders','submits','uploads','bufferUploadBytes','textureUploads','textureUploadTexels','acquired','passes','guiRecords','sceneRecords','layouts','guiUploads','overlayRecords','overlayLayouts','overlayUploads'];
const hash=value=>/^[a-f0-9]{64}$/.test(value);
const check=(ok,message)=>{if(!ok)throw Error(`G04 async recovery: ${message}`)};
export function validateAsyncRecoveryReport(report){
 check(report?.status==='passed'&&report.caseCount===72&&report.cases?.length===72,'requires all 72 cases');
 check(Array.isArray(report.errors)&&report.errors.length===0,'GPU/cleanup errors');
 check(new Set(report.cases.map(row=>row.id)).size===72,'duplicate case');
 for(const scenario of ['during','after'])for(const samples of [1,4]){
  const get=phase=>{const row=report.cases.find(row=>row.id===`${phase}-${scenario}-msaa${samples}`);check(row?.samples===samples&&row.scenario===scenario,`missing ${phase}/${scenario}/${samples}`);return row};
  for(const phase of pixels){
   const row=get(phase);
   check(row.channelsCompared===192*128*4,'incomplete full canvas pixels');
   check(Number.isInteger(row.maxChannelDifference)&&row.maxChannelDifference>=0&&row.maxChannelDifference<=2,'pixel tolerance');
   check([row.sha256,row.controlSha256,row.fontBandSha256,row.controlFontBandSha256].every(hash),'pixel/font hashes');
   const count=['initial','visible-ready-first','modal-close','modal-reopen','reenable-first'].includes(phase)||scenario==='after'&&['restore-first','font-confirmed'].includes(phase)?1:0;
   for(const owner of ['candidate','control']){
    const m=row[owner];
    check(m?.sceneRecords===1&&m.overlayRecords===(owner==='control'&&phase==='restore-first'?0:count),'producer record counts');
    check(Number.isFinite(m.cpuRecordMs)&&m.cpuRecordMs>=0&&Number.isFinite(m.queueAndReadbackWaitMs)&&m.queueAndReadbackWaitMs>=0,'separate CPU and queue/readback costs');
    check(Number.isInteger(m.regions?.cachedRegions)&&m.regions.cachedRegions>=0&&m.regions.cachedRegions<=8&&Number.isFinite(m.regions.retainedColorBytes)&&m.regions.retainedColorBytes>=0&&m.regions.retainedColorBytes<=67108864,'cache bounds');
    if(warm.has(phase)||phase==='font-confirmed'&&scenario==='during')check(['guiRecords','overlayRecords','layouts','overlayLayouts','guiUploads','overlayUploads'].every(k=>m[k]===0),'warm GUI work');
    if(['restore-first','disabled-restore-first','disabled-image-ready','visible-ready-first','reenable-first'].includes(phase)){
     const pending=phase.startsWith('disabled-')||phase==='restore-first'&&scenario==='during';
     check(m.overlayState?.pendingOnce===pending,'pending once lost or stranded');
     check(m.overlayState?.visible===(phase==='restore-first'&&scenario==='during'?false:true),'visibility');
     if(phase.startsWith('disabled-'))check(m.overlayState.updateMode==='disabled','disabled mode');
    }
   }
   if(['visible-ready-first','warm-ready','font-confirmed','font-warm','modal-close','modal-reopen','reenable-first','reenable-warm','wake'].includes(phase)){
    const purple=['reenable-first','reenable-warm','wake'].includes(phase),source=purple?[128,48,208,255]:[32,192,80,255],expected=phase==='modal-close'?source:purple?[93,41,155,255]:[25,142,66,255];
    for(const image of [row.overlayImage,row.controlOverlayImage]){
     check(image?.sourceExpected?.every((v,i)=>v===source[i])&&image.sourceExpected.length===4,'wrong ready source');
     check(image.pixels?.length===2&&image.pixels.every(p=>p?.length===4&&p.every((v,i)=>Number.isInteger(v)&&Math.abs(v-expected[i])<=2)),'cross-boundary image probes');
    }
   }
  }
  const font=get('font-confirmed'),before=get(scenario==='during'?'initial':'visible-ready-first');
  for(const owner of ['candidate','control'])check(font[owner]?.readiness?.fontStatus==='loaded'&&font[owner].readiness.fontEvents>0,'font readiness event missing');
  check(font.fontBandSha256!==before.fontBandSha256&&font.controlFontBandSha256!==before.controlFontBandSha256,'no real glyph change');
  for(const [phase,generation] of [['loss-ready-timing',2],['loss-disabled',3]]){
   const row=get(phase);
   check(row.generation===generation&&row.adapter?.isFallbackAdapter===false,'native replacement generation');
   check(row.events?.some(e=>e.event==='device-lost'&&e.detail?.reason==='destroyed')&&row.events.some(e=>e.event==='device-restored'&&e.detail?.generation===generation)&&!row.events.some(e=>e.event==='recovery-failed'),'actual loss/restoration');
   if(phase==='loss-disabled')check(row.controlHistoryReinitialized===true,'disabled control history');
   if(phase==='loss-ready-timing'&&scenario==='during'){
    const d=row.duringEvidence;
    check(d?.stateBefore==='recovering'&&d.stateAfter==='recovering','readiness outside held replacement');
    check(d.images?.length===2&&d.images.every(i=>i.width===8&&i.height===8&&i.complete===true&&hash(i.dataUrlSha256)),'actual decoded images');
    check(d.fonts?.length===2&&d.fonts.every(f=>f.status==='loaded'&&f.events>0),'actual loaded fonts');
   }
  }
  for(const owner of ['candidate','control']){
   const idle=get('all-idle')[owner];check(zero.every(k=>idle?.[k]===0)&&idle.allocations&&Object.values(idle.allocations).every(v=>v===0),'idle work/allocation');
   const c=get('cleanup')[owner],n=owner==='candidate'?3:1;
   check(c?.devices===n&&c.adapters?.length===n&&c.adapters.every(a=>a.isFallbackAdapter===false),'cleanup device generations');
   check(c.imageListeners===0&&c.canvasListeners===0&&c.remaining?.length===0&&c.byType?.buffer?.current===0&&c.byType?.texture?.current===0,'owned listener/GPU residue');
  }
  check(get('cleanup').fontListeners===0,'FontFaceSet listener residue');
 }
 return {cases:72,pixelComparisons:56,channelsCompared:5505024,deviceReplacements:8};
}
