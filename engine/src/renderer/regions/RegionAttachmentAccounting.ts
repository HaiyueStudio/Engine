/** Device-wide regional attachment estimates; these are not driver residency measurements. */
export interface RegionAttachmentLease {
  readonly bytes:number;
  retire():void;
  release():void;
}
export class RegionAttachmentAccounting {
  private cacheColor=0;
  private workingColor=0;
  private retiringWorkingColor=0;
  private depth=0;
  snapshot():Readonly<{workingColorBytes:number;workingRetiringColorBytes:number;regionDepthBytes:number;totalRegionAttachmentBytes:number}> {
    return Object.freeze({workingColorBytes:this.workingColor,workingRetiringColorBytes:this.retiringWorkingColor,regionDepthBytes:this.depth,totalRegionAttachmentBytes:this.cacheColor+this.workingColor+this.depth});
  }
  reserve(kind:'cache'|'working',colorBytes:number,depthBytes:number):RegionAttachmentLease {
    if(![colorBytes,depthBytes].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('Invalid regional attachment accounting.');
    if(kind==='working')this.workingColor+=colorBytes;else this.cacheColor+=colorBytes;
    this.depth+=depthBytes;let retired=false,released=false;
    return Object.freeze({bytes:colorBytes,
      retire:()=>{if(released||retired)return;retired=true;if(kind==='working')this.retiringWorkingColor+=colorBytes;},
      release:()=>{if(released)return;released=true;if(kind==='working'){this.workingColor-=colorBytes;if(retired)this.retiringWorkingColor-=colorBytes;}else this.cacheColor-=colorBytes;this.depth-=depthBytes;}
    });
  }
}
const devices=new WeakMap<GPUDevice,RegionAttachmentAccounting>();
export function getRegionAttachmentAccounting(device:GPUDevice):RegionAttachmentAccounting {
  let accounting=devices.get(device);if(!accounting){accounting=new RegionAttachmentAccounting();devices.set(device,accounting);}return accounting;
}
