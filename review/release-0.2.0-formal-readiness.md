# 0.2.0 正式跨引擎比较、供应链与发布演练

2026-09-24：本轮三项验收完成。正式性能比较、生产供应链审计、完整 no-publish 演练及独立制品校验通过。没有创建 tag、push、npm publish、签名或部署。

冻结候选为 `3639ab0601306dc40601dc6ac9c0e3516f8a6ec8`，tree 为 `d34ac0db736f5d42e9b4fb146e3ebb9a447bb690`。比较与演练均记录 `dirty=false`，演练使用 `clean-head` 模式，从独立本地克隆执行真实 `npm ci`。原工作分支和暂存区保持不变；候选是本地 detached 快照，尚未发布。

证据目录：[`artifacts/release/0.2.0-formal-readiness/`](../artifacts/release/0.2.0-formal-readiness/)。完整性清单为 `SHA256SUMS`；`verification-summary.json` 汇总本轮结果。

## 正式跨引擎性能

同机 Intel i7-9750H / 16 GiB / macOS Darwin 25.6.0 / Chrome 153.0.8010.53 / Metal，Node 24.19.0。四个排名引擎均选择 AMD `rdna-1` 原生 WebGPU，没有软件 GPU 或 WebGL fallback。

场景保持 `pbr-grid-v1`：1280×720、DPR 1、256 个盒子、3072 三角形、8 个 PBR 材质、1 个方向光加 1 个环境光、无阴影、单采样。三轮轮换顺序 cohort，每轮 12 帧预热、40 帧正式样本；每引擎保留 120 个 `cpuSubmit` 和 120 个 `frameWall` 样本。表中数值为三轮分位数的中位数，`frameWall` 包含提交与等待队列完成，不是纯 GPU timestamp。

| 引擎 | 版本 | frameWall P50 | frameWall P95 |
| --- | --- | --- | --- |
| HaiYue | 0.2.0 | 1.595 ms | 2.055 ms |
| Babylon.js | 9.21.2 | 1.885 ms | 6.785 ms |
| Three.js | 0.185.1 | 2.015 ms | 5.950 ms |
| PlayCanvas | 2.21.4 | 2.905 ms | 8.105 ms |

现有策略通过，无违规。HaiYue 最慢 cohort P50 为 1.930 ms，竞品最快 cohort P50 为 1.875 ms，满足原有 5% 领先或持平容差；没有提高预算、减少样本或删除慢样本。该结果仅适用于上述固定场景，不代表任意项目、画质或硬件下的全面排名。

Galacean 1.6.13 为 WebGL2，使用 Intel UHD Graphics 630 / ANGLE Metal，仅保留为独立信息，不进入 AMD WebGPU 排名。五引擎浏览器错误数均为 0。

画面复核修正了两个比较适配问题：Babylon 显式使用右手坐标系，避免共享相机/对象坐标产生镜像；HaiYue 在 scene view 显式传入契约背景色，避免 scene 默认值覆盖 Engine 配置。未改变 Engine 实现、场景数量、采样配置或策略阈值。修正后重新冻结候选并完整重跑，策略测试 5/5 通过，五张截图均人工查看。各引擎原生 PBR、灯光响应和显示转换仍有可见差异，不声称逐像素或画质等价。

- [正式原始报告](../artifacts/release/0.2.0-formal-readiness/performance-comparison/formal.json)
- [画面复核及截图哈希](../artifacts/release/0.2.0-formal-readiness/performance-comparison/visual-review.json)
- [五引擎截图目录](../artifacts/release/0.2.0-formal-readiness/performance-comparison/parity-review/)

## 供应链

演练内生产审计覆盖 64 个组件：锁文件版本/integrity、许可证策略均通过，info/low/moderate/high/critical 漏洞全部为 0。2530 个 tracked source 文件凭据扫描无命中，最终制品凭据扫描也无命中。已生成生产依赖和最终制品的 CycloneDX SBOM，以及 in-toto/SLSA provenance；这些是本地演练记录，没有进行外部签名或发布认证。

初次预检使用本机默认 npm 镜像，安全审计接口返回 404/NOT_IMPLEMENTED，按 fail-closed 记录失败。正式审计与两轮演练通过进程环境使用 `https://registry.npmjs.org`，没有更改用户全局 npm 配置。

补充全依赖审计仍有 3 个 high 条目，来自同一开发工具链 `@loaders.gl/textures → texture-compressor → image-size`，不是 3 个生产漏洞。该隔离已在 [2026-08-15 评审](m02-windows-reconstruction-audit-2026-08-15.md) 中记录。当前官方审计返回 `fixAvailable=false`；[ICNS 公告](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) 与 [JXL/HEIF 公告](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) 均列为未修复。没有执行强制升级或删减审计来隐藏告警。

