import test from 'node:test';
import assert from 'node:assert/strict';
import {loadResponsiveLayoutModules, responsiveLayoutFixture} from './responsive-layout-fixture.mjs';
const {spec, textProduction: {ProductionTextOwner}} = await loadResponsiveLayoutModules();
const document = spec.parseResponsiveLayoutDocument(responsiveLayoutFixture());
// Port/ownership tests only; this small outline is not used as real-font pixel evidence.
function portFixture() {
  const port = {acquires: 0, releases: 0, shapes: 0, input: null, output: null,
    async acquire(document, signal) {
      this.acquires++; this.signal = signal; if (this.gate) await this.gate;
      return {shape: request => {
        this.shapes++; this.input = request;
        const style = {...document.textStyles[0], ...(request.styles?.body ?? {})};
        const source = request.strings?.labelText ?? document.textBlocks[0].runs[0].text;
        const sequence = [...source][0], width = request.constraints?.width?.value ?? document.textBlocks[0].width;
        this.output = {block: request.block, size: [width, 52], contentSize: [13, 24],
          runs: sequence ? [{font: 'font', style, glyphs: [{id: 1, clusterUtf16: 0, sequence, rect: [0, -16, 11, 20], advance: 13,
            transform: [1, 0, 0, 1, 0, 0], opacity: 1, paint: {kind: 'outline', commands: 'MLLZ', values: [0, 0, 5, -16, 11, 0]}}]}] : [],
          lines: [{rect: [0, 0, 13, 24], startUtf16: 0, endUtf16: source.length}], controls: []};
        if (this.mutate) this.mutate(this.output);
        return this.output;
      }, release: () => {this.releases++; if (this.releaseThrows) throw Error('release failed');}};
    }};
  return port;
}
async function create(port = portFixture(), options = {}) {const owner = new ProductionTextOwner(document, port, options); await owner.prepare(); return {owner, port};}

test('prepared fonts are borrowed once and unchanged canonical requests reuse one immutable result', async () => {
  const {owner, port} = await create();
  const first = owner.shape({block: 'label', strings: {labelText: 'A'}});
  const same = owner.shape({strings: {labelText: 'A'}, block: 'label'});
  assert.equal(first, same); assert.equal(port.shapes, 1); assert.equal(port.acquires, 1);
  owner.shape({block: 'label', strings: {labelText: 'B'}}); assert.equal(port.shapes, 2); assert.equal(owner.stats.cached, 1);
  owner.dispose(); owner.dispose(); assert.equal(port.releases, 1); assert.equal(owner.stats.cached, 0);
});

test('font results are deep immutable snapshots rather than aliases to host geometry or style arrays', async () => {
  const {owner, port} = await create();
  const result = owner.shape({block: 'label', strings: {labelText: 'A'}});
  port.output.runs[0].glyphs[0].rect[0] = 99; port.output.runs[0].glyphs[0].paint.values[0] = 99;
  assert.equal(result.runs[0].glyphs[0].rect[0], 0); assert.equal(result.runs[0].glyphs[0].paint.values[0], 0);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.runs) && Object.isFrozen(result.runs[0].glyphs[0].paint.values)); owner.dispose();
});

test('bitmap views retain native payload identity but never expose resource release or freeze platform objects', async () => {
  const port = portFixture(), bitmap = {mutableNativeObject: true}; let released = 0;
  port.mutate = result => {result.runs[0].glyphs[0].paint = {kind: 'bitmap', source: {value: bitmap, bytes: 256, generation: 2, release() {released++;}}, uv: [0, 0, 1, 1]};};
  const {owner} = await create(port), result = owner.shape({block: 'label'}), source = result.runs[0].glyphs[0].paint.source;
  assert.equal(source.value, bitmap); assert.equal('release' in source, false); assert.equal(Object.isFrozen(bitmap), false);
  bitmap.mutableNativeObject = false; owner.dispose(); assert.equal(released, 0, 'only the prepared-font release owns its acquired platform handles');
});

