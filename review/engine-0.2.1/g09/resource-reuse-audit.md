# G09 临时纹理生命周期复用审计

日期：2026-10-01。本次实现用户启动的阶段三；G09 整体、正式性能资格与发布状态保持未完成。

## 实现与边界

- Deferred 在图编译完成后按 G-buffer 使用区间解析附件。顺序视图共享兼容纹理，最新结果继续留给诊断读回。
- Deferred AO 的 visibility 纹理在拷贝至光照 storage buffer 后结束使用；不同视图的 storage buffer 和参数实例继续独立。
- AO raw/denoised 在各自使用区间内独占，连续 AO 实例和顺序视图可复用；GaussianBlur 的 horizontal scratch 在垂直模糊完成后可复用。
- 同一 usage scope 的读写输入/输出不别名；完整描述符精确匹配。不同未提交 encoder 隔离，跨提交依赖同一设备队列的已提交顺序，销毁等待全部引用完成。
- TAA/运动历史、外部 RTT、主场景/透射颜色、已有双缓冲及未知效果不纳入新增复用。没有新增 stable API、Shader 或预算额度。

合同见 [ADR 0112](../../../docs/for-ai/adr/0112-transient-texture-lifetime-reuse.md)。本阶段复用 GPUTexture 对象，不是底层 heap 别名；也没有引入图缓存或异步多队列。

## 原生资源与像素结果

[最终完整矩阵](../../../artifacts/engine-0.2.1/g09/regressions-2026-10-01T14-01-23.698Z.json)确认 AMD RDNA 1 和 Intel Gen 9，含运行时、fixture 构建和 HTTP 来源指纹。两设备均通过 Forward 单视图、Deferred reference/Tiled 四视图、Tiled 混合尺寸四视图的关闭/开启复用对照。

小型诊断场景使用 16 灯、三个 PBR 盒体、GTAO/SAO/SSAO 链及两次 GaussianBlur；同尺寸视图为 64×64，混合视图另含 48×40。预热后统计物理分配，不属于正式性能采样场景。

| 同尺寸四视图临时纹理 | 保守模式 | 复用模式 | 减少 |
| --- | ---: | ---: | ---: |
| G-buffer | 448 KiB / 16 张 | 112 KiB / 4 张 | 75% |
| AO visibility 与 scratch | 88 KiB | 18 KiB | 79.5% |
| GaussianBlur scratch | 64 KiB | 32 KiB | 50% |
| 三类合计 | 600 KiB | 162 KiB | 73% |

上述物理字节及池内高水位在两设备一致；只涵盖参与复用的纹理，不是全部 Engine 显存、驱动驻留或按比例推断的帧率收益。mixed-size、Forward 的完整值保留在原始证据中。

所有资源对照像素最大差为 0，最新 G-buffer 读回一致；Forward 实际 render pass 为 16→16，四视图为 72→72。稳态新增纹理数为 0，结束后 owner 残留及活跃 GPU 资源为 0。兼容性矩阵还覆盖每设备 30 个效果组合、36 个 AO 光照语义组合、16 个输出组合、5 帧多视图回收与 17 个辅助语义案例。

这是同一候选内禁用/启用复用的归因对照，不能代替旧生产 A0 与最终 B4 的完整性能资格。CPU/GPU P95、队列等待和 720p/1080p 完整场景收益仍待后续 G09/G05 采样。

## 失败与稳定性记录

- 最初 MRT 映射错误将图资源名称覆盖到所有附件，产生重复名称异常。已改为只复制区间端点，并增加含真实图资源名称的回归输入。
- 单元测试发现闲置清理可能过早淘汰仍在队列中的可复用纹理，已改为只清理无 pending/submitted 引用的闲置项；销毁的队列保护保持独立。
- 中间两轮集显矩阵出现过新夹具空画面和 TAA HDR 黑帧；断言和阈值未放宽，失败证据保留。
- 为区别新增回归与环境/既有路径问题，使用上一阶段原始 runtime chunks（逐个 SHA256 验证）重建仅 re-export 的旧入口，执行三轮旧/新交错输出检查。[对照记录](../../../artifacts/engine-0.2.1/g09/reuse-output-ab-2026-10-01T14-00-13.363Z.json)：旧构建 2/3 通过，一次镜面亮度丢失；候选 3/3 通过。[旧制品来源](../../../artifacts/engine-0.2.1/g09/reuse-oracle-before/provenance.json)保留来源和重建说明。
- 该对照证明旧构建也有像素不稳定现象，**不能证明候选黑帧与它完全同因，也不能宣称偶发问题已修复**。最后一次完整矩阵通过，但持续稳定性资格保持未完成，后续需独立追查。所有轮次保留，不能只选择最后一轮作为发布稳定性证据。

## 工程检查

- 定向测试 56/56，全仓测试 1,392/1,392；原生证据策略测试 8/8。
- 定向与全仓 typecheck/build 通过，96 个示例目标全量构建通过。
- 模块、责任边界、同步 prepare、公共 API、文档和 no-rive 门禁通过；milestones 检查通过。
- 最终构建后重新核对源码和 runtime 指纹，与上述原生矩阵一致。当前为 dirty 开发证据，不是 clean 发布资格。
- 本次没有 package/export 变更，未重复运行包消费安装门禁；完整 G09 发布门禁继续留待最终候选。

[检查摘要与文件指纹](resource-reuse-checks.json)；[完整命令日志（含失败轮次）](../../../artifacts/engine-0.2.1/g09/checks/reuse-2026-10-01T14-11-40.256Z/)。

## 重现

```bash
npm run build -w ./engine
node --test engine/test/transient-texture-allocator.test.mjs
node scripts/webgpu-gate/build-deferred-fixture.mjs --framegraph
node scripts/verify-framegraph-regressions.mjs
```

新资源夹具接入既有 FrameGraph 原生回归入口；构建/运行证据均写入 G09，未覆盖 G04 历史证据。
