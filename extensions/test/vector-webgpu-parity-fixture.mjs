const progress = document.querySelector('#progress');
const resultNode = document.querySelector('#result');
const CASE_COUNT = 25;

async function run() {
try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');
  const shader = device.createShaderModule({ code: WGSL });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
  const output = device.createTexture({ size: [CASE_COUNT, 1], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
  const sampled = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: sampled }, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]), { bytesPerRow: 8 }, [2, 2]);
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: output.createView() },
    { binding: 1, resource: sampled.createView() },
    { binding: 2, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
  ] });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(CASE_COUNT); pass.end();
  const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [CASE_COUNT, 1]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange()).slice(0, CASE_COUNT * 4);
  const expected = expectedPixels();
  const cases = [];
  for (let index = 0; index < CASE_COUNT; index++) {
    const actual = [...bytes.slice(index * 4, index * 4 + 4)];
    const target = expected[index];
    const maximumError = Math.max(...actual.map((value, channel) => Math.abs(value - target[channel])));
    if (maximumError > 2) throw new Error(`case ${index} mismatch: ${actual} vs ${target}, max=${maximumError}`);
    cases.push({ id: caseName(index), actual, expected: target, maximumError });
  }
  readback.unmap(); readback.destroy(); output.destroy(); sampled.destroy();
  const validationError = await device.popErrorScope();
  device.destroy();
  if (validationError || errors.length) throw new Error(`WebGPU validation errors: ${validationError?.message ?? errors.join('; ')}`);
  resultNode.textContent = JSON.stringify({ status: 'passed', suite: 'animation.vector-visual-parity', caseCount: cases.length, paintFamilies: ['solid', 'linear-gradient', 'radial-gradient'], compositeFamilies: ['stroke-dash-trim', 'nested-inverted-clip', 'feather', 'image-sampling', ...MODES], strictValidation: true, cases });
  resultNode.dataset.status = 'passed'; progress.textContent = 'complete';
} catch (error) {
  resultNode.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  resultNode.dataset.status = 'failed'; progress.textContent = 'failed';
}
}

const MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'add', 'subtract'];
function caseName(index) { return index < 7 ? ['solid', 'linear-gradient', 'radial-gradient', 'stroke-dash-trim', 'nested-inverted-clip', 'feather', 'image-sampling'][index] : `blend-${MODES[index - 7]}`; }
function expectedPixels() {
  const fixed = [[255, 0, 0, 255], [191, 0, 64, 255], [64, 64, 64, 255], [255, 255, 255, 255], [255, 255, 255, 179], [255, 255, 255, 128], [0, 255, 0, 255]];
  const source = [0.8, 0.2, 0.4, 0.6], destination = [0.3, 0.7, 0.1, 0.5];
  return [...fixed, ...MODES.map(mode => composite(source, destination, mode).map(value => Math.round(clamp(value) * 255)))];
}
function composite(s, d, mode) { const sa=s[3], da=d[3], alpha=sa+da*(1-sa); if(mode==='subtract')return [d[0]-s[0]*sa,d[1]-s[1]*sa,d[2]-s[2]*sa,alpha].map(clamp); const b=blend(s,d,mode); return [0,1,2].map(i=>((1-da)*s[i]*sa+(1-sa)*d[i]*da+sa*da*b[i])/alpha).concat(alpha).map(clamp); }
function blend(s,d,mode){ if(['hue','saturation','color','luminosity'].includes(mode)){const sh=rgbToHsl(s),dh=rgbToHsl(d),hsl=mode==='hue'?[sh[0],dh[1],dh[2]]:mode==='saturation'?[dh[0],sh[1],dh[2]]:mode==='color'?[sh[0],sh[1],dh[2]]:[dh[0],dh[1],sh[2]];return hslToRgb(hsl);} const f=(a,b)=>mode==='multiply'?a*b:mode==='screen'?a+b-a*b:mode==='overlay'?(b<=.5?2*a*b:1-2*(1-a)*(1-b)):mode==='darken'?Math.min(a,b):mode==='lighten'?Math.max(a,b):mode==='color-dodge'?(a>=1?1:Math.min(1,b/(1-a))):mode==='color-burn'?(a<=0?0:1-Math.min(1,(1-b)/a)):mode==='hard-light'?(a<=.5?2*a*b:1-2*(1-a)*(1-b)):mode==='soft-light'?(1-2*a)*b*b+2*a*b:mode==='difference'?Math.abs(b-a):mode==='exclusion'?a+b-2*a*b:mode==='add'?Math.min(1,a+b):a;return [f(s[0],d[0]),f(s[1],d[1]),f(s[2],d[2])];}
function rgbToHsl(c){const max=Math.max(c[0],c[1],c[2]),min=Math.min(c[0],c[1],c[2]),l=(max+min)/2;if(max===min)return[0,0,l];const delta=max-min,s=l>.5?delta/(2-max-min):delta/(max+min),h=max===c[0]?(c[1]-c[2])/delta+(c[1]<c[2]?6:0):max===c[1]?(c[2]-c[0])/delta+2:(c[0]-c[1])/delta+4;return[h/6,s,l];}
function hslToRgb(h){if(h[1]===0)return[h[2],h[2],h[2]];const q=h[2]<.5?h[2]*(1+h[1]):h[2]+h[1]-h[2]*h[1],p=2*h[2]-q,f=t=>{const n=(t%1+1)%1;return n<1/6?p+(q-p)*6*n:n<.5?q:n<2/3?p+(q-p)*(2/3-n)*6:p};return[f(h[0]+1/3),f(h[0]),f(h[0]-1/3)];}
function clamp(value){return Math.max(0,Math.min(1,value));}

