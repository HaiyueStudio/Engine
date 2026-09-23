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

test('switch capsule geometry uses circular ends and inherits clipping', () => {
  for (const [width, height] of [[50, 30], [24, 24], [75, 45]]) {
    const batch = new GuiBatch();
    batch.addShape({ x: 10, y: 20, width, height, radius: height / 2, roundedMesh: true, color: [1, 1, 1, 1], clip: { x: 0, y: 0, width: 200, height: 200 } });
    batch.rebuild();
    assert.equal(batch.vertexCount, 108);
    const stride = GUI_SHAPE_VERTEX_LAYOUT.floatsPerVertex, fields = GUI_SHAPE_VERTEX_LAYOUT.floatOffsets;
    for (let i = 0; i < batch.vertexCount; i++) {
      if (i % 3 === 0) continue;
      const x = batch.vertexData[i * stride + fields.position] - 10;
      const y = batch.vertexData[i * stride + fields.position + 1] - 20;
      const center = x < width / 2 ? height / 2 : width - height / 2;
      assert(Math.abs(Math.hypot(x - center, y - height / 2) - height / 2) < 0.001);
      assert.equal(batch.vertexData[i * stride + fields.clip + 2], 200);
    }
  }
});

test('scroll inertia is opt-in, tunable, frame-rate independent and bounded', () => {
  const make = options => { const v = new GuiScrollView({ contentHeight: 10000, ...options }); v.rect = { x: 0, y: 0, width: 200, height: 300 }; return v; };
  const plain = make({}); plain.fling(1200); plain.advanceAnimation(100);
  assert.equal(plain.scrollY, 0); assert(!plain.animating);
  const a = make({ inertia: true }), b = make({ inertia: true });
  a.fling(1000); b.fling(1000);
  for (let i = 0; i < 30; i++) a.advanceAnimation(1000 / 30);
  for (let i = 0; i < 120; i++) b.advanceAnimation(1000 / 120);
  assert(Math.abs(a.scrollY - b.scrollY) < 0.0001);
  const strong = make({ inertia: true, inertiaStrength: 2 }); strong.fling(1000); strong.advanceAnimation(1000);
  assert(strong.scrollY > a.scrollY);
  a.scrollTo(10); assert(!a.animating);
  a.fling(-4000); a.advanceAnimation(16); assert.equal(a.scrollY, 0); assert(!a.animating);
  a.scrollTo(a.maxScrollY - 1); a.fling(4000); a.advanceAnimation(16);
  assert.equal(a.scrollY, a.maxScrollY); assert(!a.animating);
  b.inertia = false; b.advanceAnimation(16); assert(!b.animating);
  b.inertia = true; b.inertiaStrength = 0; b.fling(5000); assert(!b.animating);
});

test('fling uses recent release speed, new contact stops it and hold/cancel do not fling', () => {
  const { system, root, world, view } = fixture();
  view.inertia = true;
  const send = (type, y, timeStamp) => system.dispatchPointerEvent(world, { type, x: 45, y, native: { pointerType: 'touch', pointerId: 1, button: 0, buttons: 1, timeStamp, preventDefault() {} } });
  send('pointerdown', 95, 1000); send('pointermove', 75, 1016); send('pointermove', 45, 1032); send('pointerup', 45, 1048);
  const released = view.scrollY;
  assert(view.animating); assert(system.animating);
  view.advanceAnimation(16); assert(view.scrollY > released);
  send('pointerdown', 80, 1100); assert(!view.animating);
  const stopped = view.scrollY; send('pointerup', 80, 1116); view.advanceAnimation(100); assert.equal(view.scrollY, stopped);
  view.scrollTo(0);
  send('pointerdown', 95, 2000); send('pointermove', 45, 2020); send('pointerup', 45, 2300); assert(!view.animating);
  send('pointerdown', 95, 3000); send('pointermove', 45, 3020); send('pointercancel', 45, 3030); assert(!view.animating);
  view.fling(1000);
  system.dispatchWheelEvent(world, { x: 45, y: 80, deltaY: 1, native: { deltaMode: 0, preventDefault() {} } });
  assert(!view.animating, 'do not add a second momentum curve to native wheel events');
  view.fling(1000); root.root.visible = false; assert(!system.animating);
  system.suspendForDeviceLoss(); assert(!view.animating);
  system.destroy();
});