test('malformed paints, stale styles, logical clusters and violated box constraints reject without replacing the cached frame', async () => {
  const invalid = [
    result => {result.runs[0].glyphs[0].paint.commands = 'MLC';},
    result => {result.runs[0].glyphs[0].paint.values[0] = NaN;},
    result => {result.runs[0].glyphs[0].paint = {kind: 'placeholder', color: [1, 0, 0, 1]};},
    result => {result.runs[0].glyphs[0].rect[2] = -1;},
    result => {result.runs[0].glyphs[0].sequence = 'X';},
    result => {result.runs[0].style.fontSize = 99;},
    result => {result.runs[0].font = 'missing-font';},
    result => {result.runs[0].glyphs[0].opacity = 2;},
    result => {result.size[0] = 999;},
  ];
  for (const mutate of invalid) {
    const {owner, port} = await create(); const good = owner.shape({block: 'label', strings: {labelText: 'A'}});
    port.mutate = mutate;
    assert.throws(() => owner.shape({block: 'label', strings: {labelText: 'B'}, constraints: {width: {mode: 'exact', value: 60}}}), error => error.code === 'E_HYA_RUNTIME_TEXT');
    assert.equal(owner.shape({block: 'label', strings: {labelText: 'A'}}), good); owner.dispose();
  }
});

test('UTF-16 source ranges cannot split a surrogate pair or reference text from an earlier transaction', async () => {
  const {owner, port} = await create();
  const valid = owner.shape({block: 'label', strings: {labelText: '😀A'}}); assert.equal(valid.runs[0].glyphs[0].sequence, '😀');
  port.mutate = result => {result.runs[0].glyphs[0].clusterUtf16 = 1;};
  assert.throws(() => owner.shape({block: 'label', strings: {labelText: '😀B'}}), error => error.code === 'E_HYA_RUNTIME_TEXT'); owner.dispose();
});

test('invalid requests fail before the font port and request metadata is immutable during platform shaping', async () => {
  const {owner, port} = await create();
  for (const request of [{block: 'absent'}, {block: 'label', strings: 'bad'}, {block: 'label', constraints: {width: {mode: 'exact', value: Infinity}}},
    {block: 'label', cursors: {caret: -1}}, {block: 'label', styles: {body: {id: 'other'}}}, {block: 'label', styles: {absent: {}}},
    {block: 'label', styles: {body: {fontSize: 0}}}, {block: 'label', future: true}]) {
    assert.throws(() => owner.shape(request), error => /^E_HYA_RUNTIME_/.test(error.code));
  }
  assert.equal(port.shapes, 0);
  const request = {block: 'label', strings: {labelText: 'A'}, styles: {body: {fontSize: 24}}};
  owner.shape(request); assert.ok(Object.isFrozen(port.input.strings)); request.styles.body.fontSize = 40;
  assert.equal(port.input.styles.body.fontSize, 24); owner.dispose();
});

test('concurrent preparation shares a job; abort retires a late prepared font handle exactly once', async () => {
  const port = portFixture(), controller = new AbortController(); let release;
  port.gate = new Promise(resolve => {release = resolve;});
  const owner = new ProductionTextOwner(document, port, {signal: controller.signal});
  const first = owner.prepare(), second = owner.prepare(); assert.equal(first, second); assert.equal(port.acquires, 1);
  controller.abort(); assert.equal(port.signal.aborted, true); release();
  await assert.rejects(first, error => error.code === 'E_HYA_RUNTIME_ABORTED'); assert.equal(port.releases, 1);
  assert.equal(owner.stats.pending, false); owner.dispose(); assert.equal(port.releases, 1);
});

test('recursive font callbacks and disposal during shaping cannot publish a partial or stale result', async () => {
  const {owner, port} = await create();
  port.mutate = () => {owner.shape({block: 'label'});};
  assert.throws(() => owner.shape({block: 'label'}), error => error.code === 'E_HYA_RUNTIME_TEXT'); assert.equal(owner.stats.cached, 0);
  port.mutate = () => {owner.dispose();};
  assert.throws(() => owner.shape({block: 'label'}), error => error.code === 'E_HYA_RUNTIME_DISPOSED'); assert.equal(port.releases, 1);
});

test('missing font ports and malformed prepared handles fail explicitly; release errors do not repeat cleanup', async () => {
  assert.throws(() => new ProductionTextOwner(document, null), error => error.code === 'E_HYA_RUNTIME_HOST_PORT');
  let releases = 0; const malformed = new ProductionTextOwner(document, {async acquire() {return {release() {releases++;}};}});
  await assert.rejects(malformed.prepare(), error => error.code === 'E_HYA_RUNTIME_HOST_PORT'); malformed.dispose(); assert.equal(releases, 1);
  const port = portFixture(); port.releaseThrows = true; const {owner} = await create(port); owner.dispose(); owner.dispose();
  assert.equal(owner.stats.releaseFailed, true); assert.equal(port.releases, 1);
});
