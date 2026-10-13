import { Entity, World } from '@haiyue/engine';
import { Animation2DComponent, Animation2DSystem } from '@haiyue/extensions/animation';
import { Animation2DStateMachineComponent } from '@haiyue/extensions/hya-state-machine';
import { AnimationTextRasterizer } from '../../extensions/dist-test/animation/AnimationTextRasterizer.js';

const resultNode = document.querySelector('#result');
const worlds = [];
const references = [];
const check = (condition, message) => { if (!condition) throw new Error(message); };
const until = async predicate => {
  const deadline = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Font preparation timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const parserRequests = () => performance.getEntriesByType('resource').filter(entry => /opentype\.module-/u.test(entry.name)).length;
const baseText = { type: 'text2d', text: 'AA\nA', size: [160, 100], color: [1, 0.25, 0, 1],
  fontFamily: 'Lazy Test Font', fontSize: 28, lineHeight: 32, resolutionScale: 2, textAlign: 'left', verticalAlign: 'top' };
const facesBefore = document.fonts.size;
let released = 0;
let loaded = 0;
const make = (components, assetManager) => {
  const world = new World(); worlds.push(world);
  const owner = new Entity('font fixture');
  const player = new Animation2DComponent({
    format: 'haiyue-animation', version: '1.0', duration: 1,
    canvas: { width: 200, height: 120, coordinateSystem: 'screen-y-down' }, tracks: [],
    nodes: [{ id: 'label', components }],
    resources: [{ id: 'font', type: 'binary', uri: './font.otf' }],
  }, { autoplay: false });
  owner.addComponent(player); world.addEntity(owner);
  world.addSystem(new Animation2DSystem(assetManager ? { assetManager } : {}));
  world.update(0, 0);
  const rasters = owner.children[0].children.flatMap(node => node.children.flatMap(content => content.children))
    .map(entity => entity.getComponent(Symbol.for('AnimationVisual2D'))?.textMaterial).filter(Boolean);
  return { player, rasters };
};
const pixels = raster => {
  const canvas = document.createElement('canvas');
  canvas.width = raster.texture.width; canvas.height = raster.texture.height;
  const context = canvas.getContext('2d');
  context.drawImage(raster.texture, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
};
try {
  check(typeof Animation2DStateMachineComponent === 'function', 'both public animation entrypoints must load');
  make([{ type: 'shape2d', shape: 'rect', size: [20, 20], fill: [1, 0, 0, 1] }]);
  make([baseText]);
  await new Promise(resolve => setTimeout(resolve, 50));
  check(parserRequests() === 0, 'no-text/system-font animations fetched OpenType');
  const fontBytes = await (await fetch('./font.otf')).arrayBuffer();
  const fontSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', fontBytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  const variants = [
    { ...baseText, fontResource: 'font' },
    { ...baseText, fontResource: 'font', styleRuns: [{ start: 0, end: 2, color: [0, 0.5, 1, 1] }] },
    { ...baseText, fontResource: 'font', animators: [{ selector: { start: 0, end: 1, units: 'index' }, position: [5, 0] }] },
  ];
  const candidate = make(variants, { async load() {
    loaded++;
    return { value: fontBytes, release() { released++; } };
  } });
  check(candidate.player.runtimeStats.pendingResourceCount === 1, 'shared font preparation must be pending');
  await until(() => candidate.player.runtimeStats.pendingResourceCount === 0);
  check(candidate.player.runtimeStats.failedResourceCount === 0, 'real font failed to prepare');
  await until(() => candidate.rasters.every(raster => !raster.updating && raster.texture));
  check(parserRequests() === 1, 'embedded font should download one parser chunk');
  check(candidate.rasters.every(raster => raster.outlineFonts.size === 1), 'real outline parser was not installed');
  // Independent synchronous preparation represents the former rendering path.
  const { parse } = await import('opentype.js');
  const font = parse(fontBytes);
  const cases = [];
  for (let index = 0; index < variants.length; index++) {
    const reference = new AnimationTextRasterizer(variants[index]); references.push(reference);
    reference.setOutlineFont(baseText.fontFamily, 'normal', 400, font);
    await until(() => !reference.updating && reference.texture);
    const actual = pixels(candidate.rasters[index]), expected = pixels(reference);
    let mismatch = 0, painted = 0;
    for (let pixel = 0; pixel < actual.length; pixel++) {
      if (actual[pixel] !== expected[pixel]) mismatch++;
      if (pixel % 4 === 3 && actual[pixel]) painted++;
    }
    check(painted > 0 && mismatch === 0, `font pixels differ in case ${index}: ${mismatch}`);
    cases.push({ kind: ['plain', 'styled', 'selector'][index], paintedPixels: painted, mismatchedChannels: mismatch });
  }
  for (const world of worlds) world.destroy(); worlds.length = 0;
  for (const reference of references) reference.destroy(); references.length = 0;
  check(loaded === 1 && released === 1, 'font handle was not shared/released exactly once');
  check(document.fonts.size === facesBefore, 'registered FontFace leaked');
  const result = { status: 'passed', suite: 'animation-font-loading', parserRequests: parserRequests(),
    fontByteLength: fontBytes.byteLength, fontSha256, cases, loadedHandles: loaded, releasedHandles: released,
    residualFontFaces: document.fonts.size - facesBefore };
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = 'passed';
} catch (error) {
  resultNode.textContent = JSON.stringify({ status: 'failed', error: String(error), stack: error?.stack });
  resultNode.dataset.status = 'failed';
} finally {
  for (const world of worlds) world.destroy();
  for (const reference of references) reference.destroy();
}
