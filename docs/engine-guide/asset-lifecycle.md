# 资产生命周期

海月的资产加载由 `AssetManager`、`AssetJob`、三层缓存和 `AssetUploadScheduler` 共同完成。

## 加载与 owner

`load`、`loadUrl` 和 `loadAsset` 支持 `priority`、`timeoutMs`、`signal`、`owner` 与 `onProgress`。同一 key 的并发请求共享底层 job，但每个请求独立持有引用；一个 owner 离开只释放自己的引用。Scene 使用 `AssetOwnerScope`，销毁、切换和 device lost 会取消未完成请求，提交前还会再次校验 owner，迟到结果不能写回已销毁 Scene。

每个成功请求返回 `AssetHandle`。调用方必须调用 `release()`；引用降到零时，待处理 job 被取消，已创建资源按注册 loader 的 disposer 释放。

## 缓存层

- network：原始响应字节或文本；默认 128 MiB / 512 项。
- parsed CPU：解析和转码后的 CPU payload；默认 256 MiB / 256 项。
- GPUDevice：每个 device 独立；默认 512 MiB / 512 项。

预算淘汰只选择引用为零的最久未使用项。device lost 清理旧 device 的 GPU 层；network/CPU 层保留用于新 device 重建。`AssetManager.getDebugSnapshot()` 会返回每层 entries、bytes、retainedEntries 和上传队列状态。

## worker 与 fallback

glTF/Draco、KTX2 和 Spine 的 worker 导入与 main fallback 相同的生产解析函数。worker 协议或传输故障允许 fallback；无效资产不 fallback，错误 code/path 在两条路径保持一致。

## 上传预算

loader 通过 `AssetLoaderContext.scheduleUpload()` 排队。默认每帧 8 MiB，可由 `AssetManagerOptions.uploadBudgetBytes` 调整，预算必须是正有限值。单个原子任务超过预算会直接返回结构化错误；高优先级只改变队列顺序，不能绕过帧预算。KTX2 loader 已按 mip、layer 和 block-row 自动拆分，其他 loader 应按 mesh、buffer view 或等价 chunk 拆分。

取消或超时后，`AssetJob` 会使迟到结果失效，并调用任务登记的 late-result disposer；因此迟到的 GPU/DOM 资源既不能写回 owner，也不会成为悬空资源。

## glTF 场景 recipe

普通产品通过 Scene plugin 把 glTF 的加载、兼容报告和释放放进同一 scene owner，不直接编排 loader 与 disposer：

```ts
import { Entity, HaiyueEngine } from '@haiyue/engine';
import { createGltfPlugin, GltfModelComponent } from '@haiyue/extensions/gltf';

const engine = new HaiyueEngine({ canvas: '#canvas' });
await engine.init();
const scene = engine.createScene({ name: 'level' });
scene.installPlugin(createGltfPlugin());

const model = new GltfModelComponent({ src: '/assets/level.glb' });
scene.add(new Entity('Level').addComponent(model));
engine.switchScene(scene);

engine.on('after-update', () => {
  if (model.status === 'loaded') showCompatibility(model.runtimeCompatibilityReport);
  if (model.status === 'error') showRecoverableAssetError(model.error);
});
engine.on('capabilities-resolved', ({ detail }) => showDeviceFallback(detail.capabilities.report));
engine.run();

// 切换会取消未完成 job；destroyPrevious 释放模型纹理、buffer 和 asset refs。
engine.switchScene(nextScene, { destroyPrevious: true });
```

`runtimeCompatibilityReport` 是 loader 生成的冻结报告，包含 required extension、动态 UV semantic、mipmap、bounds 和性能摘要；UI 只消费该报告，不重新推断兼容性。device recovery 后 `capabilities-resolved` 会再次发出，应用必须重新展示降级决策。scene 销毁会让 `GltfModelSystem` 中止 pending job 并 dispose 已加载模型。

## 普通图片 mipmap

`loadTexture()` 的 `mipmaps` 选项接受 `'none' | 'generate'`，默认值为 `'none'`，因此非 PBR 调用方不会隐式承担额外首帧上传和约三分之一的纹理显存。启用 `'generate'` 后，引擎从原图尺寸计算到 1×1 的完整 mip chain，先上传 level 0，再用一个 command encoder 的逐级 render pass 生成其余层，整条链只提交一次。`r8unorm`、`rg8unorm`、`rgba8unorm` 与 `bgra8unorm` 及其 sRGB 变体支持生成；不支持的格式会在创建 GPU texture 前返回 `E_ASSET_INVALID_DATA`。

图片缓存键同时包含源对象、format 与 mipmap 策略。同一个 `ImageBitmap`/canvas 以 linear、sRGB 或不同 mip 策略加载时会得到独立 GPU 资源，完全相同的并发请求仍复用底层 job。KTX2 等压缩纹理忽略该生成选项，始终使用资产自带的 mip chain。
