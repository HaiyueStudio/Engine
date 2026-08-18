# Device recovery

默认情况下 `GPUDevice.lost` 会触发引擎恢复。状态依次进入 recovering，重新协商 adapter/device capabilities，重建 render target 与注册的 GPU participant，恢复 active scene，最后发出 `device-restored`。

```ts
engine.on('recovery-progress', ({ detail }) => console.log(detail.phase, detail.completed, detail.total));
engine.on('capabilities-resolved', ({ detail }) => inspect(detail.capabilities.report));
engine.on('recovery-failed', ({ detail }) => showFatal(detail.error));
```

可恢复组件必须保留 CPU descriptor，不保留旧 device 的 GPU 对象；在 suspend 取消上传并释放 device cache，在 restore 按 owner 重建。PBR material texture handle、shadow target、environment bind group 和 renderer object table 都遵循该路径。恢复后 profile 可能降级，必须重新读取 capability report，不能沿用旧 feature 判断。
