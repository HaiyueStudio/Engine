import {
  negotiateHyaComposition, parseResponsiveLayoutDocument, parseHyaDataBinding, parseHyaInteraction,
  parseHyaSemantics, parseHyaAudioEvents, parseHyaStateMachineV2,
  type HyaCompositionPlan, type HyaCompositionParseOptions, type HyaCompositionDiagnostic,
} from '@haiyue/animation-spec/hya-production';
import {parseAnimation,type AnimationDocument} from '@haiyue/animation-spec';
import {ProductionCompositionOwner,type ProductionCompositionDefinition,type ProductionCompositionHost} from './CompositionOwner.js';
import {snapshotPlainTextData} from '../text/PlainTextData.js';
import type {RuntimeSemanticValue} from '../interaction/runtime-types.js';
import {ProductionFrameError} from './FrameTransaction.js';

type Part=ProductionCompositionDefinition['parts'][number];
type PartPortMap<T>=Pick<ReadonlyMap<string,T>,'get'>;
type Ports<K extends Part['kind']>=Omit<Extract<Part,{kind:K}>,'id'|'kind'|'document'|'dependencies'>;
export interface ProductionSourcePorts {
  readonly capabilities:ReadonlySet<string>;
  readonly core?:PartPortMap<Ports<'core'>>;
  readonly layout?:PartPortMap<Ports<'layout'>>;
  readonly data?:PartPortMap<Ports<'data'>>;
  readonly interaction?:PartPortMap<Ports<'interaction'>>;
  readonly semantics?:PartPortMap<Ports<'semantics'>>;
  readonly audio?:PartPortMap<Ports<'audio'>>;
  readonly state?:PartPortMap<Partial<Ports<'state'>>>;
}
export interface ProductionSourceCompilation {readonly plan:HyaCompositionPlan;readonly definition:ProductionCompositionDefinition;}
const kinds=new Map<string,Part['kind']>([
  ['org.haiyue.animation-core@1','core'],['org.haiyue.layout-2d@1','layout'],
  ['org.haiyue.data-binding@1','data'],['org.haiyue.interaction@1','interaction'],
  ['org.haiyue.semantics@1','semantics'],['org.haiyue.audio-events@1','audio'],
  ['org.haiyue.animation-state-machine@2','state'],
]);

