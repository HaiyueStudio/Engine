import assert from 'node:assert/strict';
import test from 'node:test';
import { GuiColorPicker, GuiRoot, serializeGuiElement, deserializeGuiElement } from '../dist/gui.js';

const child = (picker, suffix) => picker.findById(`${picker.id}-${suffix}`);

test('color picker normalizes RGB hex and ignores invalid values without extra events', () => {
  const changes = [];
  const picker = new GuiColorPicker({ value: '#AbC', onChange: v => changes.push(v) });
  assert.equal(picker.value, '#aabbcc');
  assert.equal(child(picker, 'G').value, 187);
  picker.setValue('#112233');
  assert.deepEqual(changes, []);
  for (const invalid of ['red', '#ff', '#gg0011', '#12345678', 'rgba(1,2,3,0.5)']) picker.setValue(invalid, true);
  assert.equal(picker.value, '#112233');
  picker.setValue('#000', true);
  picker.setValue('#000000', true);
  assert.deepEqual(changes, ['#000000']);
  assert.equal(child(picker, 'swatch').style.backgroundColor, '#000000');
});

test('RGB interactions update the swatch and HEX, and commit separately', () => {
  const changes = [], commits = [];
  const picker = new GuiColorPicker({ value: '#000000', onChange: v => changes.push(v), onCommit: v => commits.push(v) });
  child(picker, 'R').setValue(255, true);
  child(picker, 'G').setValue(128, true);
  assert.equal(picker.value, '#ff8000');
  assert.equal(child(picker, 'hex').value, '#ff8000');
  assert.equal(child(picker, 'G-label').text, 'G 128');
  assert.deepEqual(commits, []);
  child(picker, 'G').onCommit(128);
  assert.deepEqual(commits, ['#ff8000']);
  assert.equal(changes.length, 2);
});

test('HEX editing preserves a draft/caret, supports six digits after three, and restores invalid input on Enter', () => {
  const picker = new GuiColorPicker({ value: '#000000' });
  picker.onChange = value => picker.setValue(value); // Controlled consumer must not reset the draft.
  const input = child(picker, 'hex');
  input.setValue('#abc', true);
  assert.equal(picker.value, '#aabbcc');
  assert.equal(input.value, '#abc');
  input.setValue('#abc123', true);
  assert.equal(picker.value, '#abc123');
  input.setValue('#zzzzzz', true);
  assert.equal(picker.value, '#abc123');
  input.onSubmit(input.value);
  assert.equal(input.value, '#abc123');
  assert.equal(input.style.borderColor, '#475569');
});

test('color picker round trips as one control without duplicating internal children', () => {
  const picker = new GuiColorPicker({ id: 'tint', x: 12, width: '80%', height: 160, value: '#f80', disabled: true });
  const data = serializeGuiElement(picker);
  assert.equal(data.type, 'color-picker');
  assert.deepEqual(data.props, { value: '#ff8800' });
  assert.equal(data.children, undefined);
  const restored = deserializeGuiElement(JSON.parse(JSON.stringify(data)));
  assert.ok(restored instanceof GuiColorPicker);
  assert.equal(restored.children.length, picker.children.length);
  assert.equal(restored.value, '#ff8800');
  assert.equal(restored.disabled, true);
  assert.equal(child(restored, 'hex').readOnly, true);
});

test('percentage layout places children inside the picker and disabled inputs cannot edit', () => {
  const root = new GuiRoot();
  const picker = root.add(new GuiColorPicker({ id: 'color', x: 20, y: 30, width: '50%', height: 144 }));
  root.layout(600, 400);
  for (const control of picker.children) {
    assert.ok(control.rect.x >= picker.rect.x);
    assert.ok(control.rect.y >= picker.rect.y);
    assert.ok(control.rect.x + control.rect.width <= picker.rect.x + picker.rect.width);
    assert.ok(control.rect.y + control.rect.height <= picker.rect.y + picker.rect.height);
  }
  const input = child(picker, 'hex');
  assert.equal(root.hitTest(input.rect.x + 5, input.rect.y + 5), input);
  picker.setDisabled(true);
  const before = picker.value;
  input.insertText('f');
  assert.equal(picker.value, before);
  assert.notEqual(root.hitTest(input.rect.x + 5, input.rect.y + 5), input);
  picker.setDisabled(false);
  assert.equal(input.readOnly, false);
  assert.equal(root.hitTest(input.rect.x + 5, input.rect.y + 5), input);
});
