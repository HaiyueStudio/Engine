import {Composite,button,surface,textElement,number,fail} from '../gui-common/composite.js';
import type {GuiVirtualMouseOptions} from './types.js';
export class GuiVirtualMouse extends Composite {
 readonly pad:import('@haiyue/engine/gui').GuiElement;private x=0;private y=0;private down=false;private readonly step:number;readonly feedback:import('@haiyue/engine/gui').GuiLabel;
 constructor(private readonly options:GuiVirtualMouseOptions){
  super('GuiVirtualMouse',{direction:'column',rowGap:4,width:180},options,undefined,options.focusManager);if(typeof options.host?.bounds!=='function'||typeof options.host.dispatch!=='function')fail('Virtual mouse requires an explicit routed pointer host.');this.step=number(options.step??12,'virtual pointer step',1,4096);const bounds=this.bounds();this.x=bounds.x+bounds.width/2;this.y=bounds.y+bounds.height/2;
  this.pad=this.part('pad',surface('GuiVirtualMousePad',{direction:'column',rowGap:4},{focus:{mode:'all'},pointerFilter:'stop',onAction:event=>{const direction=event.action;if(['left','right','up','down'].includes(direction)){this.moveBy(direction==='left'?-this.step:direction==='right'?this.step:0,direction==='up'?-this.step:direction==='down'?this.step:0);event.consume();}else if(direction==='confirm'){this.click();event.consume();}else if(direction==='cancel'){this.cancel();event.consume();}}}));
  const row=this.part('row',surface('GuiVirtualMouseRow',{direction:'row',columnGap:4}),this.pad);this.part('left',button('←',this.action(()=>this.moveBy(-this.step,0)),{grow:1,basis:0}),row);this.part('up',button('↑',this.action(()=>this.moveBy(0,-this.step)),{grow:1,basis:0}),row);this.part('down',button('↓',this.action(()=>this.moveBy(0,this.step)),{grow:1,basis:0}),row);this.part('right',button('→',this.action(()=>this.moveBy(this.step,0)),{grow:1,basis:0}),row);
  this.part('click',button('Click',this.action(()=>this.click())),this.pad);this.feedback=this.part('position',textElement('',{height:24}));this.sync();this.releases.push(()=>this.cancel());if(options.root)this.releases.push(options.root.onInvalidation(()=>{if(!this.element.isEffectivelyVisible())this.cancel();}));this.finish();
 }
 get position():Readonly<{x:number;y:number}>{return Object.freeze({x:this.x,y:this.y});}
 private bounds(){const b=this.options.host.bounds();number(b.x,'pointer origin x',-1e7,1e7);number(b.y,'pointer origin y',-1e7,1e7);number(b.width,'pointer width',1,1e7);number(b.height,'pointer height',1,1e7);return b;}
 moveBy(x:number,y:number):void {this.alive();number(x,'pointer delta x',-1e7,1e7);number(y,'pointer delta y',-1e7,1e7);const b=this.bounds();this.x=Math.max(b.x,Math.min(b.x+b.width-1,this.x+x));this.y=Math.max(b.y,Math.min(b.y+b.height-1,this.y+y));this.dispatch('move');this.sync();}
 press():void {this.alive();if(this.down)return;this.down=true;try{this.dispatch('down');}catch(error){this.cancel();throw error;}}
 release():void {this.alive();if(!this.down)return;this.down=false;this.dispatch('up');}
 click():void {this.press();if(!this.dead)this.release();}
 cancel():void {if(!this.down)return;this.down=false;this.dispatch('cancel');}
 private dispatch(type:'move'|'down'|'up'|'cancel'):void {this.options.host.dispatch(Object.freeze({type,x:this.x,y:this.y,button:0,buttons:this.down?1:0}));}
 private sync():void {this.feedback.setText(Math.round(this.x)+' / '+Math.round(this.y));}
}
