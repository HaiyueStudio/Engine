export const nativeAudioCaseIds=Object.freeze(['left-edge','left-half','center','right-half','right-edge','vertical-distance','quadratic-distance','explicit-emitter-base','stereo-source-center','linear-fade','external-ownership','native-pressure-32','native-pressure-128','shared-native-clock','native-static-parameters','native-suspend-resume','late-native-decode','hya-game-owner-isolation','borrowed-native-disposal']);
export function validateGameAudioBrowser(r,mode='native'){
 r=r&&typeof r==='object'?r:{};const cases=Array.isArray(r.cases)?r.cases:[];
 const errors=[];if(r.status!=='passed')errors.push('Native fixture failed.');
 if(mode==='hya'){
  const ids=['real-native-start-offset-gain-rate-stop-vs-independent-PCM','real-native-loop-region-retains-source-frame-units','real-44100-source-in-48000-host-preserves-declared-offset-and-metadata','bad-integrity','undefined-raw-pcm-layout','default-browser-host-rejects-cross-origin-before-network'];
  const first=cases.find(c=>c.id===ids[0]);
  if(r.caseCount!==6||cases.length!==6||ids.some(id=>cases.filter(c=>c.id===id).length!==1)||!Number.isFinite(first?.maximumSampleDifference)||first.maximumSampleDifference<0||first.maximumSampleDifference>1e-5||cases.find(c=>c.id===ids[1])?.loopEnded!==1||cases.find(c=>c.id===ids[2])?.decodedRate!==44100||cases.find(c=>c.id===ids[2])?.frames!==882||cases.find(c=>c.id===ids[3])?.code!=='E_AUDIO_RUNTIME_INTEGRITY'||cases.find(c=>c.id===ids[4])?.code!=='E_AUDIO_RUNTIME_PROFILE'||cases.find(c=>c.id===ids[5])?.code!=='E_AUDIO_RUNTIME_PORT')errors.push('Original six HYA analytical cases required.');
 }else if(mode==='application'){
  if(r.schemaVersion!==1||r.checks?.length!==6||r.final?.voices!==0||r.final?.audioNodes!==0||r.final?.buffers!==0)errors.push('Complete actual application proof required.');
 }else{
  if(r.schemaVersion!==1||cases.length!==19||nativeAudioCaseIds.some(id=>cases.filter(c=>c.id===id).length!==1))errors.push('Every native stereo/lifetime case required.');
  for(const id of nativeAudioCaseIds.slice(0,11)){const c=cases.find(c=>c.id===id);if(!Number.isFinite(c?.maxSampleDifference)||c.maxSampleDifference<0||c.maxSampleDifference>1e-5)errors.push('Native PCM mismatch '+id);}
  const stereo=cases.find(c=>c.id==='stereo-source-center'),stationary=cases.find(c=>c.id==='native-static-parameters'),suspend=cases.find(c=>c.id==='native-suspend-resume');if(stereo?.channels!==2||stereo.decodedBytes!==16384||stationary?.updates!==1000||stationary.extraWrites!==0||suspend?.clockStopped!==true||suspend.resumed!==true)errors.push('Stereo/static/suspension proof required.');
  for(const n of[32,128]){const c=cases.find(c=>c.id==='native-pressure-'+n);if(c?.voices!==n||c.peakNodes!==4+3*n||!(c.decodedBytes>0&&c.decodedBytes<=67108864))errors.push('Native voice/resource bound '+n);}
  const clock=cases.find(c=>c.id==='shared-native-clock'),end=cases.find(c=>c.id==='borrowed-native-disposal');
  if(clock?.trustedGesture!==true||!(clock.advancedFrames>2048))errors.push('Real native clock and browser gesture required.');
  if(end?.nodes?.live!==0||end.stats?.voices!==0||end.stats?.buffers!==0||end.stats?.audioNodes!==0||end.contextStillRunning!==true||end.handles?.decoded!==end.handles?.releasedDecoded||end.handles?.voices!==end.handles?.releasedVoices)errors.push('Borrowed-owner residue.');
  if(!(r.decodedBytes>0&&r.decodedBytes<=67108864))errors.push('Decoded byte budget.');
 }
 return{status:errors.length?'failed':'passed',errors};
}
