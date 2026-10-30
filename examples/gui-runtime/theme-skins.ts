import {GuiButton,GuiElement,GuiInput,GuiLabel,GuiRoot,GuiToast} from '@haiyue/engine/gui';
import type {GuiElementOptions,GuiSystem} from '@haiyue/engine/gui';
import type {HaiyueEngine} from '@haiyue/engine';

type Resource=NonNullable<GuiElementOptions['themeResource']>;
/** Immutable application resources use the structural contract; G13 admits the new named constructors. */
export function attachThemeSkins(engine:HaiyueEngine,system:GuiSystem,root:GuiRoot):()=>void {
  const canvas=engine.canvas!,skin=(a:string,b:string)=>{
    const image=document.createElement('canvas');image.width=image.height=30;const ctx=image.getContext('2d')!;
    ctx.fillStyle=a;ctx.fillRect(0,0,30,30);ctx.fillStyle=b;ctx.fillRect(6,6,18,18);return image;
  };
  const resources:Resource[]=[['#164e63','#083344','#67e8f9'],['#713f12','#422006','#fde047']].map(([edge,fill,accent])=>{
    const normal=skin(edge!,fill!),active=skin(accent!,edge!);
    return Object.freeze({version:1,subscribe:()=>()=>{},resolve(type:string,state:{hover:boolean;pressed:boolean;focus:boolean;disabled:boolean}){
      if(type==='*')return {fontFamily:'sans-serif',fontSize:18,palette:{primary:accent!,text:'#ffffff',surface:fill!,border:edge!}};
      if(type==='GuiButton')return {nineSlice:{source:state.hover||state.pressed?active:normal,sourceWidth:30,sourceHeight:30,cuts:[6,6,6,6] as const},contentInsets:{left:14,right:14,top:6,bottom:6},opacity:state.disabled ? 0.5 : 1};
      if(type==='GuiInput')return {backgroundColor:fill!,borderColor:state.focus?accent!:edge!,padding:10};
      return {};
    }});
  });
  let selected=0;
  root.setThemeResource(resources[selected]!);
  const panel=root.add(new GuiElement({id:'theme-panel',x:24,y:28,width:500,height:360}));
  panel.add(new GuiLabel({text:'Reusable theme resources',width:460,height:38,fontSize:24}));
  const name=panel.add(new GuiInput({id:'theme-name',value:'Player',y:60,width:320,height:44}));
  const toast=root.add(new GuiToast({id:'theme-toast',text:'Saved',x:24,y:320,width:320}));
  panel.add(new GuiButton({id:'theme-save',text:'Save',y:126,width:150,height:48,onClick:()=>toast.show({text:`Saved ${name.value}`})}));
  const switcher=panel.add(new GuiButton({id:'theme-switch',text:'Switch theme',x:170,y:126,width:150,height:48,onClick:()=>{selected=1-selected;root.setThemeResource(resources[selected]!);publish();}}));
  panel.add(new GuiButton({id:'theme-disabled',text:'Disabled',y:196,width:150,height:48,disabled:true}));
  panel.add(new GuiButton({id:'theme-local',text:'Local red text',x:170,y:196,width:150,height:48,style:{color:'#fca5a5'}}));
  const publish=()=>{canvas.dataset.themeSkins=JSON.stringify({selected,focus:system.focus.focused?.id??null,value:name.value,tree:panel.children.map(e=>e.id)});};
  const off=root.onInvalidation(publish);publish();
  return()=>{off();root.setThemeResource(null);root.remove(panel);root.remove(toast);delete canvas.dataset.themeSkins;void switcher;};
}
