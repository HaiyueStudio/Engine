# G09 同提交读回与已知答案对照

日期：2026-10-02。范围：验收基础设施诊断；没有修改 Engine 运行时、生成 shader、固定 A0、预算或版本。所有样本 `performanceQualified: false`。历史异常仍见 [验收异常追查](acceptance-investigation.md)。

## 第一步：同一提交与资源生命周期

新增 `framegraph-atomic-readback.mjs`。第 5 帧渲染完成后，不再记录下一帧，不归还/销毁输出和 HDR 输入；在一个 command encoder、一次 queue.submit 中编码：

1. 最终输出的 compute 读回；有 COPY_SRC 的人口再直接 texture-to-buffer。
2. HDR 输入的 compute 读回。
3. 已知图案的 compute 与直接复制读回。
4. 已知缓冲区的 buffer-to-buffer 复制。
5. 包含固定标记、帧编号、两张纹理实际尺寸的 GPU 执行标记及其复制。

直接复制明确指定 mip、origin、aspect、offset、bytesPerRow、rowsPerImage 和三维 extent；目标是 BGRA8，读回统一解码为 RGBA。不同路径使用独立 staging buffer。CPU 在映射成功后复制数据，再 unmap；所有 map 用 `Promise.allSettled` 收齐，包括失败结果，最后才销毁全部临时资源。一条映射失败不会提前销毁另一条尚未完成的映射。

这里的“一次提交”指整组诊断命令，不是把场景渲染和诊断强行合并。场景输出在此期间没有写入或资源复用。没有增加 sleep、预热轮数、队列等待或生产热路径同步。

旧分次读回仍可通过原命令复现；新模式由 `node scripts/verify-framegraph-black-frame.mjs --readback=atomic` 启动。

## 第二步：有标准答案的对照

- **缓冲区**：CPU 在 mappedAtCreation 阶段写入 256 个变化的 uint32；GPU 复制后逐字精确比较。全零、未覆盖标记和单字错误都会失败。
- **纹理**：CPU 上传 63×5、各通道不同的已知 BGRA8 图案。宽度特意不满足 256 字节行对齐，使直接复制必须处理 padding；compute 和 copy 分别与独立 CPU 预期比较，不能仅互相比较。
- **执行标记**：GPU 写入 `[4660, frameId, targetWidth, targetHeight, 22136, frameId, sourceWidth, sourceHeight]`，检查尺寸与旧帧污染。
- 控制资源在场景预热前创建/上传，但在复杂 AO/模糊渲染链完成后与主图像一起读回，避免只验证简单程序。

三组包装范围：

| access | 采样 | 场景命令编码 | 保留部分 |
| --- | --- | --- | --- |
| audited | 使用现有审计设备方法 | 现有包装 | 全部统计与资源跟踪 |
| native | 使用包装前保存的原生设备/队列方法 | 现有包装 | 场景统计与资源跟踪；目标 createView 观察仍保留 |
| native-encoding | 同 native | command encoder、render pass、render bundle encoder 绕过统计包装 | 资源分配/销毁跟踪、上传统计、Engine 诊断及最终输出观察 |

最后一组不是完全移除一切观察逻辑。它只定位命令编码包装因素，不能凭通过就证明所有统计工具无影响。它不提供 draw/pass 或性能结论；记录原始诊断计数及排除原因，再在共享销毁前重置统计窗口。资源所有权不重置，仍检查释放后 ownerResidual/liveGpuResources 为零。原有正式门禁没有关闭任何断言。

完整人口：两个冻结 GPU × 两种 COPY_SRC × 三种包装范围 × A0/B4/B4/A0 = **48 个独立 Chrome 会话**。保留 36 个 A0 配对比较，不挑选成功路径、轮次或 GPU。无 COPY_SRC 人口仍读取主图像，但主图像不能执行直接复制；已知图案始终双路径。

## 分类规则与边界

- 控制失败或主图像两条路径矛盾：`capture-unreliable`，采样不可信，失败。
- 控制通过、读回一致但主图像不符合现有完整覆盖/亮度要求：`image-mismatch`，失败。这仍不单独证明驱动或 Engine 中哪层出错。
- 两者均通过：该样本通过，不替代长期稳定性或 F0–F8 性能验收。
- 映射失败：明确标为 `capture-unreliable` / `failureStage: mapping` 并保留完整错误；格式、验证错误和清理异常为框架/执行失败。不能将它们归为成功样本。

