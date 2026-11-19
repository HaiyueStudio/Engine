import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const out = fileURLToPath(new URL('../project/assets/', import.meta.url));
await mkdir(out, { recursive: true });
const color = (hex, alpha = 1) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).concat(alpha);
const shape = (id, type, x, y, w, h, fill, alpha) => ({ id, transform: { position: [x, y] },
  components: [{ type: 'shape2d', shape: type, size: [w,h], fill: color(fill, alpha) }] });
const rect = (id, x,y,w,h,c,a) => shape(id, 'rect', x,y,w,h,c,a);
const oval = (id, x,y,w,h,c,a) => shape(id, 'ellipse', x,y,w,h,c,a);
const polygon = (id, values, fill, alpha) => ({ id, components: [
  { type: 'path2d', commands: 'M' + 'L'.repeat(values.length / 2 - 1) + 'Z', values, fill: color(fill, alpha) },
] });
const pulse = (id, values) => ({ id, values });

async function composition(id, width, height, nodes, { duration = 2.4, loop = true, pulses = [], event } = {}) {
  const document = { format: 'haiyue-animation', version: '1.0', duration,
    canvas: { width,height,coordinateSystem:'screen-y-down' }, nodes, tracks: [], resources: [], extensionsUsed: [] };
  const result = { format: 'haiyue-composition', version: 1,
    parts: [{ id: 'core', extension: 'org.haiyue.animation-core@1', required: true, requires: [], dependencies: [], document }], targets: [] };
  const channels = [], tracks = [];
  for (const { id: node, values } of pulses) {
    result.targets.push({ id: node, part: 'core', kind: 'animation-node', address: [node] });
    channels.push({ id: node, target: node, path: 'components.0.paint.fill.color', family: 'paint-path',
      valueKind: 'color', valueSize: 4, policy: 'override', defaultValue: values[0][1] });
    tracks.push({ id: node, channel: node,
      keys: values.map(([time,value], index) => ({ time, value,
        ...(index < values.length - 1 ? { interpolation: { kind: 'linear' } } : {}) })) });
  }
  if (event) {
    channels.push({ id: 'completion', target: pulses[0].id, path: 'event.finish', family: 'event-audio-script',
      valueKind: 'callback', policy: 'ownership', effectKind: 'event' });
    tracks.push({ id: 'completion', channel: 'completion', keys: [{ time: duration * .8, value: { name: event } }] });
  }
  if (tracks.length) result.parts.push({ id: 'motion', extension: 'org.haiyue.animation-state-machine@2',
    required: true, requires: [], dependencies: ['core'],
    document: { format: 'haiyue-animation-state-machine@2', extension: 'org.haiyue.animation-state-machine@2',
      components: [], channels, clips: [{ id: 'clip', duration, tracks }],
      stateMachines: [{ id: 'scene', inputs: [], layers: [{ id: 'base', order: 0,
        states: [{ id: 'visible', motion: { kind: 'clip', clip: 'clip', playback: loop ? 'loop' : 'one-shot' } }],
        transitions: [{ id: 'entry', from: '@entry', to: 'visible', duration: 0, conditionGroups: [] }] }] }] },
  });
  await writeFile(join(out, id + '.hya.json'), JSON.stringify(result) + '\n');
}

await composition('harbor', 1280, 720, [
  rect('night',640,360,1280,720,'111d30'),
  oval('haze',922,167,548,217,'4e666d',.2), oval('moon-halo',945,113,190,190,'91bbb0',.13),
  oval('moon',946,113,77,77,'d7e4c1'),
  polygon('hills-back',[0,318,155,219,281,292,464,190,635,289,812,237,1038,276,1280,216,1280,385,0,385],'2b414b'),
  polygon('hills-front',[0,304,143,283,244,324,383,274,507,336,656,353,866,292,977,339,1161,296,1280,339,1280,402,0,402],'192937'),
  rect('sea',640,482,1280,279,'233e4c'),
  ...[0,1,2,3,4,5,6,7,8,9,10,11].map(i => rect('wave-'+i,82+(i*151)%1070,400+i*14,(i%4)*42+35,2,'519c9e',.22)),
  polygon('far-bank',[0,374,272,361,386,397,0,423],'162a39'),
  polygon('pier',[531,436,674,434,1122,718,219,720],'272e3a'),
  polygon('pier-side',[674,434,1122,718,1197,720,694,430],'192430'),
  ...[0,1,2,3,4,5,6].map(i => rect('plank-'+i,603,457+i*i*5,120+i*69,3,'52616b',.6)),
  rect('tower',304,306,32,160,'384c53'), polygon('tower-roof',[280,234,304,205,329,234],'131e29'),
  rect('tower-light',305,250,22,23,'ffbc7a'), oval('tower-glow',307,250,78,70,'ffba77',.25),
  polygon('boat',[970,431,1049,431,1034,445,987,448],'111c2a'),
  rect('rope-post',110,489,12,100,'112231'), rect('rope-post-far',202,455,10,76,'112231'),
], { pulses: [pulse('tower-glow', [[0,color('ffba77',.16)],[1.2,color('ffd996',.34)],[2.4,color('ffba77',.16)]])] });

