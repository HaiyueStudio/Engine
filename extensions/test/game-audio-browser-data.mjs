export function pcm16Wave(rate=48000,frames=4800,value=.25){
 const bytes=new ArrayBuffer(44+frames*2),view=new DataView(bytes),text=(offset,s)=>[...s].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
 text(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,frames*2,true);for(let i=0;i<frames;i++)view.setInt16(44+i*2,Math.round(value*32768),true);return bytes;
}
export async function hyaDocument(){
 const bytes=pcm16Wave(),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');let binary='';for(const v of new Uint8Array(bytes))binary+=String.fromCharCode(v);
 return {format:'haiyue-audio-events',version:1,extension:'org.haiyue.audio-events@1',playbackProfile:'sample-accurate',clock:{sampleRate:48000,lookAheadFrames:4800,driftToleranceFrames:64,driftPolicy:'resync',lateDecodePolicy:'catch-up',visibilityPolicy:'pause-resume',suspendedPolicy:'queue-until-resume'},browser:{autoplay:'require-user-gesture'},limits:{maxVoices:4,maxVoicesPerResource:3,maxDecodeJobs:2,maxEventTokens:32,maxDecodedFrames:10000,maxDecodedBytes:40000},voiceStealing:'reject',resources:[{id:'hya-tone',codec:'wav',mediaType:'audio/wav',sampleRate:48000,channels:1,frameLength:4800,integrity:{algorithm:'sha256',digest},source:{kind:'embedded',data:btoa(binary)}}],buses:[{id:'master',gain:1}],cues:[{id:'loop',resource:'hya-tone',owner:'panel',bus:'master',gain:.1,rate:1,offsetFrames:0,loop:{startFrame:0,endFrame:4800,iterations:'infinite'},overlap:'restart',priority:1}],timelineEvents:[]};
}
/** Transparent native-node audit; metadata contains no strong native-node references. */
export function auditContext(context){
 const live=new Set(),metadata=new Map();let sequence=0,peak=0;
 for(const[method,kind]of[['createBufferSource','source'],['createGain','gain'],['createStereoPanner','panner']]){
  const create=context[method].bind(context);context[method]=(...args)=>{const node=create(...args),id=++sequence,record={kind,parameterWrites:0};live.add(id);metadata.set(id,record);peak=Math.max(peak,live.size);const parameter=kind==='gain'?node.gain:kind==='panner'?node.pan:null;if(parameter){const set=parameter.setValueAtTime.bind(parameter);parameter.setValueAtTime=(...args)=>{record.parameterWrites++;return set(...args);};}const disconnect=node.disconnect.bind(node);node.disconnect=(...args)=>{const result=disconnect(...args);live.delete(id);return result;};return node;};
 }
 return {snapshot:()=>({live:live.size,created:sequence,peak,sourceNodes:[...metadata.values()].filter(v=>v.kind==='source').length,parameterWrites:[...metadata.values()].reduce((sum,v)=>sum+v.parameterWrites,0)})};
}
export const waitFor=async predicate=>{const deadline=performance.now()+5000;while(!predicate()){if(performance.now()>deadline)throw Error('Native audio completion timed out.');await new Promise(r=>setTimeout(r,10));}};
