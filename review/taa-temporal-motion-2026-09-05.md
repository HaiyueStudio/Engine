# TAA 运动重投影升级验证

日期：2026-09-05。实现决策见 [ADR 0095](../docs/for-ai/adr/0095-motion-reprojected-temporal-antialiasing.md)。本次在已有多视图生命周期、辅助几何与材质语义修复之上继续修改，没有重置其他工作区改动。

## 行为变化

- TAA 自身声明 depth 和 motion 依赖，单独启用即可获得相机、刚体、morph、蒙皮运动。Motion v2 的 XY 排除投影抖动，Z 保存对应表面的上一帧线性深度，W 区分连续历史、历史重置与无覆盖；Motion Blur 继续读取 XY。
- 历史按稳定输出网格重投影，使用独立 HDR 颜色与 R32 深度双缓冲。深度验证发生在每个双线性采样点上；3×3 最近表面的深度和配对速度允许亚像素轮廓累积，YCoCg 方差及范围裁剪限制旧颜色。
- 无运动覆盖的远背景使用相机重投影；该路径抵消投影抖动，透视天空忽略相机平移。有限深度的缺失 motion、首次出现的物体、屏幕外历史与深度不匹配拒绝历史。
- `resetHistory(viewKey?)` 同步重置颜色与运动历史。视图切换保持资源独立；尺寸、相机、投影形状、近远面、深度约定或帧连续性变化会拒绝旧颜色。
- 历史替换和后处理卸载经过提交及队列完成边界。组合验证还修复了 Motion Blur 在同一 encoder 内交替尺寸时销毁早先视图临时纹理、覆盖尺寸 uniform 的问题。

## 契约与成本

CPU packer、shader 输入、生成结果、反射、消费者和浏览器夹具共同迁移。Motion uniform 为 272 字节（此前 240），内部格式为 `rgba16float`；直接向 TAA 提供旧 `rg16float` 会明确报错。几何变形 ABI v1 和既有 deformation 静态变体数保持不变。机器契约见 [temporal-postprocess-extension-contract.json](../shader-language/temporal-postprocess-extension-contract.json)。

| 资源或工作 | 当前成本 |
| --- | --- |
| 每视图 TAA 颜色与深度历史 | 24 字节/像素；1080p 约 47.5 MiB，不含场景颜色、辅助纹理和 GPU 分配对齐 |
| Motion v2 纹理 | 8 字节/像素；相比 RG16 增加 4 字节/像素 |
| TAA resolve | 每视图一次全屏 draw、三个颜色附件、每帧一次 176 字节 uniform 上传 |
| TAA 独立启用 | 新增按需 motion 场景 pass；已有其他 motion 消费者时复用该 pass 和纹理 |
| 生成 WGSL | 354,927 字节；相比本次修改前的 351,516 增加 3,411 字节 |
| 生产 shader 统计 | 65 个生成 WGSL 文件、57 个静态 pass/pipeline；本次没有新增静态变体 |

检查覆盖资源复用与延迟释放，不构成性能加速结论。没有采集正式 CPU、GPU timestamp 或 queue-wait 性能样本；浏览器像素读回耗时也没有作为渲染耗时报告。没有放宽预算或改变统计范围。

## 验证

- 全仓 `npm run typecheck` 通过。
- 全仓 `npm test` 通过：shader-language 112、Engine 589、animation-spec 139、extensions 372、示例目录 7，共 1,219 项。
- 根目录 `npm run build` 通过；全部核心 workspace 构建完成，示例使用 `EXAMPLE_FILTER=taa-postprocess,motion-blur` 限定范围，并构建共享 Engine bundle 与 source viewer。4 个产物均通过 freshness 检查（指纹 `67007f1c7491`），未重建全部示例。
- TAA 真实 WebGPU 25 个用例通过：13 个像素合成用例及 12 个双视图真实场景用例；包含有/无速度对照、动态深度、遮挡、新实体、缺失 motion、屏幕外、深度边界、抖动、天空、亚像素轮廓、HDR/alpha/深度精度，以及刚体、morph、蒙皮、相机、单视图 reset、resize、reverse-Z、两种 Motion Blur 重建模式。
- 辅助语义 7 组 GPU 像素检查、多视图生命周期 5 帧通过（12/12 辅助纹理退休），均无 validation error。
- stage8 的 9 个后处理 shader 编译、三附件 TAA pipeline 和灰度像素检查通过；stage10 的 9 个 deformation shader 编译、反射与历史速度像素检查通过。
- `modules:check`、`responsibilities:check`、`renderer-prepare:check`、`docs:check`、`fast-gate-policy:test` 通过。职责聚合归回后处理 owner，原有 Render3DSystem 行数门禁也已恢复通过。
- 新增 `engine/test/taa-temporal.test.mjs` 的 6 个用例使用共享 audit GPU，覆盖内部格式错误路径、视图隔离、HDR/depth 资源、投影和历史失效、提交完成前禁止释放，以及 Motion Blur 尺寸资源复用。

浏览器环境为 Windows、Chrome 152、NVIDIA Pascal。诊断文件写入 `artifacts/webgpu/taa-temporal-diagnostic.json`，绑定源码指纹、revision、dirty 状态、浏览器和 adapter 信息；该报告为回归诊断，不覆盖正式性能证据。

## 门禁限制与后续边界

`shader-language:check` 和 stage14 DAG 仍因生成体积预算失败：354,927 > 328,000 字节；相对预算基线增长 49,423 > 22,500 字节。此前已有超预算，本次增加了 3,411 字节；预算原样保留。

`api:check` 仍报告已有 audio、simulation、GUI、animation 与 workspace 依赖图的基线漂移，本次没有更新该基线或新增稳定导出概念。TAA 已有的 motion-history 查询方法增加可选 view key，见 ADR 中的接口条款。

多层透明、粒子和自定义顶点 shader 的独立速度、reactive mask、曝光补偿及 TAAU 尚未实现。剧烈切镜、seek 和 teleport 应显式调用 reset。直接调用 `apply()` 且没有引擎提交边界时，替换的历史资源保留到 `destroy()`。
