import{GuiElement,GuiLabel,GuiDirtyFlags}from'@haiyue/engine/gui';
import type{GuiStyle}from'@haiyue/engine/gui';
import{createGuiContainer,ownContentFrame,setContainerStyle}from'../gui-layout/presets.js';
import{invalid,live}from'./common.js';
import type{GuiBadgeOptions,GuiBadgeValue,GuiBadgeStatus}from'./types.js';
const colors:Readonly<Record<GuiBadgeStatus,string>>={default:'#64748b',processing:'#2563eb',success:'#16a34a',warning:'#d97706',error:'#dc2626'};
type State=Required<Omit<GuiBadgeOptions,'content'|'style'>> & {readonly style:GuiStyle};
function snapshot(value:Omit<GuiBadgeOptions,'content'>,base?:State):State{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([k,v])=>v===null||!['value','variant','status','statusText','overflowCount','showZero','placement','offset','style'].includes(k)))invalid('Invalid badge options.');
 const v=value.value??base?.value??0,variant=value.variant??base?.variant??'count',status=value.status??base?.status??'default',statusText=value.statusText??base?.statusText??'',overflowCount=value.overflowCount??base?.overflowCount??99,showZero=value.showZero??base?.showZero??false,placement=value.placement??base?.placement??'top-right',offset=value.offset??base?.offset??[0,0],style=value.style??base?.style??{};
 if(typeof v==='number'?!Number.isSafeInteger(v)||v<0:typeof v!=='string'||!v.trim())invalid('Badge value must be a nonnegative safe integer or nonempty text.');
 if(!['count','dot','status'].includes(variant)||!Object.hasOwn(colors,status)||typeof statusText!=='string'||!Number.isSafeInteger(overflowCount)||overflowCount<0||typeof showZero!=='boolean'||!['top-left','top-right','bottom-left','bottom-right'].includes(placement)||!Array.isArray(offset)||offset.length!==2||offset.some(n=>!Number.isFinite(n))||!style||typeof style!=='object'||Array.isArray(style))invalid('Invalid badge configuration.');
 if(style.iconPosition!==undefined&&!['left','right'].includes(style.iconPosition))invalid('Invalid badge icon position.');
 return Object.freeze({value:v,variant,status,statusText,overflowCount,showZero,placement,offset:Object.freeze([offset[0]!,offset[1]!]as const),style:Object.freeze({...base?.style,...style})});
}
/** A noninteractive decoration; original content and native GUI painters remain borrowed. */
export class GuiBadge{
 readonly element:GuiElement;
 private state:State;
 private readonly decoration:GuiElement;
 private readonly count:GuiLabel;
 private readonly statusText:GuiLabel;
 private readonly content:GuiElement|undefined;
 private readonly release:()=>void;
 private dead=false;
 constructor(options:GuiBadgeOptions={}){
  const{content,...configuration}=options;this.state=snapshot(configuration);
  if(content!==undefined&&(!(content instanceof GuiElement)||content.parent))invalid('Badge content must be a distinct unattached borrowed GUI element.');
  this.content=content;this.release=content?ownContentFrame(content,{}):()=>{};
  this.element=createGuiContainer('row',{style:{width:'auto',height:'auto',alignItems:'center'}});this.element.pointerFilter='ignore';
  if(content)this.element.add(content);
  this.decoration=this.element.add(createGuiContainer('row',{style:{width:'auto',height:20,alignItems:'center',columnGap:6}}));this.decoration.pointerFilter='ignore';
  this.count=this.decoration.add(new GuiLabel({text:'',autoWidth:true,textAlign:'center',pointerFilter:'ignore',themeControlType:'GuiBadge',style:{fontSize:12,padding:4,radius:10,color:'#ffffff'}}));
  this.statusText=this.decoration.add(new GuiLabel({text:'',autoWidth:true,pointerFilter:'ignore',themeControlType:'GuiBadgeStatusText'}));
  this.paint(true);
 }
 setValue(value:GuiBadgeValue):void{this.setOptions({value});}
 setOptions(options:Omit<GuiBadgeOptions,'content'>):void{live(this.dead);const next=snapshot(options,this.state),previous=this.state;this.state=next;this.paint(false,previous);}
 private paint(initial:boolean,previous?:State):void{
  const s=this.state,count=s.variant==='count',status=s.variant==='status',shown=!count||s.value!==0||s.showZero;
  const label=count?typeof s.value==='number'&&s.value>s.overflowCount?s.overflowCount+'+':String(s.value):'';
  this.decoration.setVisible(shown);this.count.setText(label);this.statusText.setText(status?s.statusText:'');this.statusText.setVisible(status&&!!s.statusText);
  this.count.setStyle({backgroundColor:count?colors.error:colors[s.status],radius:count?10:4,padding:count?4:0,...s.style});
  if(initial||previous?.variant!==s.variant){setContainerStyle(this.count,{width:count?'auto':8,height:count?20:8,minWidth:count?20:8,shrink:0});this.count.setAutoWidth(count);this.count.markDirty();}
  if(initial||previous?.placement!==s.placement||previous.offset[0]!==s.offset[0]||previous.offset[1]!==s.offset[1]){
   const[x,y]=s.offset;
   setContainerStyle(this.decoration,this.content?{position:'absolute',width:'auto',height:20,inset:{...(s.placement.endsWith('left')?{left:x}:{right:-x}),...(s.placement.startsWith('top')?{top:y}:{bottom:-y})}}:{width:'auto',height:20,margin:{left:x,top:y}});this.decoration.markDirty(GuiDirtyFlags.Layout);
  }
 }
 dispose():void{if(this.dead)return;this.dead=true;this.element.parent?.remove(this.element);if(this.content?.parent===this.element)this.element.remove(this.content);this.release();for(const child of [...this.element.children])this.element.remove(child);}
}