test('switch movement and color have independent durations, default instant, and reverse continuously', () => {
  const plain = new GuiSwitch(); plain.setChecked(true); assert.equal(plain.thumbProgress, 1); assert.equal(plain.colorProgress, 1); assert(!plain.animating);
  const s = new GuiSwitch({ thumbTransitionMs: 200, colorTransitionMs: 400 });
  s.setChecked(true); assert.equal(s.thumbProgress, 0); assert.equal(s.colorProgress, 0); assert(s.animating);
  s.advanceAnimation(100); assert(s.thumbProgress > 0 && s.thumbProgress < 1);
  assert(s.colorProgress > 0 && s.colorProgress < s.thumbProgress);
  s.advanceAnimation(100); assert.equal(s.thumbProgress, 1); assert(s.colorProgress < 1);
  const color = s.colorProgress; s.setChecked(false); assert.equal(s.colorProgress, color); assert.equal(s.thumbProgress, 1);
  s.advanceAnimation(400); assert.equal(s.thumbProgress, 0); assert.equal(s.colorProgress, 0); assert(!s.animating);
  const checked = new GuiSwitch({ checked: true, thumbTransitionMs: 200, colorTransitionMs: 200 });
  assert.equal(checked.thumbProgress, 1); assert(!checked.animating);
  checked.setChecked(false); checked.finishAnimation(); assert.equal(checked.thumbProgress, 0); assert(!checked.animating);
});

test('motion options serialize while transient velocities and progress do not', () => {
  const root = new GuiRoot();
  root.add(new GuiScrollView({ id: 'motion-list', inertia: true, inertiaStrength: 1.5, contentHeight: 400, height: 100 }));
  root.add(new GuiSwitch({ id: 'motion-switch', thumbTransitionMs: 200, colorTransitionMs: 300, checked: true }));
  const restored = deserializeGuiRoot(serializeGuiRoot(root));
  const list = restored.findById('motion-list'), control = restored.findById('motion-switch');
  assert.equal(list.inertia, true); assert.equal(list.inertiaStrength, 1.5); assert(!list.animating);
  assert.equal(control.thumbTransitionMs, 200); assert.equal(control.colorTransitionMs, 300);
  assert.equal(control.thumbProgress, 1); assert(!control.animating);
});

test('GuiSystem advances visible motion once per update and stops hidden subtrees', async () => {
  const { Entity } = await import('../dist/index.js');
  const { system, root, world, view } = fixture();
  const control = root.add(new GuiSwitch({ thumbTransitionMs: 200, colorTransitionMs: 200 }));
  world.addEntity(new Entity('motion').addComponent(root)); world.addSystem(system);
  view.inertia = true; view.fling(1000);
  control.setChecked(true); assert.equal(control.thumbProgress, 0);
  world.update(100, 100);
  assert(view.scrollY > 0); assert(control.thumbProgress > 0 && control.thumbProgress < 1); assert(system.animating);
  world.update(200, 100); assert.equal(control.thumbProgress, 1);
  root.root.setVisible(false); world.update(216, 16);
  assert(!view.animating); assert(!system.animating);
  world.destroy();
});

test('render integration advances GUI motion with autoUpdate disabled and only once across views', async () => {
  const { Entity } = await import('../dist/index.js');
  const { RenderIntegration } = await import('../dist/experimental.js');
  const { system, root, world, view } = fixture();
  world.addEntity(new Entity('integrated-motion').addComponent(root)); world.addSystem(system);
  const integration = new RenderIntegration({});
  world.addRuntimeIntegration(integration); integration.registerAll(world);
  assert.equal(system.autoUpdate, false);
  system.prepareRoots = () => {}; system.render = () => {};
  integration.pipeline.execute = w => {
    system.record(w, { frameData: w.frameData });
    system.record(w, { frameData: w.frameData });
  };
  const control = root.add(new GuiSwitch({ thumbTransitionMs: 200, colorTransitionMs: 200 }));
  control.setChecked(true); assert.equal(control.thumbProgress, 0);
  view.inertia = true; view.fling(1000);
  world.update(100, 100);
  assert(Math.abs(view.scrollY - 325 * (1 - Math.exp(-100 / 325))) < 0.0001);
  assert(control.thumbProgress > 0 && control.thumbProgress < 1);
  world.update(200, 100); assert.equal(control.thumbProgress, 1);
  world.destroy();
});
