import {EngineError,EngineErrorCode} from '../core/EngineError';
export type AudioMixerBus = 'music' | 'sfx' | 'ui';
export interface AudioMixerVolumes {readonly master:number;readonly music:number;readonly sfx:number;readonly ui:number;}
export interface AudioMixerCapabilities {readonly stereoPan:boolean|null;readonly maxDecodedChannels:2;}

export interface AudioMixerPlayRequest {
  readonly eventId: string;
  readonly bufferId: string;
  readonly owner: string;
  readonly channel: string;
  readonly bus: AudioMixerBus;
  readonly priority?: number;
  /** False keeps an existing owner/channel voice and rejects this request. */
  readonly replaceChannel?: boolean;
  readonly loop?: boolean;
  readonly volume?: number;
  readonly pan?: number;
  readonly frequency?: number;
  readonly startTick: number;
}

export interface OwnerSafeAudioMixerOptions {
  readonly context?: AudioContext;
  readonly contextFactory?: () => AudioContext;
  readonly ownsContext?: boolean;
  /** An exclusive, owned output for platforms with their own audio engine. */
  readonly host?: AudioMixerHost;
  readonly maxVoicesTotal?: number;
  readonly maxVoicesPerOwner?: number;
}

interface AudioMixerHostVoice {
  readonly nodeCount: number;
  readonly stereoPan: boolean;
  start(onEnded: () => void): void;
  stop(): void;
  setGain(gain: number): void;
  setPan(pan: number): void;
  dispose(): void;
}

interface AudioMixerHost {
  readonly state: 'suspended' | 'interrupted' | 'running' | 'closed';
  readonly stereoPan: boolean;
  readonly sampleRate: number;
  /** Output and bus nodes, excluding the nodes reported by each voice. */
  readonly nodeCount: number;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer>;
  /** Prepare reusable device data when a new buffer is installed. */
  prepareBuffer?(buffer: AudioBuffer): void;
  /** Release one installation. Active voices retain their own playback reference. */
  releaseBuffer?(buffer: AudioBuffer): void;
  openVoice(buffer: AudioBuffer, options: Readonly<{
    bus: AudioMixerBus; loop: boolean; frequency: number; gain: number; pan: number;
  }>): AudioMixerHostVoice;
  setMasterVolume(value: number): void;
  setBusVolume(bus: AudioMixerBus, value: number): void;
  close(): void;
}

export interface AudioMixerStats {
  readonly state: 'locked' | 'running' | 'suspended' | 'closed';
  readonly buffers: number;
  readonly voices: number;
  readonly owners: number;
  readonly audioNodes: number;
  readonly decodeJobs: number;
  readonly sampleRate: number | null;
  readonly disposed: boolean;
}

interface Voice {
  readonly id: string;
  readonly eventId: string;
  readonly owner: string;
  readonly channel: string;
  readonly priority: number;
  readonly sequence: number;
  readonly output: AudioMixerHostVoice;
  baseGain:number;
  basePan:number;
  appliedGain:number;
  appliedPan:number;
  lease:VoiceLeaseState|null;
  retired: boolean;
}
interface SpatialGain {readonly pan:number;readonly factor:number;readonly volume?:number;}
interface VoiceLeaseState {readonly voices:Set<string>;closed:boolean;}
// Private cross-package cooperation over this original owner, absent from declarations/exports.
interface GameAudioLease {
  play(request:AudioMixerPlayRequest,spatial?:SpatialGain):string|null;
  spatial(owner:string,channel:string,value:SpatialGain|null):boolean;
  release():void;
}

const BUS_IDS: readonly AudioMixerBus[] = Object.freeze(['music', 'sfx', 'ui']);

class WebAudioVoice implements AudioMixerHostVoice {
  constructor(private readonly context:AudioContext,private readonly source:AudioBufferSourceNode,
    private readonly gain:GainNode,private readonly panner:StereoPannerNode|null){}
  get nodeCount():number{return this.panner?3:2;}
  get stereoPan():boolean{return this.panner!==null;}
  start(onEnded:()=>void):void{this.source.onended=onEnded;this.source.start();}
  stop():void{this.source.stop();}
  setGain(value:number):void{this.gain.gain.setValueAtTime(value,this.context.currentTime);}
  setPan(value:number):void{this.panner?.pan.setValueAtTime(value,this.context.currentTime);}
  dispose():void{this.source.onended=null;disconnectWebVoice(this.source,this.gain,this.panner);}
}

