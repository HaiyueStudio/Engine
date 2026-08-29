import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBitmapFontData,
  deserializeGuiRoot,
  GuiButton,
  GuiElement,
  GuiImage,
  GuiImageBatch,
  GuiLabel,
  GuiRoot,
  GuiSelect,
  GuiTextBatch,
  measureGuiTextWidth,
  parseGuiColor,
  serializeGuiRoot,
} from '../dist/experimental.js';

test('parseGuiColor supports hex, rgb, hsl, and named colors', () => {
  assert.deepEqual(parseGuiColor('#0f08'), [0, 1, 0, 0.5333333333333333]);
  assert.deepEqual(parseGuiColor('rgb(255 0 128)'), [1, 0, 128 / 255, 1]);
  assert.deepEqual(parseGuiColor('rgba(255, 0, 0, 0.25)'), [1, 0, 0, 0.25]);
  assert.deepEqual(parseGuiColor('hsl(120 100% 50%)'), [0, 1, 0, 1]);
  assert.deepEqual(parseGuiColor('transparent'), [0, 0, 0, 0]);
  assert.deepEqual(parseGuiColor('not-a-color', '#ff0000'), [1, 0, 0, 1]);
  assert.deepEqual(parseGuiColor('#ggg', '#0000ff'), [0, 0, 1, 1]);
});

test('GuiImageBatch groups images by source and writes uv/color vertices', () => {
  const sourceA = {};
  const sourceB = {};
  const batch = new GuiImageBatch();
  batch.addImage({ source: sourceA, x: 0, y: 0, width: 10, height: 20, uv: [0.25, 0.5, 0.25, 0.25], color: [1, 0.5, 0.25, 1] });
  batch.addImage({ source: sourceA, x: 10, y: 0, width: 10, height: 20, uv: [0, 0, 1, 1], color: [1, 1, 1, 1] });
  batch.addImage({ source: sourceB, x: 0, y: 20, width: 10, height: 20, uv: [0, 0, 1, 1], color: [1, 1, 1, 1] });
  batch.rebuild();

  assert.equal(batch.groups.length, 2);
  assert.equal(batch.groups[0].vertexCount, 12);
  assert.equal(batch.groups[1].vertexCount, 6);
  assert.equal(batch.groups[0].vertexData[2], 0.25);
  assert.equal(batch.groups[0].vertexData[3], 0.5);
  assert.equal(batch.groups[0].vertexData[4], 1);
  assert.equal(batch.groups[0].vertexData[5], 0.5);
});

test('GuiTextBatch lays out multiline and wrapped text', () => {
  const font = createTestFont();
  assert.equal(measureGuiTextWidth('AB\nA', font, 10), 20);

  const batch = new GuiTextBatch();
  batch.addText({
    text: 'AB',
    x: 0,
    y: 0,
    width: 15,
    height: 30,
    fontSize: 10,
    color: [1, 1, 1, 1],
    multiline: true,
    wrap: true,
    lineHeight: 12,
  });
  batch.rebuild(font);

  assert.equal(batch.vertexCount, 12);
  assert.equal(batch.vertexData[1], 0);
  assert.equal(batch.vertexData[6 * 12 + 1], 12);
});

test('GUI serialization round-trips root theme, layout, controls, and image source keys', () => {
  const root = new GuiRoot({ id: 'hud', theme: { fontSize: 16, colors: { primary: '#ff00ff' } } });
  const panel = root.add(new GuiElement({ id: 'panel', x: '10%', y: 12, width: 240, height: 120, style: { backgroundColor: 'rgb(10 20 30)' } }));
  panel.add(new GuiButton({
    id: 'apply',
    text: 'Apply',
    variant: 'primary',
    x: 8,
    y: 8,
    style: { hoverBackgroundColor: '#3b82f6', hoverColor: '#ffffff' },
  }));
  panel.add(new GuiLabel({ id: 'status', text: 'Ready', fontSize: 18, textAlign: 'right', autoWidth: true, x: 8, y: 48 }));
  panel.add(new GuiSelect({ id: 'quality', value: 'high', options: [{ label: 'High', value: 'high' }] }));
  panel.add(new GuiImage({ id: 'icon', sourceKey: 'icons/play', uv: [0, 0, 0.5, 0.5], tint: 'cyan' }));

  const serialized = serializeGuiRoot(root);
  const restored = deserializeGuiRoot(serialized, {
    resolveImageSource: key => ({ key }),
  });
  const restoredPanel = restored.findById('panel');
  const restoredIcon = restored.findById('icon');

  assert.equal(serialized.root.children?.[0].x, '10%');
  assert.equal(restored.theme.fontSize, 16);
  assert.equal(restored.theme.colors.primary, '#ff00ff');
  assert.ok(restoredPanel instanceof GuiElement);
  assert.deepEqual(restoredPanel.getLayoutOptions(), { x: '10%', y: 12, width: 240, height: 120 });
  const restoredButton = restored.findById('apply');
  assert.ok(restoredButton instanceof GuiButton);
  assert.equal(restoredButton.style.hoverBackgroundColor, '#3b82f6');
  assert.equal(restoredButton.style.hoverColor, '#ffffff');
  const restoredLabel = restored.findById('status');
  assert.ok(restoredLabel instanceof GuiLabel);
  assert.equal(restoredLabel.text, 'Ready');
  assert.equal(restoredLabel.fontSize, 18);
  assert.equal(restoredLabel.textAlign, 'right');
  assert.equal(restoredLabel.autoWidth, true);
  assert.equal(restoredLabel.disabled, true);
  assert.ok(restoredIcon instanceof GuiImage);
  assert.equal(restoredIcon.sourceKey, 'icons/play');
  assert.deepEqual(restoredIcon.uv, [0, 0, 0.5, 0.5]);
  assert.deepEqual(restoredIcon.source, { key: 'icons/play' });
});

function createTestFont() {
  const glyph = (id, x) => ({
    id,
    x,
    y: 0,
    width: 10,
    height: 10,
    xoffset: 0,
    yoffset: 0,
    xadvance: 10,
    page: 0,
  });
  return createBitmapFontData({
    face: 'test',
    size: 10,
    bold: false,
    italic: false,
    lineHeight: 10,
    base: 10,
    scaleW: 32,
    scaleH: 32,
    pages: [],
    chars: new Map([
      [65, glyph(65, 0)],
      [66, glyph(66, 10)],
      [63, glyph(63, 20)],
    ]),
    kernings: new Map(),
  });
}
