// Independent CPU geometry: distance to the closed frustum's triangulated surface.
// Production uses homogeneous plane rejection; this oracle also resolves edge/corner distances.
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const addScaled=(a,b,t)=>a.map((v,i)=>v+b[i]*t);
function pointTriangleDistance2(p,a,b,c){
  const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);
  if(d1<=0&&d2<=0)return dot(ap,ap);
  const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);
  if(d3>=0&&d4<=d3)return dot(bp,bp);
  const vc=d1*d4-d3*d2;
  if(vc<=0&&d1>=0&&d3<=0){const q=sub(p,addScaled(a,ab,d1/(d1-d3)));return dot(q,q);}
  const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);
  if(d6>=0&&d5<=d6)return dot(cp,cp);
  const vb=d5*d2-d1*d6;
  if(vb<=0&&d2>=0&&d6<=0){const q=sub(p,addScaled(a,ac,d2/(d2-d6)));return dot(q,q);}
  const va=d3*d6-d5*d4;
  if(va<=0&&d4-d3>=0&&d5-d6>=0){const q=sub(p,addScaled(b,sub(c,b),(d4-d3)/((d4-d3)+(d5-d6))));return dot(q,q);}
  const n=cross(ab,ac),distance=dot(ap,n);return distance*distance/dot(n,n);
}
export function tileFrustum(inverse,width,height,x,y){
  const left=2*x*16/width-1,right=2*Math.min((x+1)*16,width)/width-1;
  const top=1-2*y*16/height,bottom=1-2*Math.min((y+1)*16,height)/height;
  const vertices=[];
  for(const z of [0,1])for(const [u,v] of [[left,bottom],[right,bottom],[right,top],[left,top]]){
    const q=[u,v,z,1],h=Array.from({length:4},(_,row)=>q.reduce((n,value,col)=>n+inverse[col*4+row]*value,0));
    if(!h.every(Number.isFinite)||Math.abs(h[3])<1e-15)throw Error('Finite frustum required by diagnostic oracle');
    vertices.push(h.slice(0,3).map(value=>value/h[3]));
  }
  const faces=[[0,1,2,3],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  return {vertices,faces,center:[0,1,2].map(i=>vertices.reduce((n,v)=>n+v[i],0)/8)};
}
export function sphereIntersectsFrustum(sphere,frustum){
  const p=sphere.slice(0,3),radius=Math.max(sphere[3],.0001),{vertices,faces,center}=frustum;
  let inside=true,minDistance=Infinity;
  for(const face of faces){
    const [a,b,c,d]=face.map(i=>vertices[i]),normal=cross(sub(b,a),sub(c,a));
    const side=dot(sub(p,a),normal),orientation=dot(sub(center,a),normal);
    if(side*orientation<0)inside=false;
    minDistance=Math.min(minDistance,pointTriangleDistance2(p,a,b,c),pointTriangleDistance2(p,a,c,d));
  }
  return inside||minDistance<=(radius+1e-6)*(radius+1e-6);
}
export function validateTileMembership(words,plan,source,inverse,width,height){
  const heatmap=[],failures=[];let references=0,requiredReferences=0,falsePositives=0,overflowTiles=0;
  const points=source.records.filter(record=>record.identity[0]===2);
  for(let y=0;y<plan.rows;y++)for(let x=0;x<plan.columns;x++){
    const tile=y*plan.columns+x,base=tile*132,missing=tile>=plan.storedTiles;
    const overflow=missing||words[base+2]!==0;
    if(overflow)overflowTiles++;
    const count=missing?points.length:words[base+1];
    const stored=missing?[]:Array.from(words.slice(base+4,base+4+Math.min(count,plan.tileCapacity)));
    if(!missing&&(words[base]!==base+4||words[base+3]!==0))throw Error('Invalid tile header');
    if(new Set(stored).size!==stored.length||stored.some((index,i)=>index>=points.length||(i>0&&index<=stored[i-1])))throw Error('Invalid tile local index or order');
    const frustum=tileFrustum(inverse,width,height,x,y),required=[];
    for(let i=0;i<points.length;i++)if(sphereIntersectsFrustum(points[i].positionRange,frustum))required.push(i);
    requiredReferences+=required.length;
    if(!overflow){for(const i of required)if(!stored.includes(i))failures.push({tile,local:i});falsePositives+=stored.filter(i=>!required.includes(i)).length;}
    references+=overflow?points.length:count;
    heatmap.push({tile,count,overflow,required:required.length});
  }
  if(failures.length)throw Error(`Tile false negatives: ${JSON.stringify(failures.slice(0,12))}`);
  return {heatmap,references,requiredReferences,falsePositives,overflowTiles,falseNegatives:0};
}
