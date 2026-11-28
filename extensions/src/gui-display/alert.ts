import {GuiLabel} from '@haiyue/engine/gui';
import {Composite,surface,textElement,button,choice,statusColor,show} from '../gui-common/composite.js';
import type {Skin} from '../gui-common/composite.js';
import type {GuiAlertOptions} from './types.js';
function alertSkin(status:NonNullable<GuiAlertOptions['status']>):Skin {
  return theme=>({radius:8,borderWidth:1,borderColor:statusColor(theme,status),backgroundColor:theme.colors.surface,
    parts:{icon:{fontSize:20,color:statusColor(theme,status)},title:{fontWeight:600,color:theme.colors.text},description:{color:theme.colors.textMuted,fontSize:12},close:{padding:0,paddingY:0}}});
}
const glyph=(status:NonNullable<GuiAlertOptions['status']>)=>status==='success'?'✓':status==='error'?'×':status==='warning'?'!':'i';
export class GuiAlert extends Composite {
  readonly titleLabel:GuiLabel;readonly descriptionLabel:GuiLabel;
  private readonly icon:GuiLabel;
  constructor(options:GuiAlertOptions){
    const status=choice(options.status??'info',['info','success','warning','error'],'alert status');
    super('GuiAlert',{direction:'row',alignItems:'start',columnGap:12,padding:{left:14,right:14,top:12,bottom:12},width:360,shrink:0},options,alertSkin(status),options.focusManager);
    this.icon=this.part('icon',textElement(glyph(status),{width:22,height:26}));
    const body=this.part('body',surface('GuiAlertBody',{direction:'column',rowGap:4,grow:1,shrink:1,minWidth:0}));this.titleLabel=this.part('title',textElement(options.title),body);this.descriptionLabel=this.part('description',textElement(options.description??''),body);show(this.descriptionLabel,!!options.description);
    const actions=this.part('action',surface('GuiAlertAction',{direction:'row',columnGap:6}));
    const close=this.part('close',button('×',this.action(()=>{if(options.onClose?.()===false||this.dead)return;this.blurWithin(this.element);show(this.element,false);}),{width:24,height:24},{themeControlType:'GuiAlertClose'}));show(close,options.closable??false);
    try{this.mount([{name:'actionContent',node:options.action,parent:actions}]);}catch(error){this.dispose();throw error;}
    this.finish();
  }
  setContent(options:Pick<GuiAlertOptions,'title'|'description'|'status'>):void {
    this.alive();if(typeof options.title!=='string'||options.description!==undefined&&typeof options.description!=='string')throw new TypeError('Invalid alert text.');const status=choice(options.status??'info',['info','success','warning','error'],'alert status');
    this.titleLabel.setText(options.title);this.descriptionLabel.setText(options.description??'');show(this.descriptionLabel,!!options.description);this.icon.setText(glyph(status));this.element.setDefaultSkin(alertSkin(status));
  }
}
