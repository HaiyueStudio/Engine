# G09 真实依赖与无用步骤裁剪

日期：2026-10-01。范围：用户启动的依赖/裁剪子阶段；完整 G09 仍 active。

## 实现

- 帧计划从导出资源和显式副作用回溯活跃节点，取消全部节点强制执行。先检查全部声明再执行，死分支中的错误也不能被裁剪隐藏。
- Deferred 光照 AO 明确声明辅助深度、法线和帧参数的生产者；resolve、特殊不透明与透明光照显式消费 AO。无 AO 时继续执行中性绑定的提交保护和旧资源退休。
- 后处理按逐效果颜色版本、深度、法线、运动和 outline mask 编译。已审核的 Grayscale、GaussianBlur、FXAA、Sobel、Outline 可裁剪；未知效果和派生类保守保留。
- AO 的 occlusion 模式不依赖前置颜色结果。裁剪同时作用于运行、prepare、warmup 和辅助纹理需求；物理 ping-pong 按保留后的顺序绑定。
- AO 帧推进、TAA 和 MotionBlur 状态、主视图输出、RTT、阴影及镜面输出保持必要执行。稳定 API、Shader、画质合同和预算没有变更。

## 对照含义

结构夹具使用真实 Render3DSystem，场景为 192×128、7 个对象、单视图，效果链为 Grayscale → GaussianBlur → Outline → GTAO → Scene output。对照组通过继承相同内置实现保守保留整条链，候选使用精确内置类型；另有直接 GTAO 和正常 composite 对照。

这是同一候选的裁剪消融对照，不是旧版本 A0 与最终版本 B4 的正式性能比较。首帧先预热，再统计实际编码的 render pass；CPU/GPU P95、队列等待和显存峰值收益尚未采样。

## 边界与后续

图覆盖帧阶段、Deferred AO/光照和逐效果后处理的逻辑依赖。AO 内部降采样/去噪、透射捕获及历史纹理的物理细节仍由现有 owner 管理。有效 source 绑定与颜色内容依赖分开描述；当前图不能直接用来推断所有物理纹理的别名兼容性。

后续仍需物理资源映射与生命周期复用、计划缓存及失效合同、完整 A0/B4 两设备性能验收。结构计数下降不代表帧率同比提升，不改变 G05 未通过状态和 G07 发布条件。

## 重现

```bash
npm run build -w ./engine
node scripts/webgpu-gate/build-deferred-fixture.mjs --framegraph
node scripts/verify-framegraph-culling.mjs
node scripts/verify-framegraph-regressions.mjs
```

验证器使用共享 Chrome、GPU 审计、读回和 G04 校验器，输出带源码/构建指纹的独立 G09 开发证据；不得覆盖 G04 历史证据或提升为 clean 发布凭据。

## 原生结构结果

[最终裁剪证据](../../../artifacts/engine-0.2.1/g09/culling-2026-10-01T13-27-56.980Z/native.json)包含构建指纹、浏览器 HTTP 来源与逐场景释放结果。两类设备分别确认是 AMD RDNA 1 和 Intel Gen 9，均非软件适配器。

| 场景 | 保守对照实际 render pass | 裁剪后实际 render pass | 最大像素误差 |
| --- | ---: | ---: | ---: |
| GTAO occlusion，AMD | 15 | 6 | 0 |
| GTAO occlusion，Intel | 15 | 6 | 0 |
| GTAO composite，两设备 | 15 | 15 | 0 |

- occlusion 链的逻辑节点从 5 个减为 2 个，保留 GTAO 与最终输出；实际 GPU pass 减少 9 个（60%），包括被裁剪效果内部及 outline 辅助步骤。
- 与 outline 标签关联的被追踪资源记录从 7 个降至 0 个。这是资源记录计数，不是 7 张纹理或显存字节数。
- 直接 GTAO 对照也是 6 个 pass，像素与裁剪链完全一致。所有对照的 WebGPU 错误、释放后 owner 残留及活跃 GPU 资源均为 0。
- 这些结论只适用于该诊断场景；普通 composite 链没有无用输出，不声称获得相同降幅。

## 兼容性回归

[最终回归证据](../../../artifacts/engine-0.2.1/g09/regressions-2026-10-01T13-28-30.513Z.json)在 AMD RDNA 1、Intel Gen 9 各运行一次以下矩阵，全部通过：

- 30 个 Forward / Deferred reference / tiled 效果组合。
- 36 个 AO 光照语义组合，覆盖直接光、自发光、环境光、IBL 和透射语义。
- 16 个输出组合，覆盖 HDR RTT、TAA、曝光、透射拷贝、特殊材质回退和镜面子视图。
- 多视图切换与辅助纹理回收：5 帧，12/12 个观察到的辅助纹理释放。
- 17 个辅助纹理像素语义案例。

继续复用原有阈值与 G04 校验器。辅助/多视图夹具现在读取 powerPreference 参数，默认仍为 high-performance；本次记录确认两类真实适配器，避免把两次独显运行当作双设备覆盖。

早期未通过记录保留在 G09 artifacts：夹具首帧统计范围与 GPUAdapter 生命周期错误已修正，随后完整重跑；没有修改产品阈值。HTTP 挂载策略测试首次受沙箱回环监听限制，获得本机监听权限后重跑通过。

## 最终检查

[检查日志目录](../../../artifacts/engine-0.2.1/g09/checks/final-2026-10-01/)保留以下结果：

- 定向测试 47/47；全仓测试 1,388/1,388（Engine 747）。
- 全仓 typecheck、build 通过；examples 构建完成 96 个目标（含共享产物）。
- 模块边界、职责边界、同步 prepare 合同、API 基线、文档检查通过。
- 相关 fixture/build/挂载策略测试 13/13；milestones 配置检查通过。
- 全仓构建完成后重新核对，两组最终 native 证据的运行时与构建指纹仍匹配当前候选。

审计结论：本次授权的依赖与裁剪子阶段完成。G09 保持 active，正式性能收益与发布资格不作提升。
