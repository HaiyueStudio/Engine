import type {ScissorRect} from '../../core/ViewportRect';

/** Full outward-rounded raster extent. Clipping this extent must never rescale the producer's projection. */
export function physicalRegionRaster(logical:Readonly<ScissorRect>,dpr:number,dprY=dpr):Readonly<ScissorRect> {
  validate(logical,dpr,dprY);
  const x=Math.floor(logical.x*dpr),y=Math.floor(logical.y*dprY);
  return Object.freeze({x,y,width:logical.width===0?0:Math.ceil((logical.x+logical.width)*dpr)-x,height:logical.height===0?0:Math.ceil((logical.y+logical.height)*dprY)-y});
}

/** Output scissor only. Hit coordinates continue to use the original unsnapped logical bounds. */
export function physicalRegionBounds(logical: Readonly<ScissorRect>, dpr: number, targetWidth: number, targetHeight: number,dprY=dpr): Readonly<ScissorRect> {
  validate(logical,dpr,dprY);
  if (![targetWidth,targetHeight].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid physical render region bounds.');
  const x = Math.max(0, Math.min(targetWidth, Math.floor(logical.x * dpr)));
  const y = Math.max(0, Math.min(targetHeight, Math.floor(logical.y * dprY)));
  const right = Math.max(x, Math.min(targetWidth, Math.ceil((logical.x + logical.width) * dpr)));
  const bottom = Math.max(y, Math.min(targetHeight, Math.ceil((logical.y + logical.height) * dprY)));
  return Object.freeze({x, y, width: logical.width === 0 ? 0 : right - x, height: logical.height === 0 ? 0 : bottom - y});
}
function validate(logical:Readonly<ScissorRect>,dx:number,dy:number):void {
  if(![logical.x,logical.y,logical.width,logical.height,logical.x+logical.width,logical.y+logical.height].every(Number.isFinite)||logical.width<0||logical.height<0||![dx,dy].every(n=>Number.isFinite(n)&&n>0))throw Error('Invalid physical render region bounds.');
}
