import type {ScissorRect} from '../../core/ViewportRect';
import {getRegionCacheBudget,REGION_CACHE_LIMITS} from './RegionCacheBudget';
import type {RegionColorTargets,RegionColorTargetSpec} from './RegionColorTarget';

export interface RegionStorageCandidate {
  readonly token:object;readonly interleaved:boolean;readonly continuous:boolean;
  readonly rect:Readonly<ScissorRect>;readonly source:RegionColorTargetSpec;readonly replace?:boolean;
  readonly crop?:{readonly token:object;readonly spec:RegionColorTargetSpec;readonly replace?:boolean};
}
export interface RegionStoragePlan {
  readonly sampleCount:1|4;readonly cached:ReadonlySet<object>;readonly reasons:ReadonlyMap<object,string>;
}

/** Soft strategy admission, not an acceptance budget or a cap on ordinary frame work.
 * A precision-preserving prefix should not allocate a huge two-dimensional raster. */
export function regionPrecisionWindowPixels(samples:1|4):number {return Math.floor(32*1024*1024/(8*(samples===4?5:1)));}

/** Admission is transactional, including pending retirement. Partial caching is
 * restricted to disjoint physical regions so resolved layers cannot change
 * correlated MSAA coverage or transparent ordering over a direct producer. */
export function planRegionStorage(device:GPUDevice,targets:RegionColorTargets,candidates:readonly RegionStorageCandidate[],samples:1|4,cache:boolean):RegionStoragePlan {
  const direct=(reason:string):RegionStoragePlan=>({sampleCount:samples,cached:new Set(),reasons:new Map(candidates.map(c=>[c.token,reason]))});
  if(!cache)return direct('direct-reference');
  if(candidates.some(c=>c.interleaved))return direct('interleaved-order');
  const budget=getRegionCacheBudget(device).snapshot();
  const rows=candidates.map(c=>({candidate:c,existing:!!targets.peek(c.token),
    fits:[c.source.width,c.source.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=device.limits.maxTextureDimension2D),
    heldBytes:(targets.peek(c.token)?.colorBytes??0)+(c.crop?targets.peek(c.crop.token)?.colorBytes??0:0),
    desiredBytes:colorBytes(c.source)+(c.crop?colorBytes(c.crop.spec):0),
    bytes:targets.additionalColorBytes(c.token,c.source,c.replace)+(c.crop?targets.additionalColorBytes(c.crop.token,c.crop.spec,c.crop.replace):0)}));
  const requiredRegions=budget.retainedRegions+rows.filter(r=>!r.existing).length;
  const requiredBytes=budget.retainedBytes+rows.reduce((sum,r)=>sum+r.bytes,0);
  if(rows.every(r=>r.fits)&&requiredRegions<=REGION_CACHE_LIMITS.maxRegions&&requiredBytes<=REGION_CACHE_LIMITS.maxRetainedColorBytes)return{sampleCount:1,cached:new Set(candidates.map(c=>c.token)),reasons:new Map()};
  const reason=rows.some(r=>!r.fits)?'device-size':requiredRegions>REGION_CACHE_LIMITS.maxRegions?'region-count':'color-bytes';
  if(candidates.some((a,i)=>candidates.slice(i+1).some(b=>overlaps(a.rect,b.rect))))return direct(reason);
  // Keep demand/once GUI useful even when a large continuous view cannot retain pixels.
  rows.sort((a,b)=>Number(a.candidate.continuous)-Number(b.candidate.continuous)||Number(b.existing)-Number(a.existing));
  // Select eventual ownership independently of currently retained lower-priority
  // colors. Do not subtract those colors from actual admission: retirement may
  // still be pinned by an unsubmitted recording or a pending queue fence.
  const desiredByteLimit=REGION_CACHE_LIMITS.maxRetainedColorBytes-Math.max(0,budget.retainedBytes-rows.reduce((sum,r)=>sum+r.heldBytes,0));
  const desiredRegionLimit=REGION_CACHE_LIMITS.maxRegions-Math.max(0,budget.retainedRegions-rows.filter(r=>r.existing).length);
  let desiredBytes=0,desiredRegions=0,bytes=budget.retainedBytes,regions=budget.retainedRegions;
  const cached=new Set<object>(),reasons=new Map<object,string>();
  for(const row of rows){
    const excluded=!row.fits?'device-size':desiredRegions>=desiredRegionLimit?'region-count':row.desiredBytes>desiredByteLimit-desiredBytes?'color-bytes':null;
    if(excluded){reasons.set(row.candidate.token,excluded);continue;}
    desiredRegions++;desiredBytes+=row.desiredBytes;
    const failure=!row.fits?'device-size':regions+Number(!row.existing)>REGION_CACHE_LIMITS.maxRegions?'region-count':row.bytes>REGION_CACHE_LIMITS.maxRetainedColorBytes-bytes?'color-bytes':null;
    if(failure){reasons.set(row.candidate.token,failure);continue;}
    cached.add(row.candidate.token);bytes+=row.bytes;regions+=Number(!row.existing);
  }
  return{sampleCount:cached.size===candidates.length?1:samples,cached,reasons};
}
function overlaps(a:Readonly<ScissorRect>,b:Readonly<ScissorRect>):boolean {return a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;}
function colorBytes(spec:RegionColorTargetSpec):number {return spec.width*spec.height*(spec.format==='rgba16float'?8:4)*(spec.sampleCount===4?5:1);}
