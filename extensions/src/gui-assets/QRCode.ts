import {Composite,number,fail,textElement} from '../gui-common/composite.js';
import {LatestRequest} from '../gui-common/latest.js';
import {GuiImageView} from '../gui-display/image.js';
import type {GuiQrMatrix,GuiQrImageLease,GuiQRCodeOptions} from './types.js';
import {GuiCleanup} from '../gui-layout/panel-cleanup.js';

export class GuiQRCode extends Composite {
 readonly image:GuiImageView;readonly feedback:import('@haiyue/engine/gui').GuiLabel;
 private readonly request=new LatestRequest();private lease:GuiQrImageLease|null=null;private current='';
 private readonly leases=new Set<GuiQrImageLease>();
 constructor(private readonly options:GuiQRCodeOptions){
  const size=number(options.size??160,'QR image size',32,2048);if(options.value!==undefined)checkValue(options.value);super('GuiQRCode',{direction:'column',rowGap:4,width:size},options);
  if(typeof options.encode!=='function'||typeof options.rasterize!=='function')fail('QR encoding and rasterization adapters are required.');number(options.quietZone??4,'QR quiet zone',4,16);if(!Number.isInteger(options.quietZone??4))fail('QR quiet zone must be integral.');
  this.image=new GuiImageView({width:size,height:size,placeholder:'QR code',fit:'contain'});this.part('image',this.image.element);this.feedback=this.part('feedback',textElement('',{height:24}));this.releases.push(()=>this.image.dispose(),()=>this.release());this.finish();if(options.value!==undefined)void this.setValue(options.value);
 }
 get value():string{return this.current;}
 async setValue(value:string):Promise<boolean> {
  this.alive();checkValue(value);this.current=value;const signal=this.request.begin();let acquired:GuiQrImageLease|undefined;
  try {
   this.feedback.setText('Generating…');
   if(!this.request.current(signal))return false;
   const matrix=await this.options.encode(value,signal);
   if(!this.request.current(signal))return false;
   checkMatrix(matrix);
   acquired=this.options.rasterize(matrix,{foreground:this.options.foreground??'#000000',background:this.options.background??'#ffffff',quietZone:this.options.quietZone??4});
   if(acquired&&typeof acquired.dispose==='function')this.leases.add(acquired);
   if(!acquired||!acquired.source||typeof acquired.dispose!=='function')fail('Invalid QR image lease.');
   // Publishing an image synchronously notifies user code. Disposal must own both leases.
   if(!this.request.current(signal))return false;
   this.image.setSource(acquired.source);
   if(this.dead||!this.request.current(signal))return false;
   const previous=this.lease,installed=acquired;
   this.lease=installed;acquired=undefined;
   if(previous&&previous!==installed)this.releaseLease(previous);
   if(this.dead||!this.request.current(signal)||this.lease!==installed)return false;
   this.feedback.setText('Ready');
   return !this.dead&&this.request.current(signal)&&this.lease===installed;
  } catch(error) {
   if(!this.request.current(signal))return false;
   this.feedback.setText(error instanceof Error?error.message:'QR generation failed.');return false;
  } finally {
   if(acquired)try {
    if(!this.dead&&this.image.image.source===acquired.source&&this.lease!==acquired)this.image.setSource(this.lease?.source??null);
   } finally {this.releaseLease(acquired);}
  }
 }
 private releaseLease(lease:GuiQrImageLease):void {if(this.leases.delete(lease))lease.dispose();}
 private release():void {this.lease=null;const cleanup=new GuiCleanup();cleanup.run(()=>this.image.setSource(null));for(const lease of [...this.leases])cleanup.run(()=>this.releaseLease(lease));cleanup.complete('QR lease cleanup failed.');}
 override dispose():void {this.request.cancel();super.dispose();}
}
function checkValue(value:string):void {if(typeof value!=='string'||value.length>8192)fail('QR content exceeds 8192 UTF-16 units.');}
function checkMatrix(matrix:GuiQrMatrix):void {if(!matrix||!Number.isInteger(matrix.size)||matrix.size<21||matrix.size>177||(matrix.size-21)%4!==0||!(matrix.cells instanceof Uint8Array)||matrix.cells.length!==matrix.size*matrix.size||matrix.cells.some(cell=>cell!==0&&cell!==1))fail('Invalid QR module matrix.');}

/** Explicit browser raster adapter. Supply your own canvas factory; the default GUI imports none. */
export function createGuiQrCanvasRasterizer(createCanvas:()=>HTMLCanvasElement):GuiQRCodeOptions['rasterize'] {
 return(matrix,colors)=>{checkMatrix(matrix);const canvas=createCanvas(),moduleSize=4,q=colors.quietZone,extent=(matrix.size+q*2)*moduleSize;canvas.width=extent;canvas.height=extent;const ctx=canvas.getContext('2d');if(!ctx)fail('A 2D canvas rasterization host is required.');ctx.fillStyle=colors.background;ctx.fillRect(0,0,extent,extent);ctx.fillStyle=colors.foreground;for(let y=0;y<matrix.size;y++)for(let x=0;x<matrix.size;x++)if(matrix.cells[y*matrix.size+x])ctx.fillRect((x+q)*moduleSize,(y+q)*moduleSize,moduleSize,moduleSize);let dead=false;return{source:canvas,dispose:()=>{if(dead)return;dead=true;canvas.width=0;canvas.height=0;}};};
}
