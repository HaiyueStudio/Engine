import type {GuiLabel} from './components/GuiLabel';
import type {GuiHelpDialog} from './components/GuiHelpDialog';
import {GuiDirtyFlags} from './GuiTypes';
type Measure=(text:string,fontSize:number)=>number;
const labelWidths=new WeakMap<GuiLabel,number>(),helpMetrics=new WeakMap<GuiHelpDialog,{measure:Measure;version:number}>();
export function guiLabelMeasuredTextWidth(label:GuiLabel):number|undefined{return labelWidths.get(label);}
export function setGuiLabelMeasuredTextWidth(label:GuiLabel,width:number):void{if(labelWidths.get(label)===width)return;labelWidths.set(label,width);label.markDirty(GuiDirtyFlags.Layout);}
export function guiHelpDialogTextMetrics(dialog:GuiHelpDialog){return helpMetrics.get(dialog);}
export function setGuiHelpDialogTextMetrics(dialog:GuiHelpDialog,measure:Measure,version?:number):void{const previous=helpMetrics.get(dialog),next=version??(previous?.measure===measure?previous.version:(previous?.version??0)+1);helpMetrics.set(dialog,{measure,version:next});if(previous?.version!==next)dialog.markDirty(GuiDirtyFlags.Layout|GuiDirtyFlags.Text|GuiDirtyFlags.Visual);}