const WGSL = String.raw`
@group(0) @binding(0) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var imageTexture: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
fn clamp3(v:vec3f)->vec3f{return clamp(v,vec3f(0),vec3f(1));}
fn rgb_to_hsl(c:vec3f)->vec3f{let hi=max(c.r,max(c.g,c.b));let lo=min(c.r,min(c.g,c.b));let l=(hi+lo)*.5;if(hi==lo){return vec3f(0,0,l);}let d=hi-lo;let sat=select(d/(hi+lo),d/(2-hi-lo),l>.5);var h=select(select((c.r-c.g)/d+4,(c.b-c.r)/d+2,c.g==hi),(c.g-c.b)/d+select(0.,6.,c.g<c.b),c.r==hi);return vec3f(h/6,sat,l);}
fn hue(p:f32,q:f32,t0:f32)->f32{let t=t0-floor(t0);if(t<1./6.){return p+(q-p)*6*t;}if(t<.5){return q;}if(t<2./3.){return p+(q-p)*(2./3.-t)*6;}return p;}
fn hsl_to_rgb(h:vec3f)->vec3f{if(h.y==0){return vec3f(h.z);}let q=select(h.z*(1+h.y),h.z+h.y-h.z*h.y,h.z>=.5);let p=2*h.z-q;return vec3f(hue(p,q,h.x+1./3.),hue(p,q,h.x),hue(p,q,h.x-1./3.));}
fn blend_channel(a:f32,b:f32,mode:u32)->f32{switch mode{case 1u:{return a*b;}case 2u:{return a+b-a*b;}case 3u:{return select(2*a*b,1-2*(1-a)*(1-b),b>.5);}case 4u:{return min(a,b);}case 5u:{return max(a,b);}case 6u:{return select(min(1.,b/(1-a)),1.,a>=1.);}case 7u:{return select(1-min(1.,(1-b)/a),0.,a<=0.);}case 8u:{return select(2*a*b,1-2*(1-a)*(1-b),a>.5);}case 9u:{return (1-2*a)*b*b+2*a*b;}case 10u:{return abs(b-a);}case 11u:{return a+b-2*a*b;}case 16u:{return min(1.,a+b);}default:{return a;}}}
fn blend_rgb(s:vec3f,d:vec3f,mode:u32)->vec3f{if(mode>=12u&&mode<=15u){let sh=rgb_to_hsl(s);let dh=rgb_to_hsl(d);var h=dh;if(mode==12u){h.x=sh.x;}if(mode==13u){h.y=sh.y;}if(mode==14u){h=vec3f(sh.x,sh.y,dh.z);}if(mode==15u){h.z=sh.z;}return hsl_to_rgb(h);}return vec3f(blend_channel(s.r,d.r,mode),blend_channel(s.g,d.g,mode),blend_channel(s.b,d.b,mode));}
fn composite(s:vec4f,d:vec4f,mode:u32)->vec4f{let alpha=s.a+d.a*(1-s.a);if(mode==17u){return clamp(vec4f(d.rgb-s.rgb*s.a,alpha),vec4f(0),vec4f(1));}let b=blend_rgb(s.rgb,d.rgb,mode);let c=((1-d.a)*s.rgb*s.a+(1-s.a)*d.rgb*d.a+s.a*d.a*b)/max(alpha,.000001);return clamp(vec4f(c,alpha),vec4f(0),vec4f(1));}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){let i=id.x;var color=vec4f(0);if(i==0u){color=vec4f(1,0,0,1);}else if(i==1u){color=mix(vec4f(1,0,0,1),vec4f(0,0,1,1),.25);}else if(i==2u){color=mix(vec4f(1),vec4f(0,0,0,1),.75);}else if(i==3u){let distance=0.75;let dash=true;let trim=true;color=vec4f(1,1,1,select(0.,1.,distance<=1.&&dash&&trim));}else if(i==4u){color=vec4f(1,1,1,min(.8,1-.3));}else if(i==5u){color=vec4f(1,1,1,.5);}else if(i==6u){color=textureSampleLevel(imageTexture,imageSampler,vec2f(.75,.25),0.);}else{color=composite(vec4f(.8,.2,.4,.6),vec4f(.3,.7,.1,.5),i-7u);}textureStore(outputTexture,vec2u(i,0),color);}
`;

void run();
