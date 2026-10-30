# G11 GUI 依赖边界与共享文本候选

当前结论（2026-10-24）：用户已将最新 62 文件共享范围加入 G11，原协调补丁及七份优化已应用并核对全部候选哈希。现有 `@haiyue/engine/gui` 入口经新增回归验证可动态分包；鼠标指针反馈沿用共享输入域。以下未应用描述及数值是历史候选观测，原失败保留；最新检查见 [授权与验证记录](../../artifacts/engine-0.2.2/g11/admission-20261024/result.json)。分包不放宽原消费者 55,000 B 总闭包上限。

问题：只使用 `GuiSystem` 与 `GuiToast` 也会带入未使用控件和编辑响应器，原正式候选为 111,687 B gzip。通用 shader adapter 还保留整组 2D pass。固定 Unicode 字素算法同时服务普通显示文本，不能为了缩小 GUI 而删除。

方法：控件携带原有身份和绘制器，`GuiInput` 接入原文本服务，保持同一输入域、G06 编辑器、字体和 GPU owner。纯文本入口复用固定 Unicode 算法；按仓库原脚本裁剪不可达声明。后续隔离优化让 GUI 只引用三个相同的生成 shader pass，并以无损 delta VLQ 存储三张 Unicode 属性表，加载时还原原数组。完整七 pass artifact、WGSL、哈希、ABI 和缓存身份保持；字素算法、版本、公开能力与预算保持。

结论：**生产源码尚未应用，GUI/font 门禁仍失败，G11 未完成**。

| 候选 | 原夹具 gzip | 原上限 | 状态 |
| --- | ---: | ---: | --- |
| 固定 56 文件协调提案 | 84,532 B | 55,000 B | 超出 29,532 B，等待协调 |
| 后续 shader／Unicode 隔离优化 | 80,006 B | 55,000 B | 累计减少 4,526 B，仍超出 25,006 B |

测量保持原公开 `gui-font` 夹具、ES 输出、`inlineDynamicImports: true`、不压缩 JS、gzip level 9。较早 85,127→84,532 B 的 595 B 变化随分块／排序出现，不记作功能拆分收益。固定协调提案包含完整许可，总包体为 2,015,937／2,100,000 B packed、8,395,693／9,000,000 B unpacked，均在原上限内；这不代表 GUI/font 通过。

| 验证 | 当前隔离优化证据 |
| --- | --- |
| 构建／实际 tarball | 完整 Engine 语义编译与声明通过；原声明裁剪后运行时／公开声明哈希保持；61 项公开工厂及严格类型通过 |
| 原 GUI | 165 项公开检查、57 项私有语义／后加载响应器检查通过；原控件绘制仍由控件拥有 |
| 固定 Unicode 数据 | 852 组范围逐项一致；3,342,336 次全码位属性比较与 1,187 条官方语料通过；相同固定源文件 SHA-256 及生成复核通过 |
| Shader ABI／缓存 | 11 项反射与缓存检查通过；原 Stage 9 gate 通过，合计 11,791／12,000 B；后续数据修改的三份 shader／runtime payload 与该资格逐字节一致 |
| 实际 WebGPU | 双 DPR 各 195 项通过；276 对独立 PNG 最大差异 2，原容差保持；与上一候选 276 张同名图像逐像素相同；销毁后 GPU 残留 0 |

数据解码只在模块初始化执行一次。私有分配工厂诊断中位约 0.073 ms、P95 约 0.133 ms，排除了解析／IO、完整应用冷启动及 Native，不能作为生产性能资格。物理 IME／Native、正式资源与性能、全局门禁和完整字体 profile 仍需完成。

依赖归因显示当前保留 83 个源模块，主要为 GuiSystem、GuiRenderer、输入域和拖放控制；未使用控件和 G06 响应器不在该闭包。源模块诊断为 80,786 B，不能替代实际公开包的 80,006 B 门禁结果。通用 GuiElement 仍承诺拖放，GuiSystem 仍承诺滚动，不能直接删除这些行为充当优化。[归因证据](../../artifacts/engine-0.2.2/g11/gui-font-source-profile-1792832650730/result.json)只用于确定进一步重构位置，原 55,000 B 上限保持。

extensions 总包还有独立的未通过项：当前为 775,817／550,000 B packed、3,785,002／3,000,000 B unpacked，原文件白名单也尚未包含必须随包交付的 `THIRD_PARTY_NOTICES.txt`。绑定组修复前的候选已为 774,673／3,778,694 B，本次仅增加 1,144／6,308 B；未将这项既有容量缺口归因于资源修复。四个相关消费者及动画／状态机初始、总加载预算均通过，不能代替总包容量。文件数仍只观察；许可、能力和数值上限均未删改。[原政策与归档字节复核](../../artifacts/engine-0.2.2/g11/animation-package-capacity-1792834334832/result.json)。

协调边界：[待答复的 56 文件提案](g11-public-api-admission.md)仍固定不变。后续 shader 六份生产文件及 Unicode 一份生成文件均尚未加入该范围；批准原请求不自动授权这些额外七份文件。原生成文件通过生成器产出，没有手工修改；全部原失败、参考、配额和旧报告保留。

[当前 Unicode 优化、生成器、图像与哈希](../../artifacts/engine-0.2.2/g11/gui-unicode-packed-record-1792830021977255100/result.json) · [Shader 优化资格](../../artifacts/engine-0.2.2/g11/gui-pass-boundary-record-1792829535354724000/result.json) · [固定协调提案](../../artifacts/engine-0.2.2/g11/coordinated-admission-record-1792829000912821600/result.json) · [组合基础与原失败索引](../../artifacts/engine-0.2.2/g11/gui-shared-text-record-1792827580420731100/result.json)
