export class AudioParamAudit {value=0;writes=[];setValueAtTime(value,time){this.value=value;this.writes.push([value,time]);}}
export class AudioNodeAudit {
 constructor(context,type){this.context=context;this.type=type;this.connections=[];this.disconnections=0;context.nodes.push(this);}
 connect(node){if(this.context.failConnect){this.context.failConnect=false;throw Error('connect failed');}this.connections.push(node);return node;}
 disconnect(){this.connections.length=0;this.disconnections++;}
}
class Source extends AudioNodeAudit {
 constructor(context){super(context,'source');this.buffer=null;this.loop=false;this.playbackRate=new AudioParamAudit();this.onended=null;this.starts=0;this.stops=0;this.index=context.sources.length;context.sources.push(this);}
 start(){if(this.context.failStart){this.context.failStart=false;throw Error('start failed');}this.starts++;this.context.trace.push(['start',this.index]);}
 stop(){this.stops++;this.context.trace.push(['stop',this.index]);this.finish();}
 finish(){this.onended?.();}
}
class Gain extends AudioNodeAudit {gain=new AudioParamAudit();constructor(context){super(context,'gain');context.gains.push(this);}}
class Panner extends AudioNodeAudit {pan=new AudioParamAudit();constructor(context){super(context,'panner');context.panners.push(this);}}
export class AudioContextAudit {
 state='suspended';currentTime=0;sampleRate=48000;destination={};nodes=[];sources=[];gains=[];panners=[];trace=[];closed=0;decodeRequests=[];
 constructor({pan=true}={}){if(!pan)this.createStereoPanner=undefined;}
 createBufferSource(){return new Source(this);}
 createGain(){if(this.failGain){this.failGain=false;throw Error('gain failed');}return new Gain(this);}
 createStereoPanner(){return new Panner(this);}
 async resume(){this.state='running';}
 async suspend(){this.state='suspended';}
 async close(){this.closed++;this.state='closed';}
 decodeAudioData(bytes){if(this.deferDecode)return new Promise((resolve,reject)=>this.decodeRequests.push({bytes,resolve,reject}));return Promise.resolve(audioBuffer('decoded'));}
}
export const audioBuffer=id=>({id,sampleRate:48000,length:480,numberOfChannels:1,duration:.01});
export const audioRequest=(eventId,owner='owner',channel='channel',priority=0)=>({eventId,bufferId:'tone',owner,channel,bus:'sfx',priority,startTick:1});