await composition('keeper', 300, 340, [
  oval('shadow',147,315,158,32,'101a22',.65),
  polygon('coat',[99,138,177,128,221,289,204,312,87,312,59,287],'3e5160'),
  polygon('lapel',[117,141,171,131,164,208,91,224],'526c72'),
  rect('scarf',140,131,79,23,'da9062'),
  oval('head',139,88,80,95,'b98d72'),
  polygon('hood',[91,105,82,58,112,30,172,33,202,68,177,96,165,59,112,73,108,119],'433c4b'),
  rect('eye',160,92,8,3,'292d38'),
  polygon('sleeve',[172,147,200,139,219,190,253,194,251,216,201,215],'5d7380'),
  oval('light-spill',252,223,91,118,'ffc57a',.24),
  rect('lamp-frame',251,225,45,57,'3d3032'), rect('lamp-glass',251,227,30,41,'ffe6a7'),
  rect('lamp-handle',251,198,18,13,'bd9e73'),
], { pulses: [pulse('light-spill', [[0,color('ffb66b',.18)],[1.08,color('ffcf87',.38)],[2.4,color('ffb66b',.18)]])] });

await composition('traveler', 320, 363, [
  oval('shadow',168,337,173,37,'0a1624',.65),
  polygon('raincoat',[110,157,173,142,224,194,255,330,100,330,86,276],'43586d'),
  polygon('left-coat',[110,157,145,166,164,325,100,330,88,277],'2f455d'),
  oval('face',137,103,80,100,'c0a188'),
  polygon('hood',[80,145,66,88,96,44,157,35,193,70,193,127,170,143,173,83,134,62,104,88,98,145],'27384d'),
  rect('eye',113,101,8,3,'27384d'),
  polygon('bag',[190,157,237,183,240,248,195,247,177,207],'7d705d'),
  polygon('scarf',[109,139,175,131,189,146,179,164,190,198,166,207,146,162,111,164],'a96262'),
], { pulses: [pulse('face', [[0,color('b89881')],[1.2,color('d8ad87')],[2.4,color('b89881')]])] });

const drops = Array.from({ length: 30 }, (_, i) => {
  const x = 14 + (i*197)%1250, y = 22 + (i*139)%630, long = 18 + (i%4)*9;
  return polygon('rain-'+i,[x,y,x+1.5,y,x-11,y+long,x-13,y+long],'a0cad3',.14);
});
await composition('rain', 1280, 720, drops, {
  duration: 1.6,
  pulses: drops.map(({ id },i) => pulse(id, [[0,color('a0cad3',i%2 ? .04 : .22)],
    [.8,color('a0cad3',i%2 ? .22 : .04)],[1.6,color('a0cad3',i%2 ? .04 : .22)]])),
});
await composition('signal', 1280, 720, [
  polygon('beam',[305,247,1180,151,1231,308,308,260],'ffe0a6',0),
  oval('flare',305,252,118,104,'ffe0a6',.04),
  oval('coast-reflection',895,438,530,23,'ffc27d',0),
], { duration:.8, loop:false, event:'beacon-finished', pulses: [
  pulse('beam', [[0,color('ffe0a6',0)],[.24,color('ffe0a6',.38)],[.8,color('ffe0a6',.10)]]),
  pulse('flare', [[0,color('ffe0a6',.04)],[.28,color('ffe0a6',.65)],[.8,color('ffe0a6',.22)]]),
  pulse('coast-reflection', [[0,color('ffc27d',0)],[.24,color('ffc27d',.30)],[.8,color('ffc27d',.12)]]),
] });