/** Runtime admission follows the original format negotiator; validators/capability strings cannot install an executor. */
export function compileProductionSource(source:unknown,ports:ProductionSourcePorts,parse:HyaCompositionParseOptions={}):ProductionSourceCompilation{
  if(!ports?.capabilities||typeof ports.capabilities.has!=='function')throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT','$options.host.capabilities','explicit host capabilities are required');
  const declared=negotiateHyaComposition(source,ports.capabilities,parse),byId=new Map(declared.document.parts.map((part,index)=>[part.id,{part,index}]));
  const skipped=new Set<string>(),diagnostics:HyaCompositionDiagnostic[]=[...declared.diagnostics];
  const skip=(id:string,message:string):void=>{
    const {part,index}=byId.get(id)!;
    if(part.required||parse.strict!==false)throw new ProductionFrameError('E_HYA_RUNTIME_CAPABILITY',`$.parts[${index}].extension`,message);
    skipped.add(id);diagnostics.push(Object.freeze({code:'W_HYA_COMPOSITION_OPTIONAL_SKIPPED',part:id,path:`$.parts[${index}].extension`,capability:part.extension}));
  };
  for(const id of declared.activeParts)if(!kinds.has(byId.get(id)!.part.extension))skip(id,'no admitted runtime executor exists for this validated part');
  // Keep the same explicit dependency closure after runtime-specific admission.
  for(const id of declared.activeParts)if(!skipped.has(id)&&byId.get(id)!.part.dependencies.some(id=>skipped.has(id)))skip(id,'part depends on a runtime executor that was skipped');
  const active=declared.activeParts.filter(id=>!skipped.has(id)),activeSet=new Set(active);
  const plan:HyaCompositionPlan=Object.freeze({...declared,activeParts:Object.freeze(active),targets:Object.freeze(declared.targets.filter(target=>activeSet.has(target.part))),diagnostics:Object.freeze(diagnostics),complete:diagnostics.length===0});
  const parts:Part[]=active.map(id=>{
    const source=byId.get(id)!.part,kind=kinds.get(source.extension)!,base={id,dependencies:source.dependencies};
    try{
      switch(kind){
        case 'core':{
          // The original parser also checks the actual retained component/track envelope.
          parseAnimation(source.document as unknown as AnimationDocument);
          const document=snapshotPlainTextData(typeof source.document==='string'?JSON.parse(source.document):source.document,'$.parts['+byId.get(id)!.index+'].document',(path,message)=>{throw new ProductionFrameError('E_HYA_RUNTIME_FRAME',path,message);},{strict:true,maxBytes:64*1024*1024}) as unknown as AnimationDocument;
          return {...ports.core?.get(id),...base,kind,document};
        }
        case 'layout':return {...ports.layout?.get(id),...base,kind,document:parseResponsiveLayoutDocument(source.document)} as Extract<Part,{kind:'layout'}>;
        case 'data':return {...ports.data?.get(id),...base,kind,document:parseHyaDataBinding(source.document)} as Extract<Part,{kind:'data'}>;
        case 'interaction':return {...ports.interaction?.get(id),...base,kind,document:parseHyaInteraction(source.document)} as Extract<Part,{kind:'interaction'}>;
        case 'semantics':{
          const parsed=parseHyaSemantics(source.document);
          // Public semantic records have named fields; the original executor iterates dictionaries.
          const document:Extract<Part,{kind:'semantics'}>['document']={...parsed,reducedMotion:{...parsed.reducedMotion},nodes:parsed.nodes.map(node=>{
            const state:Record<string,RuntimeSemanticValue>={},capabilities:Record<string,boolean>={};
            for(const [name,value] of Object.entries(node.state??{}))if(value!==undefined)state[name]=value as RuntimeSemanticValue;
            for(const [name,value] of Object.entries(node.capabilities??{}))if(value!==undefined)capabilities[name]=value as boolean;
            return {...node,state:Object.freeze(state),capabilities:Object.freeze(capabilities)};
          })};
          return {...ports.semantics?.get(id),...base,kind,document};
        }
        case 'audio':{
          const host=ports.audio?.get(id);if(!host)throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT',`$.parts[${byId.get(id)!.index}].host.audio`,'the audio part requires its actual host port');
          return {...host,...base,kind,document:parseHyaAudioEvents(source.document)} as Extract<Part,{kind:'audio'}>;
        }
        case 'state':{
          const document=parseHyaStateMachineV2(source.document),host=ports.state?.get(id);
          return {...host,...base,kind,roots:host?.roots??document.stateMachines.map(machine=>machine.id),document} as Extract<Part,{kind:'state'}>;
        }
      }
    }catch(error){
      // Preserve the original parser error/code. This identifies its actual source part without rewriting history.
      if(error&&typeof error==='object'&&!('capability'in error)&&Object.isExtensible(error))Object.defineProperty(error,'capability',{value:source.extension,enumerable:true});
      throw error;
    }
  });
  return Object.freeze({plan,definition:Object.freeze({parts:Object.freeze(parts.map(part=>Object.freeze(part))),targets:plan.targets})});
}

/** Internal source factory used by the forthcoming public Player, with one existing whole-frame owner. */
export async function createProductionSourceComposition(source:unknown,options:Readonly<{
  ports:ProductionSourcePorts;host:ProductionCompositionHost;parse?:HyaCompositionParseOptions;signal?:AbortSignal;
}>):Promise<Readonly<{plan:HyaCompositionPlan;owner:ProductionCompositionOwner}>>{
  if(options.signal?.aborted)throw new ProductionFrameError('E_HYA_RUNTIME_ABORTED','$options.signal','source creation was cancelled');
  const compiled=compileProductionSource(source,options.ports,options.parse);
  const owner=await ProductionCompositionOwner.create(compiled.definition,options.host,options.signal);
  return Object.freeze({plan:compiled.plan,owner});
}