重新检查五个归档的文件路径和静态/动态模块导入，未发现这三个包的实现或导入。仓库中的相关实际使用是 GPU glTF 测试加载 Basis encoder JS/WASM，不执行 texture-compressor CLI。该检查界定当前发布暴露范围，不等同于证明开发环境没有风险；开发工具链告警仍保留待上游修复。

- [生产审计与凭据报告](../artifacts/release/0.2.0-formal-readiness/rehearsal/supply-chain/report.json)
- [全依赖原始审计](../artifacts/release/0.2.0-formal-readiness/logs/npm-audit-all.json)
- [最终归档中的开发依赖暴露检查](../artifacts/release/0.2.0-formal-readiness/development-dependency-exposure.json)

## 无发布演练

使用标准 `npm run release:rehearsal` 外层入口，未使用跳步或 candidate-snapshot 模式。依次完成供应链审计、四库/真实 GPU 灯光诊断 bootstrap、完整 Engine fast 门禁、四包 release 模式验证、Engine 入口预算及 full 示例构建。

- 四库测试 1278 项、示例测试 7 项通过；发布策略 65 项通过，类型、结构、能力、文档/API、Shader 与发布范围检查通过。
- 四个 npm tarball 的两次打包 SHA-256 一致；真实独立安装、28 个浏览器消费端、Node、TypeScript、全部公开导出和 CLI 检查通过。
- 完整 55 个示例（46 smoke / 9 full）及 shared Engine、source viewer 共 57 个目标全部新鲜，源码指纹 `fc136d3ae4cc6ae638e6639d9fed855781877c6dab3d17a9b5c554e5b12b959c`。manual 集合按原 manifest 策略不自动执行或归档。
- 演练基线树前后 SHA-256 均为 `40ae0f86ef51881cfe988492b8fbd96198f20fea1f1ef027fc134c735bde42d6`。
- 第二轮完整演练一次执行通过，worker 结束后外层独立 validator 通过；复制完成后又在候选规范路径独立校验通过。归档副本 15 个文件与该 bundle 全部逐字节一致。

| 产物 | 字节数 |
| --- | ---: |
| @haiyue/engine 0.2.0 | 1,875,380 |
| @haiyue/animation-spec 0.2.0 | 130,279 |
| @haiyue/extensions 0.2.0 | 513,427 |
| @haiyue/shader-language 0.2.0 | 143,415 |
| examples 静态目录 tar | 90,369,024 |

包哈希、原始消费端报告、SBOM、provenance、release notes、未执行的 release plan 和 rollback checklist 均随 [演练 bundle](../artifacts/release/0.2.0-formal-readiness/rehearsal/) 保存。验收工具要求 bundle 保持报告中的规范相对路径 `artifacts/release/rehearsal`；归档副本未经重写，移回相同候选的规范路径后即可重跑校验。

### 保留的失败与重跑

第一轮完整演练在第 24 个示例 `ktx2-volume` 触发原 60 秒超时，停止且保留完整日志。紧接着观察到同机另一个 `games/test/**/*.test.mjs` 任务同时运行约九个高 CPU Node 进程，合计占用多个核心；没有终止或修改该任务。负载恢复后，同一干净 revision、相同命令与所有原阈值完整重跑，Volume 用时 16.2 秒，55 项全部通过。这个结果支持系统资源争用导致首轮超时的判断；不将首轮失败记作通过。

另保留：镜像审计不可用、修正前比较、临时工作树索引初始化失败和错误跨目录调用 validator 的记录。后两项分别通过初始化临时索引、在候选规范路径校验解决，没有修改源码、制品或验证规则。

## 发布边界

后续全局验收见 [0.2.0 冻结候选全局验收](release-0.2.0-global-check.md)：同一冻结 revision 于 2026-09-24 UTC 05:16:15–06:32:08 完整跑通 `release:check`，正式灯光、full slow、1800 帧 readback、包消费端与正式比较均在一个全局进程中完成。执行前后干净且基线不变，此前全局构建超时阻塞已关闭。

本报告保留此前供应链与无发布演练的原始结果。最新比较数值和完整正确性证据见上述全局验收报告，不覆盖本轮历史样本。尚未执行正式 tag、push、publish、签名或部署。

最新 full CPU 基准有 4 项 report-only 绝对 P95 诊断告警，相对比较为 baseline-missing；Mac 固定设备耗时预算仍未登记。正式跨引擎比较通过不代表所有固定设备诊断阈值通过。开发工具链的 3 个 high 审计条目继续保留，生产审计结论与暴露范围见本报告供应链部分。
