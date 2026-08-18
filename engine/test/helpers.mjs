export function createMockDevice(log = []) {
  const encoder = {
    beginRenderPass(descriptor) {
      log.push(['beginRenderPass', descriptor]);
      return {
        end() {
          log.push(['endPass']);
        },
      };
    },
    finish() {
      log.push(['finish']);
      return { type: 'command-buffer' };
    },
  };
  return {
    createCommandEncoder(descriptor) {
      log.push(['createCommandEncoder', descriptor]);
      return encoder;
    },
    queue: {
      submit(commandBuffers) {
        log.push(['submit', commandBuffers]);
      },
      onSubmittedWorkDone() {
        return Promise.resolve();
      },
    },
  };
}

export function createMockEngine(log = []) {
  const loaders = new Map();
  const components = new Map();
  const outputView = { type: 'output-view' };
  const depthTextureView = { type: 'depth-view' };
  return {
    key: 'mock-target',
    get renderTarget() { return this; },
    device: createMockDevice(log),
    format: 'bgra8unorm',
    width: 640,
    height: 360,
    displayWidth: 640,
    displayHeight: 360,
    reverseZ: false,
    msaaSamples: 1,
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    depthTextureView,
    msaaTextureView: null,
    defaults: {},
    assetManager: {
      registerLoader(loader) {
        loaders.set(loader.type, loader);
      },
      unregisterLoader(type) {
        loaders.delete(type);
      },
      hasLoader(type) {
        return loaders.has(type);
      },
      resolveType() {
        return null;
      },
      async loadUrl(url) {
        return { key: `asset:auto:${url}`, value: { url }, release() {} };
      },
      async loadTexture(url) {
        return { key: `texture:${url}`, value: { url }, release() {} };
      },
      async loadAsset(type, url) {
        return { key: `asset:${type}:${url}`, value: { type, url }, release() {} };
      },
    },
    getDepthFormat() {
      return 'depth24plus';
    },
    registerComponent(registration) {
      components.set(registration.type, registration);
    },
    unregisterComponent(type) {
      components.delete(type);
    },
    getRegisteredComponent(type) {
      return components.get(type);
    },
    getOutputView() {
      return outputView;
    },
    getRenderPassDescriptor() {
      return {
        colorAttachments: [{
          view: outputView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: this.clearColor,
        }],
        depthStencilAttachment: {
          view: depthTextureView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      };
    },
    getRenderPassDescriptorVersion() {
      return 1;
    },
  };
}

export function createMockGpuDevice() {
  return {
    queue: {
      onSubmittedWorkDone() {
        return Promise.resolve();
      },
    },
  };
}