跨 GPU 使用本机两块冻结设备。另从 [Google 官方版本清单](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json) 下载独立 Chrome for Testing `156.0.8078.4`（Beta/mac-x64），在专用临时目录执行同一 48 样本人口，与已安装 Chrome `154.0.8037.93` 对照。ZIP 完整性与实际版本核对通过；下载来源、SHA-256 记录在 `artifacts/engine-0.2.1/g09/chrome-156-provenance.json`。该测试发行版没有代码签名，签名检查结果如实保留，[官方说明](https://github.com/GoogleChromeLabs/chrome-for-testing/issues/205)也说明了该发行形式。没有替换系统浏览器、使用用户配置或修改系统安全设置。

这属于同一浏览器家族跨版本，不是 Safari/WebKit 跨实现验证，也不能单独确定 Dawn、Metal、驱动或硬件根因。

## 实测与工程检查

原始报告：`artifacts/engine-0.2.1/g09/black-frame-2026-10-02T14-30-40.467Z/report.json`。48 个会话全部完成，**34 通过、14 失败**；36 个版本配对比较中 22 通过、14 失败。配对失败与单样本失败是不同统计，不能相加或拿正常 A0 替换失败基准。

| GPU / 包装范围 | 通过 | 图像不符合预期 | 采样不可信 |
| --- | ---: | ---: | ---: |
| AMD RDNA-1 / audited | 8 | 0 | 0 |
| AMD RDNA-1 / native | 8 | 0 | 0 |
| AMD RDNA-1 / native-encoding | 8 | 0 | 0 |
| Intel Gen-9 / audited | 2 | 4 | 2 |
| Intel Gen-9 / native | 5 | 3 | 0 |
| Intel Gen-9 / native-encoding | 3 | 3 | 2 |

浏览器统一为 Chrome `154.0.8037.93` / Metal，未用软件 GPU。48 个样本均无 WebGPU validation error，资源清理检查均通过。采样前后 runtime/source/wrapper 与 A0/B4 bundle 校验通过；没有运行中输入变化或浏览器框架失败。

### 新增定位证据

1. `low-power-1-audited-0-A0.json`、`low-power-1-audited-3-A0.json`、`low-power-1-native-encoding-0-A0.json`：compute 输出为零；直接拷贝、固定缓冲区及执行标记的 staging 数据仍为预填 `0xA5`（uint32 `2779096485`）。固定图案的两个路径也失败。这是同提交内执行/传输/映射结果不符合预期的证据，不能解释为场景本身只画了黑色。
2. `low-power-1-native-encoding-2-B4.json`：固定缓冲区、图案的两种读取、执行标记都通过，但主目标 compute 与直接拷贝仍矛盾，最大差异 `0.6470588235294118`。compute 返回全幅黑色/alpha=1；直接拷贝只更新首像素，其余 4095 像素保持预填 `0xA5`。**即使同提交的已知答案全部正确，也不能省略主目标双路径比较。**
3. `low-power-1-audited-1-B4.json`：全部控制正确，主目标两条路径一致（最大差异约 `1.11e-8`），仍只覆盖首像素，其余 4095 像素保持 magenta/alpha=0；HDR 输入也只剩一个有 RGB 的像素。属于主图像异常，尚不能仅凭此确定发生于 Engine、shader、后端哪一层。
4. 三种包装范围均复现异常，包含旧 A0 和当前 B4。命令编码统计包装不是这些异常复现的必要条件；但资源跟踪和部分 Engine 观察仍存在，不能扩大为“所有工具无问题”。

结论：同提交与原生编码绕过**都没有成为可采用的修复**；目前能完整保留并分开报告图像异常和不可信采样。不能从本轮各组通过比例推导性能或稳定性收益，不能挑选 native 组作为绿色替代。

### Chrome 156 跨版本复核

原始报告：`artifacts/engine-0.2.1/g09/black-frame-2026-10-02T14-50-04.405Z/report.json`。同样 48 个独立会话、同一 runtime、夹具和检查脚本指纹；全部完成，报告失败。

| GPU / 包装范围 | 单样本像素与控制通过 | 映射失败（device lost） |
| --- | ---: | ---: |
| AMD RDNA-1 / audited | 8 | 0 |
| AMD RDNA-1 / native | 8 | 0 |
| AMD RDNA-1 / native-encoding | 8 | 0 |
| Intel Gen-9 / audited | 0 | 8 |
| Intel Gen-9 / native | 1 | 7 |
| Intel Gen-9 / native-encoding | 3 | 5 |

20 个 Intel 样本的映射错误均明确包含 `mapAsync` / `Device is lost`。所有 pending map 的失败均被收齐，原始 JSON 保留全部错误，资源清理仍为零。另 4 个 Intel 样本单独像素与控制检查正常，但对应固定 A0 已因 device lost 缺少图像，仍无法形成有效的版本配对。独显 18 个配对通过，集显 18 个配对全部失败/不可用。

旧汇总在读取缺失像素时给出笼统的“缺少读回”或“缺少配对像素”。现已补强为显式映射失败，并将不可用配对记录为失败。**没有重采 GPU 样本、没有修改原始报告**：在 96 份原始 JSON 哈希校验后重新分类，衍生分析存入 [atomic-readback-checks.json](atomic-readback-checks.json)。原 Chrome 156 报告计数为 24 通过/24 失败（包括无法配对的 4 个样本）；表中 28 个单样本正常不构成队列或配对验收通过。映射错误分类的改动发生于采样后，最终分类源码指纹与采样指纹分别保留。

两个版本都未通过集显验收。156 提供了 device lost 的明确证据，但不能据此认定 154 的旧值读回必然属于同一个根因，也没有得到可推广的浏览器升级方案。前两步实现和跨 GPU/版本对照已完成；G09 继续未完成，后续需要缩减复杂渲染链的触发条件，必要时跨后端/机器复核。

工程检查：FrameGraph 策略/映射生命周期最终 27 项、验收策略 212 项、工作区测试 1422 项通过；根 typecheck、全量 build、docs 检查及 `git diff --check` 通过。本轮新增 9 项测试。当前工作区包括其他任务的 i18n 改动，工作区测试数与示例数随之增加；全量构建为 97 个新鲜目标（`5f8e14629c3e`），本任务没有修改这些组件。映射失败分类补强后重跑 27 项专项，并对 96 份原始数据重放验证；Engine/构建输入未变。

独立 `atomic-readback-checks.json` 保存证据与工程日志哈希；原始数据与索引不覆盖旧失败报告。
