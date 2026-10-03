# G09 阶段五：诊断与示例

日期：2026-10-02。实现与当前双设备专项验收完成；持续稳定性资格未提升。G09 active；G05 性能资格、阶段六完整 A0/B4 对照和既有 Intel 偶发问题均保留。

## 实现与 API 评审

[ADR 0114](../../../docs/for-ai/adr/0114-framegraph-one-shot-diagnostics.md)定义单次捕获及作用域；[示例说明](../../../examples/deferred-lighting/README.md)和[API](../../../docs/api/framegraph-inspector.md)描述用户操作。

既有 experimental renderer 帧计划诊断扩展 3 个符号：createFrameGraphInspector、FrameGraphInspector、FrameGraphSnapshot。candidate 与基线逐项核对：仅 `./experimental/renderer` 和兼容 `./experimental` 各增同样 3 个符号，无删除、stable/root/subpath/工作区依赖变化。renderer 56→59、aggregate 860→863，均在已批准的储备内；不修改任何配置预算。调用时复制、冻结的快照不暴露 GPU 句柄/回调。包消费覆盖 runtime 及 TypeScript 类型，实际 tarball 安装、29 个 browser consumer 和 Node/TS/exports/CLI 全部通过。Engine 包为 515 个文件、1,899,410 B packed、7,926,625 B unpacked；原上限 620 / 2,100,000 B / 9,000,000 B，不扩预算。

## 观测边界

默认不收集图数据；只有下一次 record 被武装后才复制元数据并代理命令。正常渲染不构建大 JSON，无同步 GPU 读回。捕获数据包含当前 system 所有本帧事件；父子图不能相加作为 GPU pass。分配区间是批次局部闭区间，不构造虚假全局 GPU 时间线。

编码计数与 GPU 完成不同；bundles 内 draw 标记不可观测，submit 只代表所选 context 的提交回调。记录结束时的 pool/pending 高水位是部分临时资源分配估算，不称为全部显存。metadataCopyMs 仅代表部分元数据复制成本，不伪称完整观测开销或性能收益。

PNG 从冻结元数据生成逻辑图，不读场景 GPU；JSON 不增加导出根或 sideEffect。单元测试验证冻结、取消、嵌套、截断、提交、原有 GPU timing 标签继承和代理 encoder 的退休身份。示例路径/设备切换清空快照；退出取消未执行捕获并释放对象 URL。

## 验收

[最终检查与源码指纹](diagnostics-checks.json) · [原生数据、截图与导出](../../../artifacts/engine-0.2.1/g09/inspector-2026-10-02T01-40-29.660Z/native.json) · [工程日志及真实包消费](../../../artifacts/engine-0.2.1/g09/diagnostics-engineering-2026-10-02T01-34-51.416Z/public-packages.json)。

Chrome 154 / Metal，AMD RDNA1 和 Intel Gen9 各 9 项、合计 18 项通过。每条路径先等待已提交 GPU 工作完成并跨两个呈现帧，保存两张未武装观察者的对照，再捕获并保存图像。两个未武装帧及捕获前后 RGB 平均差都为 0；阈值仍为精确 0。等待只由浏览器检查调用，普通示例捕获不等待 GPU。

| 路径 | 实际 render / compute | draw / dispatch | 观察到 submit | 两设备捕获像素差 |
| --- | --- | --- | --- | --- |
| Forward | 2 / 0 | 34 / 0 | 1 | 0 |
| Deferred reference | 4 / 0 | 35 / 0 | 1 | 0 |
| Tiled Deferred | 4 / 1 | 35 / 1 | 1 | 0 |

该表用于说明所选 system 编码工作，不是灯数覆盖等价的性能比较。两个 GaussianBlur 的独立批次 3/4 使用同一物理纹理 `4:1`；AO 池及 scratch 映射均可见。灰度/模糊在 AO 独立输出场景被裁剪。JSON 下载解析后与冻结快照相等；PNG 下载可解码为 1200 像素宽逻辑图。桌面/移动布局已人工查看；移动端无页面横向溢出，宽表格在容器内滚动。退出前武装未执行捕获，退出后跟踪资源/字节均为 0；两设备 console error、exception、未分类失败均为 0。

工程检查：root typecheck/test/build 通过；根测试当时 1,407 项，补齐 timing-attribution 测试后最终 Engine 767 项重跑通过，各 workspace 合计 1,408 项。最新 96 个示例构建及 freshness 全部通过；专项 inspector/cache 14 项、inspector/package policy 11 项通过。API、模块、职责、prepare、docs、no-rive 通过；Shader 缓存 11/11、75 WGSL / 561,776 B、67 variants，成本预算不变。

## 保留的失败与资格边界

- [首次检查](../../../artifacts/engine-0.2.1/g09/inspector-2026-10-02T01-27-01.394Z/native.json)错误要求双模糊属于同批次区间合并。真实实现是先后释放的独立 lease；检查改为验证相同池/物理 ID，补充跨池误匹配单元测试。没有降低像素或资源阈值。
- [中间复核](../../../artifacts/engine-0.2.1/g09/inspector-2026-10-02T01-34-50.244Z/native.json)在 Intel reference 发生 33.80262669429336 的平均像素差。该版截图未等待 GPU 工作完成，亦未保存未武装的连续对照；现有记录不足以确定是呈现时序、既有集显偶发还是观察者相关问题。失败保留，不因后续通过而认定已修复。
- 最终 runner 增加 GPU 完成等待、两帧未武装对照和所有对照 PNG 原件，当前专项通过。等待改善了可比性，但不是上述失败的因果证明。
- 所有证据为 dirty 开发候选；未获得 clean 发布资格。完整 A0/B4 性能人口、持续稳定性和既有集显异常追查继续归阶段六及 G05/G07，不以本阶段截图或亚毫秒复制时间宣称性能收益。