/** One buffer/voice owner for Web Audio or an explicit platform output. */
export class OwnerSafeAudioMixer {
  readonly maxVoicesTotal: number;
  readonly maxVoicesPerOwner: number;
  readonly #ownsContext: boolean;
  readonly #contextFactory: () => AudioContext;
  #host: AudioMixerHost | null;
  readonly #buffers = new Map<string, AudioBuffer>();
  readonly #voices = new Map<string, Voice>();
  readonly #channels = new Map<string, string>();
  readonly #ownerCounts = new Map<string,number>();
  readonly #decodeIntents = new Map<string,object>();
  readonly #busVolumes = new Map<AudioMixerBus, number>(BUS_IDS.map(id => [id, 1]));
  #context: AudioContext | null;
  #master: GainNode | null = null;
  #buses = new Map<AudioMixerBus, GainNode>();
  #masterVolume = 1;
  #decodeJobs = 0;
  #sequence = 0;
  #disposed = false;
  #unlocked = false;
  #voiceNodes = 0;
  #stereoPan:boolean|null = null;

  constructor(options: OwnerSafeAudioMixerOptions = {}) {
    if (options.host && (options.context || options.contextFactory || options.ownsContext !== undefined)) throw new TypeError('An audio host cannot be combined with Web Audio context options.');
    this.maxVoicesTotal = integerRange(options.maxVoicesTotal ?? 128, 1, 1024, 'maxVoicesTotal');
    this.maxVoicesPerOwner = integerRange(options.maxVoicesPerOwner ?? 32, 1, this.maxVoicesTotal, 'maxVoicesPerOwner');
    this.#context = options.context ?? null;
    this.#host = options.host ?? null;
    this.#ownsContext = options.ownsContext ?? options.context === undefined;
    this.#contextFactory = options.contextFactory ?? defaultContextFactory;
    if (this.#context) this.#installGraph(this.#context);
    if (this.#host) this.#stereoPan = this.#host.stereoPan;
    Object.defineProperty(this,Symbol.for('haiyue.audio.game-lease.v1'),{
      value:Object.freeze({version:1,acquire:()=>this.#newLease()}),
    });
  }

  async unlock(): Promise<void> {
    this.#assertLive();
    const output = this.#host ?? this.#requireContext();
    if (output.state !== 'running') await output.resume();
    this.#assertLive();
    if (this.#host) this.#stereoPan = this.#host.stereoPan;
    this.#unlocked = true;
  }

  async suspend(): Promise<void> {
    this.#assertLive();
    const context = this.#host ?? this.#context;
    if (!context || context.state === 'suspended') return;
    await context.suspend();
  }

  async resume(): Promise<void> { await this.unlock(); }

  installBuffer(id: string, buffer: AudioBuffer): void {
    this.#assertLive();
    const key = identifier(id, 'buffer id');
    if (!buffer || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 || !Number.isSafeInteger(buffer.length) || buffer.length < 1 || !Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new TypeError('Audio buffer metadata is invalid.');
    const previous=this.#buffers.get(key);
    this.#host?.prepareBuffer?.(buffer);
    this.#buffers.set(key, buffer);
    if(previous)this.#host?.releaseBuffer?.(previous);
    this.#decodeIntents.delete(key);
  }

  async decodeAndInstall(id: string, bytes: ArrayBuffer): Promise<AudioBuffer> {
    this.#assertLive();
    const key=identifier(id,'buffer id');
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 12) throw new TypeError('Encoded audio bytes are invalid.');
    const context = this.#host ?? this.#requireContext();
    const intent={};this.#decodeIntents.set(key,intent);
    this.#decodeJobs++;
    try {
      const buffer = await context.decodeAudioData(bytes.slice(0));
      this.#assertLive();
      if(this.#decodeIntents.get(key)!==intent)throw new EngineError(EngineErrorCode.AssetJobAborted,'A newer audio buffer operation owns this id.');
      this.installBuffer(key, buffer);
      return buffer;
    } finally { this.#decodeJobs--;if(this.#decodeIntents.get(key)===intent)this.#decodeIntents.delete(key); }
  }

  play(request: AudioMixerPlayRequest): string | null {
    this.#assertLive();
    if (!this.#unlocked || (this.#host ?? this.#context)?.state !== 'running') return null;
    const owner = identifier(request.owner, 'owner'); const channel = identifier(request.channel, 'channel'); const eventId = identifier(request.eventId, 'event id');
    const buffer = this.#buffers.get(identifier(request.bufferId, 'buffer id'));
    if (!buffer) throw new RangeError(`Unknown audio buffer: ${request.bufferId}.`);
    if (!BUS_IDS.includes(request.bus)) throw new TypeError(`Unknown audio bus: ${String(request.bus)}.`);
    const priority = integerRange(request.priority ?? 0, -1_000_000, 1_000_000, 'priority');
    const frequency=finiteRange(request.frequency??1,.125,8,'frequency'),volume=finiteRange(request.volume??1,0,4,'volume'),pan=finiteRange(request.pan??0,-1,1,'pan');
    if(request.loop!==undefined&&typeof request.loop!=='boolean')throw new TypeError('Audio loop must be boolean.');
    const ownerChannel = `${owner}\u0000${channel}`; const replaced = this.#channels.get(ownerChannel); if (request.replaceChannel !== undefined && typeof request.replaceChannel !== 'boolean') throw new TypeError('Audio replaceChannel must be boolean.'); if (replaced && request.replaceChannel === false) return null; if (replaced) this.stopVoice(replaced);
    this.#makeRoom(owner, priority);
    const options={bus:request.bus,loop:request.loop??false,frequency,gain:volume,pan};
    const output=this.#host?this.#host.openVoice(buffer,options):this.#openWebVoice(buffer,options);
    const sequence=++this.#sequence,id=`voice:${sequence}`;
    const voice:Voice={id,eventId,owner,channel,priority,sequence,output,baseGain:volume,basePan:pan,appliedGain:volume,appliedPan:pan,lease:null,retired:false};
    this.#voices.set(id,voice);this.#channels.set(ownerChannel,id);
    this.#ownerCounts.set(owner,(this.#ownerCounts.get(owner)??0)+1);this.#voiceNodes+=output.nodeCount;
    try{
      output.start(()=>this.#retire(voice));return id;
    }catch(error){this.#retire(voice);throw error;}
  }

  stop(owner: string, channel?: string): number {
    this.#assertLive(); const ownerId = identifier(owner, 'owner'); let count = 0;
    for (const voice of this.#voices.values()) if (voice.owner === ownerId && (channel === undefined || voice.channel === channel)) { this.stopVoice(voice.id); count++; }
    return count;
  }

  setPan(owner: string, channel: string, value: number): boolean {
    this.#assertLive();
    const ownerId = identifier(owner, 'owner'); const channelId = identifier(channel, 'channel'); const pan = finiteRange(value, -1, 1, 'pan');
    const voiceId = this.#channels.get(`${ownerId}\u0000${channelId}`); const voice = voiceId === undefined ? undefined : this.#voices.get(voiceId);
    if (!voice?.output.stereoPan) return false;
    voice.output.setPan(pan);voice.basePan=pan;voice.appliedPan=pan;return true;
  }

  setGain(owner:string,channel:string,value:number):boolean {
    this.#assertLive();const ownerId=identifier(owner,'owner'),channelId=identifier(channel,'channel'),gain=finiteRange(value,0,4,'gain');
    const id=this.#channels.get(`${ownerId}\u0000${channelId}`),voice=id===undefined?undefined:this.#voices.get(id);if(!voice)return false;
    voice.output.setGain(gain);voice.baseGain=gain;voice.appliedGain=gain;return true;
  }
  getVolumes():AudioMixerVolumes {return Object.freeze({master:this.#masterVolume,music:this.#busVolumes.get('music')!,sfx:this.#busVolumes.get('sfx')!,ui:this.#busVolumes.get('ui')!});}
  getCapabilities():AudioMixerCapabilities {return Object.freeze({stereoPan:this.#host?.stereoPan??this.#stereoPan,maxDecodedChannels:2});}

  stopVoice(id: string): boolean { const voice = this.#voices.get(id); if (!voice) return false; try { voice.output.stop(); } catch { /* ended already */ } this.#retire(voice); return true; }
  releaseOwner(owner: string): number { return this.stop(owner); }

  setMasterVolume(value: number): void { this.#masterVolume = finiteRange(value, 0, 4, 'master volume'); this.#host?.setMasterVolume(this.#masterVolume); if (this.#master && this.#context) this.#master.gain.setValueAtTime(this.#masterVolume, this.#context.currentTime); }
  setBusVolume(bus: AudioMixerBus, value: number): void { if (!BUS_IDS.includes(bus)) throw new TypeError(`Unknown audio bus: ${String(bus)}.`); const volume = finiteRange(value, 0, 4, 'bus volume'); this.#busVolumes.set(bus, volume); this.#host?.setBusVolume(bus,volume); const node = this.#buses.get(bus); if (node && this.#context) node.gain.setValueAtTime(volume, this.#context.currentTime); }
  removeBuffer(id: string): boolean {
    this.#decodeIntents.delete(id);
    const buffer=this.#buffers.get(id);
    if(!buffer)return false;
    this.#buffers.delete(id);this.#host?.releaseBuffer?.(buffer);return true;
  }

  dispose(): void {
    if (this.#disposed) return; this.#disposed = true;
    const errors:unknown[]=[];
    for (const voice of this.#voices.values()) try{this.stopVoice(voice.id);}catch(error){errors.push(error);}
    for (const node of this.#buses.values()) try { node.disconnect(); } catch { /* idempotent */ }
    try { this.#master?.disconnect(); } catch { /* idempotent */ }
    this.#buses.clear(); this.#buffers.clear(); this.#decodeIntents.clear();this.#channels.clear();this.#ownerCounts.clear();this.#master = null;
    if (this.#ownsContext) void this.#context?.close().catch(() => undefined);
    this.#context = null;
    const host=this.#host;this.#host=null;
    try{host?.close();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Audio mixer resources failed to close.');
  }

  get stats(): AudioMixerStats {
    const output=this.#host??this.#context;
    const contextState:string|undefined=output?.state;
    const baseNodes=this.#host?.nodeCount??((this.#master?1:0)+this.#buses.size);
    return Object.freeze({ state: this.#disposed || contextState === 'closed' ? 'closed' : !this.#unlocked ? 'locked' : contextState === 'suspended'||contextState==='interrupted' ? 'suspended' : 'running', buffers: this.#buffers.size, voices: this.#voices.size, owners:this.#ownerCounts.size, audioNodes:baseNodes+this.#voiceNodes, decodeJobs: this.#decodeJobs, sampleRate:output?.sampleRate??null, disposed: this.#disposed });
  }

  #requireContext():AudioContext {
    this.#assertLive();if(!this.#context){const context=this.#contextFactory();try{this.#installGraph(context);}catch(error){if(this.#ownsContext)void context.close().catch(()=>undefined);throw error;}this.#context=context;}return this.#context;
  }
  #installGraph(context:AudioContext):void {
    const nodes:GainNode[]=[],buses=new Map<AudioMixerBus,GainNode>();
    try{
      const master=context.createGain();nodes.push(master);master.gain.setValueAtTime(this.#masterVolume,context.currentTime);master.connect(context.destination);
      for(const id of BUS_IDS){const node=context.createGain();nodes.push(node);node.gain.setValueAtTime(this.#busVolumes.get(id)!,context.currentTime);node.connect(master);buses.set(id,node);}
      this.#master=master;this.#buses=buses;this.#stereoPan=typeof context.createStereoPanner==='function';
    }catch(error){for(const node of nodes)try{node.disconnect();}catch{/* already disconnected */}throw error;}
  }
  #openWebVoice(buffer:AudioBuffer,options:Parameters<AudioMixerHost['openVoice']>[1]):AudioMixerHostVoice {
    const context=this.#context!;
    let source:AudioBufferSourceNode|null=null,gain:GainNode|null=null,panner:StereoPannerNode|null=null;
    try{
      const input=source=context.createBufferSource(),level=gain=context.createGain();
      const stereo=panner=typeof context.createStereoPanner==='function'?context.createStereoPanner():null;
      input.buffer=buffer;input.loop=options.loop;input.playbackRate.setValueAtTime(options.frequency,context.currentTime);
      level.gain.setValueAtTime(options.gain,context.currentTime);input.connect(level);
      const bus=this.#buses.get(options.bus)!;
      if(stereo){stereo.pan.setValueAtTime(options.pan,context.currentTime);level.connect(stereo);stereo.connect(bus);}
      else level.connect(bus);
      return new WebAudioVoice(context,input,level,stereo);
    }catch(error){disconnectWebVoice(source,gain,panner);throw error;}
  }
  #makeRoom(owner:string,incomingPriority:number):void {
    while(this.#voices.size>=this.maxVoicesTotal||(this.#ownerCounts.get(owner)??0)>=this.maxVoicesPerOwner){
      const global=this.#voices.size>=this.maxVoicesTotal;let victim:Voice|undefined;
      for(const voice of this.#voices.values())if((global||voice.owner===owner)&&(!victim||voice.priority<victim.priority||voice.priority===victim.priority&&(voice.sequence<victim.sequence||voice.sequence===victim.sequence&&voice.id.localeCompare(victim.id)<0)))victim=voice;
      if(!victim||victim.priority>incomingPriority)throw new RangeError('Audio voice budget is exhausted by higher-priority voices.');this.stopVoice(victim.id);
    }
  }
  #retire(voice:Voice):void {
    if(voice.retired)return;voice.retired=true;
    this.#voices.delete(voice.id);this.#voiceNodes-=voice.output.nodeCount;
    const count=(this.#ownerCounts.get(voice.owner)??1)-1;if(count)this.#ownerCounts.set(voice.owner,count);else this.#ownerCounts.delete(voice.owner);
    voice.lease?.voices.delete(voice.id);voice.lease=null;
    const key=`${voice.owner}\u0000${voice.channel}`;if(this.#channels.get(key)===voice.id)this.#channels.delete(key);
    voice.output.dispose();
  }
  #newLease():GameAudioLease {
    this.#assertLive();const state:VoiceLeaseState={voices:new Set(),closed:false};
    return Object.freeze({
      play:(request:AudioMixerPlayRequest,spatial?:SpatialGain)=>{
        if(state.closed)throw new EngineError(EngineErrorCode.ResourceOwnerReleased,'Game audio lease is released.');
        const baseGain=finiteRange(request.volume??1,0,4,'volume'),basePan=finiteRange(request.pan??0,-1,1,'pan');
        if(spatial){checkedSpatial(spatial);}
        const id=this.play(spatial?{...request,volume:(spatial.volume??baseGain)*spatial.factor,pan:spatial.pan}:request);
        const voice=id===null?undefined:this.#voices.get(id);if(voice){voice.lease=state;voice.baseGain=baseGain;voice.basePan=basePan;state.voices.add(voice.id);}return id;
      },
      spatial:(owner:string,channel:string,value:SpatialGain|null)=>{
        if(state.closed||this.#disposed)return false;
        const id=this.#channels.get(`${owner}\u0000${channel}`),voice=id===undefined?undefined:this.#voices.get(id);if(!voice||voice.lease!==state)return false;
        if(value)checkedSpatial(value);const gain=value?(value.volume??voice.baseGain)*value.factor:voice.baseGain,pan=value?value.pan:voice.basePan;
        if(voice.appliedGain!==gain){voice.output.setGain(gain);voice.appliedGain=gain;}
        if(voice.output.stereoPan&&voice.appliedPan!==pan){voice.output.setPan(pan);voice.appliedPan=pan;}return true;
      },
      release:()=>{if(state.closed)return;state.closed=true;for(const id of state.voices)this.stopVoice(id);state.voices.clear();},
    });
  }
  #assertLive(): void { if (this.#disposed) throw new Error('Audio mixer is disposed.'); }
}

function disconnectWebVoice(source:AudioBufferSourceNode|null,gain:GainNode|null,panner:StereoPannerNode|null):void {
  for(const node of [source,gain,panner])try{node?.disconnect();}catch{/* already disconnected */}
}

function defaultContextFactory(): AudioContext { const Constructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext; if (!Constructor) throw new Error('Web Audio is unavailable.'); return new Constructor(); }
function identifier(value: string, label: string): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) throw new TypeError(`Audio ${label} is invalid.`); return value; }
function integerRange(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Audio ${label} must be from ${minimum} to ${maximum}.`); return value; }
function finiteRange(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`Audio ${label} must be from ${minimum} to ${maximum}.`); return value; }
function checkedSpatial(value:SpatialGain):void {finiteRange(value.pan,-1,1,'pan');finiteRange(value.factor,0,1,'distance factor');if(value.volume!==undefined)finiteRange(value.volume,0,4,'emitter volume');}
