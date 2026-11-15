import assert from 'node:assert/strict';
import test from 'node:test';
import { importEngineSource } from './helpers/internal-source.mjs';

const { GuiInput } = await importEngineSource('gui/components/GuiInput.ts');
const { GuiBrowserTextInputHost } = await importEngineSource('gui/input/GuiBrowserTextInputHost.ts');
const { GuiTextInputConnection } = await importEngineSource('gui/input/GuiTextInputConnection.ts');

function fixture() {
  const document = Object.assign(new EventTarget(), { hasFocus: () => true });
  class NativeInput extends EventTarget {
    style = {};
    dataset = {};
    selectionStart = 0;
    selectionEnd = 0;
    selectionDirection = 'none';
    setAttribute() {}
    setSelectionRange(start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
    }
    focus() { document.activeElement = this; }
    remove() { document.activeElement = null; }
  }
  const timers = new Map();
  let clock = 0;
  let timerId = 0;
  document.defaultView = Object.assign(new EventTarget(), {
    HTMLInputElement: NativeInput, performance: { now: () => clock }, innerWidth: 800, innerHeight: 600,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  document.body = { appendChild() {} };
  document.createElement = () => new NativeInput();
  const changes = [];
  const field = new GuiInput({ value: 'old', onChange: value => changes.push(value) });
  field.selectAll();
  const connection = new GuiTextInputConnection(new GuiBrowserTextInputHost(document), {
    valid: () => true, caretRect: () => ({ x: 0, y: 0, width: 1, height: 18 }),
    viewportInset() {}, command() {}, blur() { connection.close(true); },
  });
  connection.synchronize(field);
  const native = document.activeElement;
  const send = (target, type, timeStamp, data, deliveredAt = timeStamp) => {
    clock = deliveredAt;
    const event = new Event(type);
    for (const [key, value] of Object.entries({ timeStamp, data, isTrusted: true, isComposing: type === 'input' })) {
      Object.defineProperty(event, key, { value });
    }
    target.dispatchEvent(event);
  };
  const mark = (text, time, deliveredAt) => {
    send(native, 'compositionupdate', time, text);
    native.value = text;
    native.setSelectionRange(text.length, text.length, 'none');
    send(native, 'input', time, text, deliveredAt);
  };
  return { field, native, connection, changes, timers, mark,
    begin() { send(native, 'compositionstart', 1, ''); },
    end(text, time) { send(native, 'compositionend', time, text); },
    pointer(time) { send(document, 'pointerdown', time, undefined, clock + 1); },
    expire() { for (const callback of [...timers.values()]) callback(); },
  };
}

test('a click that ends raw preedit before pointer delivery cancels it before the panel loses focus', () => {
  const f = fixture();
  try {
    f.begin();
    f.mark("n'h", 10, 12);
    f.end("n'h", 30);
    assert.equal(f.field.value, 'old');
    f.pointer(29);
    f.connection.close(true);
    f.expire();
    assert.equal(f.field.value, 'old');
    assert.equal(f.field.isComposing, false);
    assert.deepEqual([f.field.selectionAnchor, f.field.selectionFocus], [0, 3]);
    assert.equal(f.field.canUndo, false);
    assert.deepEqual(f.changes, []);
    assert.equal(f.timers.size, 0);
  } finally { f.connection.dispose(); }
});

test('a native candidate replacement commits once, including an explicitly confirmed Latin candidate', () => {
  for (const text of ['你好', 'xxx']) {
    const f = fixture();
    try {
      f.begin();
      f.mark('xxx', 10, 12);
      f.mark(text, 28, 32);
      f.end(text, 30);
      assert.equal(f.field.value, text);
      f.pointer(29);
      f.connection.close(true);
      assert.deepEqual(f.changes, [text]);
      f.field.undo();
      assert.equal(f.field.value, 'old');
      assert.equal(f.field.canUndo, false);
    } finally { f.connection.dispose(); }
  }
});

test('an isolated composition end settles once and a later click keeps that value', () => {
  for (const laterClick of [false, true]) {
    const f = fixture();
    try {
      f.begin();
      f.mark('ā', 10, 12);
      f.end('ā', 30);
      if (laterClick) f.pointer(31);
      else f.expire();
      assert.equal(f.field.value, 'ā');
      assert.deepEqual(f.changes, ['ā']);
      assert.equal(f.timers.size, 0);
    } finally { f.connection.dispose(); }
  }
});

test('disposing a pending host lease prevents a late edit and removes its timer', () => {
  const f = fixture();
  f.begin();
  f.mark('ni', 10, 12);
  f.end('ni', 30);
  f.connection.dispose();
  f.expire();
  assert.equal(f.field.value, 'old');
  assert.equal(f.field.isComposing, false);
  assert.deepEqual(f.changes, []);
  assert.equal(f.timers.size, 0);
});
