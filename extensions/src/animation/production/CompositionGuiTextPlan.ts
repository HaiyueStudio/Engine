import type {ProductionCompositionDefinition} from './CompositionOwner.js';
import type {RuntimeBinding} from '../interaction/runtime-types.js';
import type {RuntimeTextBlock} from '../text/parameterized/runtime-types.js';
import type {CompositionGuiTarget} from './CompositionInputOwner.js';
import {ProductionFrameError} from './FrameTransaction.js';

export interface GuiTextBinding {readonly part:string;readonly binding:string;}
export interface GuiTextPlan {
 readonly part:string;readonly block:RuntimeTextBlock;
 readonly reader?:GuiTextBinding;readonly writers:readonly GuiTextBinding[];
 readonly target?:CompositionGuiTarget;
}
/** Resolve authored target addresses/ports, never an ID spelling convention. */
export function compileGuiTextPlans(definition:ProductionCompositionDefinition):ReadonlyMap<string,GuiTextPlan>{
 const targets=new Map(definition.targets.map(t=>[t.id,t])),plans=new Map<string,GuiTextPlan>();
 for(const layout of definition.parts)if(layout.kind==='layout')for(const block of layout.document.textBlocks)if(block.input){
  const bindings:Array<{part:string;binding:RuntimeBinding}>=[];
  for(const data of definition.parts)if(data.kind==='data')for(const binding of data.document.bindings){
   const target=targets.get(binding.target);
   if(target?.kind==='text-block'&&target.part===layout.id&&target.address[0]===block.id&&binding.targetPath.length===2&&binding.targetPath[0]==='strings')bindings.push({part:data.id,binding});
  }
  const reads=(port:string|undefined)=>bindings.filter(b=>b.binding.direction!=='write'&&b.binding.targetPath[1]===port);
  const primary=reads(block.input.valuePort),fallback=reads(block.runs[0]?.valuePort),readers=primary.length?primary:fallback;
  if(readers.length>1)throw new ProductionFrameError('E_HYA_RUNTIME_BINDING',block.id,'editable text has multiple readable owners for its primary value');
  const reader=readers[0],writes=(port:string)=>bindings.filter(b=>b.binding.direction!=='read'&&b.binding.targetPath[1]===port);
  const own=writes(block.input.valuePort),writers=own.length?own:reader?writes(reader.binding.targetPath[1]!):[];
  const associations:CompositionGuiTarget[]=[];
  for(const semantics of definition.parts)if(semantics.kind==='semantics')for(const node of semantics.document.nodes){
   if(node.role!=='textbox'||node.value?.kind!=='binding'||!node.value.binding)continue;
   const value=bindings.filter(b=>b.binding.id===node.value!.binding&&semantics.dependencies.includes(b.part)&&b.binding.targetPath[1]===(reader?.binding.targetPath[1]??block.input!.valuePort));
   if(!value.length)continue;
   if(value.length!==1)throw new ProductionFrameError('E_HYA_RUNTIME_REFERENCE',node.id,'textbox value binding is ambiguous');
   const target=targets.get(node.target);
   if(target?.kind!=='interaction-target')continue;
   const interaction=definition.parts.find(p=>p.id===target.part);
   if(interaction?.kind!=='interaction'||!interaction.document.targets.find(t=>t.id===target.address[0])?.focusable)throw new ProductionFrameError('E_HYA_RUNTIME_INPUT',node.id,'textbox target must be focusable');
   if(!associations.some(a=>a.part===target.part&&a.id===target.address[0]))associations.push({part:target.part,id:target.address[0]!});
  }
  if(associations.length>1)throw new ProductionFrameError('E_HYA_RUNTIME_REFERENCE',block.id,'editable text has multiple interaction owners');
  plans.set(JSON.stringify([layout.id,block.id]),Object.freeze({part:layout.id,block,...(reader?{reader:{part:reader.part,binding:reader.binding.id}}:{}),writers:Object.freeze(writers.map(w=>Object.freeze({part:w.part,binding:w.binding.id}))),...(associations[0]?{target:Object.freeze(associations[0])}:{})}));
 }
 return plans;
}
