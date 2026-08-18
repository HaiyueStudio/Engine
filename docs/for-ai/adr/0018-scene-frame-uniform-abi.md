# ADR 0018：统一 Scene Frame Uniform ABI

- 状态：Accepted
- 日期：2026-07-17

## 背景

Basic、PBR、Blinn-Phong 与 Instanced 渲染器分别声明相机 WGSL struct，并在 TypeScript 中手工维护相同的 `viewProjection`、`eyePosition` 和 Fog offset。增加 Fog 时必须同步修改多份源码，说明 GPU ABI 存在重复事实来源。

## 决策

引擎以 `SceneFrameUniformLayout` 作为 3D 场景帧 Uniform ABI 的唯一 schema：

1. Schema 显式记录字段名称、WGSL 类型、alignment、size 和计算后的 offset。
2. `FogUniforms` 与 `SceneFrameUniforms` 的 WGSL struct 由 schema 生成，通过 Shader Feature Composer 注入入口 shader。
3. CPU writer 必须通过 schema 计算的 offset 写入，renderer 不再保存私有相机数组、size 常量或 Fog writer。
4. 当前 ABI 固定为：
   - `viewProjection`：offset 0，size 64；
   - `eyePosition`：offset 64，size 16；
   - `fog`：offset 80，size 48；
   - struct alignment 16，总 size 128。
5. 同一个 `Camera3DFrameData` 在一帧内只构造一个 `SceneFrameUniformSnapshot`。Basic、PBR、Blinn-Phong、Instanced 消费同一 CPU 数据。
6. 各 renderer 暂时继续拥有独立 GPU uniform buffer。是否共享 GPU buffer 留到资源生命周期、动态 offset 和多相机策略明确后再决定。

## API 分层

ABI schema、生成器和 snapshot 属于低层渲染协议，仅从 `experimental` 入口导出。稳定材质渲染上下文继续提供高层相机与 Fog 数据，不暴露内置 GPU buffer。

## 后果

- 新增曝光、时间、viewport 或环境字段时只修改一份 schema 和 writer。
- WGSL 字段顺序与 TypeScript offset 不会独立漂移。
- ABI 测试和架构门禁会阻止 renderer 重新声明私有相机布局。
- 当前仍有每个 renderer 一次 GPU buffer 上传；本 ADR 先消除 ABI 和 CPU 数据重复，不提前耦合 GPU 资源所有权。
