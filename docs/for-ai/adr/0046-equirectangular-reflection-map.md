# ADR 0046：经纬图反射在加载阶段转换为现有 cubemap 契约

- 状态：Accepted
- 日期：2026-07-26
- 影响：`@haiyue/engine/lighting`、EnvironmentLight、PBR 环境反射与 GPU 资源生命周期

## 背景

网页环境图常以 2:1 equirectangular（经纬图）形式交付，而现有 `EnvironmentLight` 和 PBR shader 只接受 `texture_cube`。直接在 PBR shader 中增加 2D 经纬图分支，会扩大每帧绑定、shader variant 和材质状态；由每个示例自行转换，又会产生重复实现和模糊的资源所有权。

## 决策

1. 新增异步工厂 `createEquirectangularReflectionMap(device, source, options)`，仅从 `@haiyue/engine/lighting` 导出，不进入根黄金路径。
2. 工厂接收已经解码的 `ImageBitmap`、`HTMLCanvasElement` 或 `HTMLImageElement`，不复制 AssetManager 的 URL 下载、缓存和解码职责。
3. 输入必须是有效的近似 2:1 经纬图；转换通过一次 GPU render pass 序列写入 `+X/-X/+Y/-Y/+Z/-Z` 六层 texture array。
4. 返回值遵守既有 `EnvironmentCubeTexture`，可直接赋给 `EnvironmentLight.specularTexture`；它拥有生成的 GPUTexture，并提供幂等 `destroy()`。
5. 转换中的临时 2D 纹理在 GPU 工作完成后释放；失败或 abort 统一清理临时纹理与未交付 cubemap，并分别使用 `E_ASSET_INVALID_DATA`、`E_ASSET_JOB_ABORTED`。
6. 首版输出 `rgba8unorm` 单 mip LDR reflection map。它不是 diffuse irradiance，也不是按粗糙度 GGX 预过滤的 specular IBL；调用方需要这些能力时仍应提供相应的预处理 cubemap。
7. 转换发生在资源准备阶段，现有 PBR 的 `texture_cube` binding、环境旋转和每帧渲染路径保持不变。

## 结果

- Web 常见经纬图可以进入现有 EnvironmentLight/PBR 反射闭环，天空球也可继续直接显示原始 2D 图。
- 每张图增加一次初始化期 GPU 转换和一个六面 cubemap 的显存成本，但不增加每帧 draw、binding 或 shader 分支。
- HDR 解码、cubemap mip 生成、diffuse convolution 与 GGX prefilter 不属于本轮能力，不能通过命名或示例暗示已经支持。
- `./lighting` 稳定 surface budget 从 15 增至 19；默认入口仍保持 30 个黄金路径概念。
