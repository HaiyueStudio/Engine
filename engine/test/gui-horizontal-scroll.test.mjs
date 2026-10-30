import assert from 'node:assert/strict';
import test from 'node:test';
import { GuiRoot, GuiScrollView, GuiButton, GuiSystem, hitTestGui, serializeGuiRoot, deserializeGuiRoot } from '../dist/gui.js';

function fixture() {
  const root = new GuiRoot(), system = new GuiSystem({}); system.renderer.prepare = () => {}; system.roots.add(root);
  const view = root.add(new GuiScrollView({ id: 'row', axis: 'horizontal', x: 20, y: 20, width: 180, height: 100, contentWidth: 700, inertia: true }));
  let clicks = 0;
  const card = view.add(new GuiButton({ x: 10, y: 10, width: 90, height: 70, onClick: () => clicks++ }));
  root.layout(320, 200);
  const pointer = (type, x, time) => system.dispatchPointerEvent(null, { type, x, y: 50, timestamp: time, native: { pointerType: 'touch', pointerId: 1, button: 0, buttons: 1, timeStamp: time, preventDefault() {} } });
  return { root, system, view, card, pointer, clicks: () => clicks };
}

test('horizontal viewport translates and clips X, clamps on shrink and round-trips its axis', () => {
  const { root, system, view, card } = fixture();
  view.scrollTo(25); assert.equal(view.scrollX, 25); assert.equal(view.scrollY, 0); assert.equal(card.rect.x, 5); assert.equal(card.rect.y, 30);
  assert.notEqual(hitTestGui(null, [root], 10, 50), card);
  const copy = deserializeGuiRoot(serializeGuiRoot(root)); copy.layout(320, 200);
  const restored = copy.root.children[0]; assert.equal(restored.axis, 'horizontal'); assert.equal(restored.scrollX, 25); assert.equal(restored.contentWidth, 700);
  view.scrollTo(999); assert.equal(view.scrollX, 520);
  view.setContentWidth(200); assert.equal(view.scrollX, 20);
  view.setContentWidth(90); assert.equal(view.scrollX, 0); assert.equal(view.maxScrollY, 0);
  system.destroy();
});

test('horizontal drag cancels the card click and releases actual X momentum', () => {
  const { view, pointer, clicks, system } = fixture();
  pointer('pointerdown', 90, 0); pointer('pointermove', 60, 20); pointer('pointermove', 30, 40); pointer('pointerup', 30, 50);
  assert.equal(view.scrollX, 60); assert.equal(clicks(), 0); assert.equal(view.animating, true);
  view.advanceAnimation(30); assert.ok(view.scrollX > 60); assert.equal(view.scrollY, 0);
  view.stopInertia(); assert.equal(view.animating, false); system.destroy();
});

test('horizontal wheels support trackpad X, ordinary Y and page-width normalization', () => {
  const { view, system } = fixture();
  for (const [deltaX, deltaY, deltaMode, expected] of [[20, 0, 0, 20], [0, 2, 1, 52], [1, 0, 2, 232]]) {
    system.dispatchWheelEvent(null, { x: 80, y: 60, deltaX, deltaY, native: { deltaMode, preventDefault() {} } });
    assert.equal(view.scrollX, expected); assert.equal(view.scrollY, 0);
  }
  system.destroy();
});
