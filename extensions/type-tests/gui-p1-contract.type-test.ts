import {GuiRoot,GuiElement,GuiFocusManager,GuiInput,GuiSlider} from '@haiyue/engine/gui';
import {GuiCard,GuiTag,GuiSpin,GuiAvatar,GuiButtonGroup,GuiSegmented} from '@haiyue/extensions/gui-display';
import {GuiDropdown,GuiPopover,GuiDialog,GuiDrawer,GuiNotificationCenter} from '@haiyue/extensions/gui-overlays';
import {GuiExpandable} from '@haiyue/extensions/gui-controls';
import type {GuiCollectionRow,GuiCollectionRowState} from '@haiyue/extensions/gui-collections';
const root=new GuiRoot(),focusManager=new GuiFocusManager(),anchor=new GuiElement({focus:{mode:'all'}});root.add(anchor);
const card=new GuiCard({root,focusManager,title:'Profile',content:new GuiInput(),style:{parts:{title:{fontWeight:600},body:{padding:12}}}});
new GuiTag({text:'New',status:'success',onClose:()=>false});new GuiAvatar({label:'Hai Yue',size:40});new GuiSpin({spinning:true,delayMs:200});
new GuiButtonGroup({items:[{key:'a',label:'A'}],selection:'single',focusManager});new GuiSegmented({items:[{key:'a',label:'A'}]});
const popup=new GuiPopover({root,focusManager,anchor,content:new GuiElement(),placement:'bottom'});popup.openAt({x:10,y:20});popup.close('outside');
new GuiDropdown({root,focusManager,anchor,items:[{key:'a',label:'A',children:[{key:'b',label:'B'}]}]});
new GuiDialog({root,focusManager,content:card.element,footer:new GuiElement(),onConfirm:()=>false});new GuiDrawer({root,focusManager,content:new GuiElement(),side:'left'});
const notices=new GuiNotificationCenter({root,focusManager});notices.close(notices.open({key:'save',title:'Saved',durationMs:0}));
new GuiExpandable({title:'Details',content:new GuiElement(),variant:'ghost',animationMs:180});
const slider=new GuiSlider({range:[10,80],orientation:'vertical',marks:[{value:10,label:'Low'}],tooltip:'always'});slider.setRange([20,70]);
const row:GuiCollectionRow<string>={element:new GuiElement(),bind:()=>()=>{},setState(state:GuiCollectionRowState){const depth:number=state.depth;void depth;
// @ts-expect-error row presentation snapshots remain readonly
state.selected=false;},dispose(){}};
// @ts-expect-error unsupported popup placement
new GuiPopover({root,focusManager,content:new GuiElement(),placement:'diagonal'});
// @ts-expect-error notification duration is numeric
notices.open({title:'Saved',durationMs:'soon'});
// @ts-expect-error range is an exact pair
slider.setRange([1,2,3]);
void row;
