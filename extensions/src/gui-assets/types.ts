import type {GuiRoot,GuiFocusManager,GuiElementOptions,GuiImageSource} from '@haiyue/engine/gui';
export interface GuiUploadFile {readonly key:string;readonly name:string;readonly size:number;readonly type:string;readonly data:unknown;}
export interface GuiUploadHost {
 pick(signal:AbortSignal):Promise<readonly GuiUploadFile[]>;
 upload(file:GuiUploadFile,signal:AbortSignal,progress:(fraction:number)=>void):Promise<string>;
}
export interface GuiUploadOptions extends GuiElementOptions {
 readonly root?:GuiRoot;readonly focusManager?:GuiFocusManager;readonly host:GuiUploadHost;
 readonly maxFiles?:number;readonly maxFileBytes?:number;readonly accept?:readonly string[];
 readonly onComplete?:(file:GuiUploadFile,result:string)=>void;
}
export interface GuiQrMatrix {readonly size:number;readonly cells:Uint8Array;}
export interface GuiQrImageLease {readonly source:GuiImageSource;readonly dispose:()=>void;}
export interface GuiQRCodeOptions extends GuiElementOptions {
 readonly root?:GuiRoot;readonly value?:string;readonly size?:number;
 readonly encode:(text:string,signal:AbortSignal)=>GuiQrMatrix|Promise<GuiQrMatrix>;
 readonly rasterize:(matrix:GuiQrMatrix,colors:Readonly<{foreground:string;background:string;quietZone:number}>)=>GuiQrImageLease;
 readonly foreground?:string;readonly background?:string;readonly quietZone?:number;
}
