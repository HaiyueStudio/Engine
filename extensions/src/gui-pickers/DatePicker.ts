import type {GuiButton,GuiLabel} from '@haiyue/engine/gui';
import {Composite,button,surface,textElement,fail,number} from '../gui-common/composite.js';
import {GuiPopover} from '../gui-overlays/popover.js';
import {dateValue,monthValue,shiftMonth,calendarDays} from './calendar.js';
import type {GuiDatePickerOptions} from './types.js';

/** A timezone-free calendar over the existing popup, focus manager and button actions. */
export class GuiDatePicker extends Composite {
 readonly trigger:GuiButton;readonly popup:GuiPopover;readonly days:readonly GuiButton[];readonly heading:GuiLabel;
 private current:string|null;private shown:string;private readonly first:number;private readonly min:string;private readonly max:string;
 private dates:readonly (string|null)[]=[];private readonly previous:GuiButton;private readonly next:GuiButton;
 constructor(private readonly options:GuiDatePickerOptions){
  super('GuiDatePicker',{direction:'column',width:240},options,undefined,options.focusManager);
  this.min=dateValue(options.min??'0001-01-01');this.max=dateValue(options.max??'9999-12-31');if(this.min>this.max)fail('Invalid date interval.');
  this.first=number(options.firstDayOfWeek??1,'first weekday',0,6);if(!Number.isInteger(this.first))fail('Weekday must be an integer.');
  this.current=this.checked(options.value??null);this.shown=monthValue(options.month??this.current?.slice(0,7)??new Date().toISOString().slice(0,7));
  this.shown=this.clampMonth(this.shown);
  this.trigger=this.part('trigger',button('',this.action(()=>this.open()),{width:{percent:100}}));
  const content=this.part('calendar',surface('GuiCalendar',{direction:'column',rowGap:4,width:{percent:100},height:{percent:100}}));this.element.remove(content);
  const nav=this.part('navigation',surface('GuiCalendarNavigation',{direction:'row',height:32,columnGap:4}),content);
  this.previous=this.part('previous',button('‹',this.action(()=>this.setMonth(shiftMonth(this.shown,-1))),{width:32},{style:{padding:0}}),nav);
  this.heading=this.part('heading',textElement('',{grow:1,basis:0,height:32}),nav);this.heading.textAlign='center';
  this.next=this.part('next',button('›',this.action(()=>this.setMonth(shiftMonth(this.shown,1))),{width:32},{style:{padding:0}}),nav);
  const weekdays=this.part('weekdays',surface('GuiCalendarWeekdays',{direction:'row',height:24}),content),format=new Intl.DateTimeFormat(options.locale,{weekday:'short',timeZone:'UTC'});
  for(let i=0;i<7;i++){const label=this.part('weekday',textElement(format.format(new Date(Date.UTC(2024,0,7+(i+this.first)%7))),{grow:1,basis:0,height:24}),weekdays);label.textAlign='center';}
  const grid=this.part('grid',surface('GuiCalendarGrid',{display:'grid',columns:Array.from({length:7},()=>({fr:1})),rows:Array(6).fill(30),rowGap:2,columnGap:2,height:190}),content);
  this.days=Object.freeze(Array.from({length:42},(_,index)=>this.part('day',button('',this.action(()=>{const value=this.dates[index];if(value&&this.allowed(value)){this.popup.close('select');if(!this.dead)this.setValue(value,true);}}),{height:30},{onAction:event=>{if(event.action==='left'||event.action==='right'||event.action==='up'||event.action==='down'){const delta=event.action==='left'?-1:event.action==='right'?1:event.action==='up'?-7:7;this.focusDay(index,delta);event.consume();}}}),grid)));
  this.part('clear',button('Clear',this.action(()=>{this.popup.close('select');this.setValue(null,true);}),{height:28}),content);
  try{this.popup=new GuiPopover({root:options.root,focusManager:options.focusManager,anchor:this.trigger,content,width:320,height:342,trigger:'manual'});this.releases.push(()=>this.popup.dispose());this.sync();this.finish();}catch(error){this.dispose();throw error;}
 }
 get value():string|null{return this.current;}
 get month():string{return this.shown;}
 private allowed(value:string):boolean {return value>=this.min&&value<=this.max&&!this.options.isDateDisabled?.(value);}
 private checked(value:string|null):string|null {if(value!==null&&(!this.allowed(dateValue(value))))fail('Date is outside the selectable interval.');return value;}
 private clampMonth(value:string):string {return value<this.min.slice(0,7)?this.min.slice(0,7):value>this.max.slice(0,7)?this.max.slice(0,7):value;}
 setValue(value:string|null,emit=false):void {this.alive();const next=this.checked(value),changed=next!==this.current;this.current=next;if(next)this.shown=next.slice(0,7);this.sync();if(changed&&emit)this.options.onChange?.(next);}
 setMonth(value:string):void {this.alive();this.shown=this.clampMonth(monthValue(value));this.sync();}
 open():boolean {this.alive();const opened=this.popup.open();if(opened){const i=this.dates.findIndex(date=>date===this.current),target=i>=0&&!this.days[i]!.disabled?this.days[i]:this.days.find(day=>!day.disabled);if(target)this.options.focusManager.focus(target);}return opened;}
 private focusDay(index:number,delta:number):void {
  const old=this.dates[index];if(!old)return;const next=new Date(old+'T00:00:00Z');
  for(let count=0;count<366;count++){next.setUTCDate(next.getUTCDate()+delta);if(next.getUTCFullYear()<1||next.getUTCFullYear()>9999)return;const date=next.toISOString().slice(0,10);if(date<this.min||date>this.max)return;if(this.allowed(date)){if(date.slice(0,7)!==this.shown)this.setMonth(date.slice(0,7));const target=this.dates.indexOf(date);if(target>=0)this.options.focusManager.focus(this.days[target]!);return;}}
 }
 private sync():void {
  const dates=calendarDays(this.shown,this.first),states=dates.map(date=>({date,disabled:!date||!this.allowed(date)}));this.dates=dates;
  this.trigger.setText(this.current??this.options.placeholder??'Choose date…');this.heading.setText(new Intl.DateTimeFormat(this.options.locale,{year:'numeric',month:'long',timeZone:'UTC'}).format(new Date(this.shown+'-01T00:00:00Z')));
  this.previous.setDisabled(this.shown<=this.min.slice(0,7));this.next.setDisabled(this.shown>=this.max.slice(0,7));
  states.forEach(({date,disabled},i)=>{const day=this.days[i]!;day.setText(date?String(Number(date.slice(8))):'');day.setDisabled(disabled);day.setVisualState({selected:date!==null&&date===this.current});day.setDefaultSkin((theme,state)=>({padding:0,radius:6,backgroundColor:state.selected?theme.colors.primary:state.hover?theme.colors.hover:'transparent',color:state.selected?theme.colors.onPrimary??'#fff':date?.slice(0,7)===this.shown?theme.colors.text:theme.colors.textMuted}));});
 }
}
