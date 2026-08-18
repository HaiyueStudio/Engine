# Plugin authoring

插件通过 `EnginePlugin` / scene plugin context 注册能力。安装产生的每项副作用必须由 `RegistrationToken` 管理，卸载或安装失败时自动回滚。

```ts
export const plugin = {
  name: 'acme.example',
  version: '1.0.0',
  installScene(context) {
    context.registerComponent({ type: 'AcmeComponent', component: AcmeComponent });
    context.registerAssetLoader(loader);
    context.rollback.track(() => externalSubscription.dispose());
  },
};
```

约束：

- 用公开 registry，不修改 Scene 或 Engine 私有字段。
- 声明依赖并允许宿主决定启用顺序；不要在 module import 时产生副作用。
- GPU 对象必须绑定 owner scope，实现 device suspend/recovery/destroy。
- 材质扩展实现 `MaterialShaderContract`，并通过 stable 的 `MaterialRendererRegistration` / `MaterialRenderContext` 协议注册渲染器。
- GPU-driven batch buffer、间接绘制命令、readback 与 renderer cache 是 `experimental` 实现细节，普通材质扩展不得依赖。
- 插件测试至少覆盖重复卸载、安装失败回滚、依赖缺失、scene destroy 和 device lost。
- `context.rollback.track()` 只登记插件自己创建的外部副作用；`registerComponent()`、`registerAssetLoader()` 等 registry API 返回的 token 已自动加入同一安装事务，不要重复登记。
