import test from 'node:test';
import assert from 'node:assert/strict';
import { HaiyueEngine } from '../dist/core.js';

const compatibilityContract = HaiyueEngine.webGpuCompatibility;
const { Status } = compatibilityContract;

test('HaiyueEngine initialization emits the shared unsupported, adapter, and context contracts', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
  });
  try {
    const unsupported = new HaiyueEngine({ canvas: createCanvas(null) });
    await assert.rejects(
      unsupported.init(),
      error => compatibilityContract.classifyError(error)?.status === Status.Unsupported,
    );
    unsupported.destroy();
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }

  const adapterUnavailable = new HaiyueEngine({
    canvas: createCanvas(null),
    gpu: {
      requestAdapter: async () => null,
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  await assert.rejects(
    adapterUnavailable.init(),
    error => compatibilityContract.classifyError(error)?.status === Status.AdapterUnavailable,
  );
  adapterUnavailable.destroy();

  const device = {
    features: new Set(),
    queue: {
      writeBuffer() {},
      writeTexture() {},
      copyExternalImageToTexture() {},
      submit() {},
      onSubmittedWorkDone: async () => {},
    },
    createBuffer: () => ({ destroy() {} }),
    createTexture: () => ({ destroy() {} }),
    createQuerySet: () => ({ destroy() {} }),
    destroy() {},
  };
  const contextUnavailable = new HaiyueEngine({
    canvas: createCanvas(null),
    gpu: {
      requestAdapter: async () => ({
        features: new Set(),
        requestDevice: async () => device,
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  await assert.rejects(
    contextUnavailable.init(),
    error => compatibilityContract.classifyError(error)?.status === Status.ContextUnavailable,
  );
  contextUnavailable.destroy();
});

test('WebGPU fatal compatibility states retain distinct engine codes and one WebGPU-only policy', () => {
  const expectations = [
    [Status.Unsupported, 'E_WEBGPU_UNSUPPORTED'],
    [Status.AdapterUnavailable, 'E_WEBGPU_ADAPTER_UNAVAILABLE'],
    [Status.ContextUnavailable, 'E_WEBGPU_CONTEXT_UNAVAILABLE'],
  ];

  for (const [status, code] of expectations) {
    const error = compatibilityContract.createError(status);
    const compatibility = compatibilityContract.classifyError(error);
    assert.equal(error.code, code);
    assert.equal(compatibility.status, status);
    assert.equal(compatibility.code, code);
    assert.equal(compatibility.fatal, true);
    assert.match(compatibility.message, /WebGPU/i);
  }
  assert.match(
    compatibilityContract.classifyError(
      compatibilityContract.createError(Status.Unsupported),
    ).message,
    /does not provide a WebGL fallback/,
  );
  assert.equal(compatibilityContract.classifyError(new Error('unrelated')), null);
});

test('optional WebGPU feature loss is a non-fatal deterministic degradation report', () => {
  const compatibility = compatibilityContract.report({
    report: {
      degraded: true,
      decisions: [{
        capability: 'gpu-driven-culling',
        requested: true,
        enabled: false,
        fallback: 'frustum-culling',
        reason: 'indirect-first-instance is unavailable.',
      }, {
        capability: 'gpu-timestamp-query',
        requested: false,
        enabled: false,
        fallback: null,
        reason: 'Not requested.',
      }],
    },
  });

  assert.equal(compatibility.status, Status.OptionalFeatureDegraded);
  assert.equal(compatibility.fatal, false);
  assert.equal(compatibility.code, null);
  assert.deepEqual(compatibility.degradations, [{
    feature: 'gpu-driven-culling',
    fallback: 'frustum-culling',
    reason: 'indirect-first-instance is unavailable.',
  }]);
  assert.equal(compatibilityContract.report(null).status, Status.Supported);
  assert.equal(compatibilityContract.degraded([]).status, Status.Supported);
});

test('shared WebGPU compatibility page renders fatal and degraded states with matching structure', () => {
  const document = new FakeDocument();
  const container = document.createElement('div');
  const fatal = compatibilityContract.classifyError(
    compatibilityContract.createError(Status.AdapterUnavailable),
  );
  compatibilityContract.renderPage(container, fatal, { productName: 'Contract Test' });

  assert.equal(container.dataset.webgpuCompatibility, 'adapter-unavailable');
  assert.equal(container.attributes.role, 'alert');
  assert.equal(container.style.display, 'grid');
  assert.match(container.text, /Contract Test · WebGPU only/);
  assert.match(container.text, /E_WEBGPU_ADAPTER_UNAVAILABLE/);

  compatibilityContract.renderPage(container, compatibilityContract.degraded([{
    feature: 'timestamp-query',
    fallback: 'CPU timing',
    reason: 'The optional feature is unavailable.',
  }]));
  assert.equal(container.dataset.webgpuCompatibility, 'optional-feature-degraded');
  assert.equal(container.attributes.role, 'status');
  assert.equal(container.style.display, 'block');
  assert.match(container.text, /timestamp-query/);
  assert.match(container.text, /Fallback: CPU timing/);

  compatibilityContract.renderPage(container, compatibilityContract.report(null));
  assert.equal(container.dataset.webgpuCompatibility, 'supported');
  assert.equal(container.style.display, 'none');
  assert.equal(container.children.length, 0);
});

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
}

class FakeElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.style = new FakeStyle();
    this.textContent = '';
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  get text() {
    return [this.textContent, ...this.children.map(child => child.text)].join(' ');
  }
}

class FakeStyle {
  removeProperty(property) {
    const camelCase = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    delete this[camelCase];
  }
}

function createCanvas(context) {
  return {
    width: 1,
    height: 1,
    clientWidth: 1,
    clientHeight: 1,
    getContext: type => type === 'webgpu' ? context : null,
    getBoundingClientRect: () => ({ width: 1, height: 1 }),
    addEventListener() {},
    removeEventListener() {},
  };
}
