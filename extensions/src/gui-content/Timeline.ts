import {Composite,surface,textElement,statusColor} from '../gui-common/composite.js';
import {createGuiVirtualList} from '../gui-collections.js';
import type {GuiVirtualList} from '../gui-collections.js';
import type {GuiTimelineOptions,GuiTimelineItem} from './types.js';
export class GuiTimeline extends Composite {
  readonly list:GuiVirtualList<GuiTimelineItem>;
  constructor(options:GuiTimelineOptions){
    super('GuiTimeline',{direction:'column',width:320},options,undefined,options.focusManager);const height=options.rowHeight??64;
    this.list=createGuiVirtualList({items:options.items,keyOf:item=>item.key,rowHeight:height,height:options.height??256,...(options.focusManager?{focus:options.focusManager}:{}),createRow:options.createRow??(()=>{const element=surface('GuiTimelineRow',{direction:'row',columnGap:12,height,width:{percent:100}},{height}),dot=textElement('●',{width:24,height}),body=surface('GuiTimelineBody',{direction:'column',grow:1,minWidth:0,rowGap:3}),title=textElement('',{height:26}),description=textElement('',{height:24});body.add(title);body.add(description);element.add(dot);element.add(body);title.setDefaultSkin(theme=>({color:theme.colors.text,fontWeight:600}));description.setDefaultSkin(theme=>({color:theme.colors.textMuted,fontSize:12}));return{element,bind:item=>{dot.setDefaultSkin(theme=>({color:statusColor(theme,item.status??'info')}));title.setText(item.title);description.setText(item.description??'');dot.setText(item.status==='success'?'✓':item.status==='error'?'!':'●');return()=>{dot.setDefaultSkin(null);};},dispose:()=>element.removeAllListeners()};})});this.element.add(this.list.element);this.releases.push(()=>this.list.dispose());this.finish();
  }
  setItems(items:readonly GuiTimelineItem[]):void {this.alive();this.list.setItems(items);}
}
