import {GuiRoot,GuiFocusManager,GuiInput,GuiLabel,GuiScrollView} from '@haiyue/engine/gui';
import {GuiDatePicker,GuiTimePicker} from '@haiyue/extensions/gui-pickers';
import {GuiUpload,GuiQRCode,createGuiQrCanvasRasterizer} from '@haiyue/extensions/gui-assets';
import {GuiAnchor,GuiAffix,GuiMasonry,GuiTour,GuiWatermark,GuiBorderBeam} from '@haiyue/extensions/gui-composition';
import {GuiMentions,GuiVirtualKeyboard,GuiVirtualMouse,GuiHistoryControls} from '@haiyue/extensions/gui-assistive';
const root=new GuiRoot(),focus=new GuiFocusManager(),viewport=new GuiScrollView();
new GuiDatePicker({root,focusManager:focus,value:'2024-02-29',firstDayOfWeek:1});
new GuiTimePicker({seconds:true,value:'12:30:10',onChange:time=>time?.toUpperCase()});
new GuiUpload({host:{pick:async signal=>signal.aborted?[]:[{key:'f',name:'f.txt',size:2,type:'text/plain',data:new Uint8Array(2)}],upload:async(_file,signal,progress)=>{progress(.5);return signal.aborted?'':'done';}}});
new GuiQRCode({encode:()=>({size:21,cells:new Uint8Array(441)}),rasterize:createGuiQrCanvasRasterizer(()=>document.createElement('canvas'))});
new GuiAnchor({viewport,items:[{key:'x',label:'X',target:new GuiLabel()}]});
new GuiAffix({viewport,content:new GuiLabel(),contentOffset:0});
new GuiMasonry({items:[{key:'x',content:new GuiLabel(),height:100}]});
new GuiTour({root,focusManager:focus,steps:[{key:'x',target:new GuiInput(),title:'Edit',description:'Type here',prepare:async signal=>{if(signal.aborted)return;}}]});
new GuiWatermark({content:new GuiLabel(),text:'Private'});new GuiBorderBeam({content:new GuiLabel(),paused:true});
const input=new GuiInput();new GuiMentions({suggestions:()=>[{key:'a',label:'A',value:'a'}]});new GuiVirtualKeyboard({target:()=>input});
new GuiVirtualMouse({host:{bounds:()=>({x:0,y:0,width:200,height:100}),dispatch:event=>{const pressed:0|1=event.buttons;void pressed;}}});
new GuiHistoryControls({history:{read:()=>({canUndo:false,canRedo:false,entries:[]}),subscribe:()=>()=>{},undo(){},redo(){}}});
// @ts-expect-error A QR presenter must receive its encoder and raster host.
new GuiQRCode({value:'x'});
// @ts-expect-error Upload never silently chooses a network transport.
new GuiUpload({});
// @ts-expect-error A virtual mouse requires an explicit routed pointer host.
new GuiVirtualMouse({});
// @ts-expect-error Business history is not created by the visual controller.
new GuiHistoryControls({});
