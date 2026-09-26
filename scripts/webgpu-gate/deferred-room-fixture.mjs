export const DEFERRED_ROOM_ID = 'deferred-room-021-v1';
export const DEFERRED_ROOM_PALETTE = Object.freeze([
  [.8,.2,.1],[.1,.5,.8],[.2,.8,.3],[.8,.6,.1],[.5,.2,.8],[.1,.7,.7],[.6,.6,.6],[.9,.9,.9],
].map(Object.freeze));
/** Frozen ADR 0109 content. Values are linear; callers must preserve that color space. */
export function createDeferredRoomFixture({ count=256, frame=0, moving=true, overlap=false, views=1 }={}) {
  if(!Number.isSafeInteger(count)||count<0||count>1024)throw new RangeError('Room point count must be 0..1024.');
  if(!Number.isSafeInteger(frame)||frame<0||![1,4].includes(views))throw new RangeError('Invalid room frame or view count.');
  let state=21128;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2**32;};
  const lights=Array.from({length:count},(_,index)=>{
    const x=-10+20*random(), y=1+6*random(), z=-10+20*random(), color=DEFERRED_ROOM_PALETTE[Math.floor(8*random())], phase=2*Math.PI*random();
    const t=frame/60;
    return {index,position:[x+(moving?Math.sin(t+phase):0),y,z+(moving?Math.cos(t+phase):0)],color,intensity:2,range:overlap?40:2,phase};
  });
  const materials=DEFERRED_ROOM_PALETTE.map((color,index)=>({color,metallic:index%2,roughness:.1+.1*index}));
  const boxes=Array.from({length:256},(_,index)=>({position:[-11.25+1.5*(index%16),.5,-11.25+1.5*Math.floor(index/16)],material:index%8}));
  const cameras=Array.from({length:views},(_,index)=>{const a=2*Math.PI*(frame%240)/240+index*Math.PI/2;return {position:[18*Math.cos(a),6,18*Math.sin(a)],target:[0,2,0],fov:Math.PI/3,near:.1,far:100,width:1280,height:720};});
  return {id:DEFERRED_ROOM_ID,bounds:{min:[-12,0,-12],max:[12,8,12]},materials,boxes,lights,cameras,ambient:.1,directional:{intensity:.5,direction:[-1/Math.sqrt(3),-1/Math.sqrt(3),-1/Math.sqrt(3)]}};
}
