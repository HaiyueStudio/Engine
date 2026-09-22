import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GuiScrollView,
  GuiHelpDialog,
  GuiButton,
  GuiSwitch,
  GuiRoot,
  GuiElement,
  GuiLabel,
  GuiImage,
  GuiSystem,
  serializeGuiRoot,
  deserializeGuiRoot,
  hitTestGui,
} from '../dist/gui.js';
import { World, GuiBatch, GUI_SHAPE_VERTEX_LAYOUT } from '../dist/experimental.js';
function fixture() {
  const system = new GuiSystem({});
  system.renderer.prepare = () => {};
  const root = new GuiRoot();
  const world = new World('scroll-help');
  system.roots.add(root);
  const view = root.add(
    new GuiScrollView({ x: 20, y: 20, width: 180, height: 100, contentHeight: 500 }),
  );
  const toggle = view.add(new GuiSwitch({ x: 10, y: 10, width: 60, height: 30 }));
  root.layout(320, 480);
  const dispatch = (type, x, y, pointerId = 1) =>
    system.dispatchPointerEvent(world, {
      type,
      x,
      y,
      native: { pointerType: 'touch', pointerId, button: 0, buttons: 1, preventDefault() {} },
    });
  return { system, root, world, view, toggle, dispatch };
}
test('scroll viewport clamps offsets, relayouts content and clips hit testing', () => {
  const { view, toggle, root, world } = fixture();
  view.scrollTo(25);
  assert.equal(toggle.rect.y, 5);
  assert.notEqual(hitTestGui(world, [root], 35, 10), toggle);
  view.scrollTo(999);
  assert.equal(view.scrollY, 400);
  view.setContentHeight(120);
  assert.equal(view.scrollY, 20);
  view.setContentHeight(50);
  assert.equal(view.scrollY, 0);
  view.scrollTo(NaN);
  assert.equal(view.scrollY, 0);
});
test('drag on switch scrolls without activation; reversing, cancel and other fingers are safe', () => {
  const { dispatch, view, toggle, system } = fixture();
  dispatch('pointerdown', 45, 45);
  dispatch('pointermove', 45, 25);
  assert.equal(view.scrollY, 20);
  assert.equal(toggle.pressed, false);
  dispatch('pointerup', 45, 25, 2);
  assert.ok(system.scrollGesture);
  dispatch('pointermove', 45, 44);
  assert.equal(view.scrollY, 1);
  dispatch('pointerup', 45, 44);
  assert.equal(toggle.checked, false);
  view.scrollTo(0);
  dispatch('pointerdown', 45, 45);
  dispatch('pointercancel', 45, 45);
  assert.equal(toggle.checked, false);
  dispatch('pointerdown', 45, 45);
  dispatch('pointermove', 45, 43);
  dispatch('pointerup', 45, 43);
  assert.equal(toggle.checked, true);
  system.destroy();
});
test('wheel normalizes line and page scrolling and clamps', () => {
  const { system, world, view } = fixture();
  for (const [mode, delta, expected] of [
    [1, 2, 32],
    [2, 1, 132],
    [0, 1000, 400],
    [0, -1000, 0],
  ]) {
    system.dispatchWheelEvent(world, {
      x: 80,
      y: 80,
      deltaY: delta,
      native: { deltaMode: mode, preventDefault() {} },
    });
    assert.equal(view.scrollY, expected);
  }
  system.destroy();
});
test('click opens persistent help, interior click stays open, close and backdrop dismiss', () => {
  const { root, dispatch, system } = fixture();
  const help = root.add(
    new GuiHelpDialog({ id: 'help', width: 280, height: 250, message: 'Some rule. '.repeat(100) }),
  );
  const button = root.add(
    new GuiButton({
      x: 220,
      y: 20,
      width: 40,
      height: 40,
      onClick: () => {
        help.show();
        root.layout(320, 480);
      },
    }),
  );
  root.layout(320, 480);
  dispatch('pointerdown', 240, 40);
  assert.equal(help.visible, false);
  dispatch('pointerup', 240, 40);
  assert.equal(help.visible, true);
  assert.ok(help.body.maxScrollY > 0);
  const d = help.dialogRect;
  dispatch('pointerdown', d.x + 6, d.y + 6);
  dispatch('pointerup', d.x + 6, d.y + 6);
  assert.equal(help.visible, true);
  const c = help.closeButton.rect;
  dispatch('pointerdown', c.x + 20, c.y + 20);
  dispatch('pointerup', c.x + 20, c.y + 20);
  assert.equal(help.visible, false);
  dispatch('pointerdown', 240, 40);
  dispatch('pointerup', 240, 40);
  dispatch('pointerdown', 2, 2);
  dispatch('pointerup', 2, 2);
  assert.equal(help.visible, false);
  system.destroy();
});
test('new components and outline buttons serialize without duplicating help internals', () => {
  const { root, view } = fixture();
  view.scrollTo(40);
  view.add(new GuiButton({ id: 'outline', variant: 'outline', text: '?' }));
  root.add(new GuiHelpDialog({ id: 'help', title: '规则', message: '说明' }));
  root.layout(320, 480);
  const data = serializeGuiRoot(root);
  const restored = deserializeGuiRoot(data);
  assert.ok(restored.findById(view.id) instanceof GuiScrollView);
  assert.equal(restored.findById(view.id).scrollY, 40);
  assert.equal(restored.findById('outline').variant, 'outline');
  const help = restored.findById('help');
  assert.ok(help instanceof GuiHelpDialog);
  assert.equal(help.message, '说明');
  assert.equal(help.children.filter((c) => c instanceof GuiScrollView).length, 1);
});
test('scroll clipping applies to shapes, text and images, and resets for siblings', () => {
  const { system, root, view } = fixture();
  const r = system.renderer;
  view.add(new GuiLabel({ text: 'clipped', y: 90, height: 30, width: 90 }));
  view.add(new GuiImage({ source: {}, y: 90, width: 40, height: 30 }));
  root.add(
    new GuiElement({ x: 220, y: 20, width: 40, height: 40, style: { backgroundColor: '#ffffff' } }),
  );
  root.layout(320, 480);
  r.collectElement(root.root, root.theme);
  assert.ok(r.batch.commands.some((c) => c.clip?.height === 100));
  assert.equal(r.batch.commands.at(-1).clip, undefined);
  assert.ok(
    r.textBatch.commands.some(
      (c) => c.text === 'clipped' && c.clip.y === 110 && c.clip.height === 10,
    ),
  );
  assert.ok(r.imageBatch.commands.some((c) => c.clip.height === 10));
  system.destroy();
});
test('outline mesh is a ring with no center fill', () => {
  const b = new GuiBatch();
  b.addShape({
    x: 0,
    y: 0,
    width: 34,
    height: 34,
    radius: 17,
    strokeWidth: 1.5,
    color: [1, 1, 1, 1],
  });
  b.rebuild();
  const stride = GUI_SHAPE_VERTEX_LAYOUT.floatsPerVertex;
  assert.equal(b.vertexCount, 216);
  for (let i = 0; i < b.vertexCount; i++) {
    const x = b.vertexData[i * stride] - 17,
      y = b.vertexData[i * stride + 1] - 17;
    assert.ok(Math.hypot(x, y) >= 15.49);
  }
});

test('unchanged help layout keeps a clean subtree and preserves scrolled text', () => {
  const help=new GuiHelpDialog({message:'Long rule. '.repeat(100),width:280,height:250});
  const viewport={x:0,y:0,width:320,height:480};help.layout(viewport);
  help.body.scrollTo(100);const children=[...help.body.children];help.clearDirty();help.layout(viewport);
  assert.equal(help.dirty,false);assert.equal(help.body.scrollY,100);assert.deepEqual(help.body.children,children);
});


test('a down/up queued before the frame clicks without capturing an expired native touch', () => {
  const {system,dispatch,toggle,world}=fixture();
  system.engine.canvas={setPointerCapture(){throw Error('Cannot capture an inactive native touch.');},releasePointerCapture(){},focus(){}};
  const native={pointerType:'touch',pointerId:1,button:0,buttons:0,preventDefault(){}};
  system.pending.push(...['pointerdown','pointerup'].map(type=>({type,native,x:45,y:45})));
  assert.doesNotThrow(()=>system.dispatchPendingEvents(world));
  assert.equal(toggle.checked,true);assert.equal(system.pending.length,0);
  system.engine.canvas=undefined;system.destroy();
});
