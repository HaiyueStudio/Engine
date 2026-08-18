# HYA 真实 Lottie 语料与仪表盘

这个目录把 HYA 的格式收益和视觉损失变成可重复采集的证据，而不是依赖单个演示动画或主观观察。

## 语料来源

`manifest.json` 同时固定三个完整 Git revision：

- `LottieFiles/test-files` 的 CC0-1.0 小型 conformance 素材及 After Effects 参考 PNG；
- `airbnb/lottie-web` 的 MIT 大型真实素材，覆盖营销动画、UI motion、嵌套 precomp、图片、文本、复杂曲线、time-remap 和 effect；
- `google/fonts` 的 OFL-1.1 字体许可证来源；实际 WOFF2 固定 gstatic 版本 URL、SHA-256、字节、family/style/weight 和真实 font metrics。无法确认再分发授权的 Arial/Futura PT 不会被替代字体伪装成 full。

大型素材的参考帧由固定的 `lottie-web@5.13.0` Canvas renderer 生成；renderer URL 和 SHA-256 也写入清单。每个 Lottie JSON、外部图片和参考 PNG 都保存 SHA-256 与字节数，任一文件缺失或哈希不匹配都会失败。

首版语料刻意同时包含：

- `supported`：当前产品目标内应完整支持的能力；
- `degraded`：允许产生明确 diagnostics 的能力降级；
- `unsupported`：已知缺口，用来防止仪表盘只展示绿色样本。

`expectation` 是产品分类，不会改写实际测量结果。真实结果始终由转换 diagnostics、参考帧和运行时测量决定。

采集器还会独立扫描源 JSON 的 layer、shape、style、transform、composite、timing 与 animation 特性。每条 converter diagnostic 依据 code 和最长 JSON path 匹配归入唯一 feature；报告同时保存素材级主失败、全部失败路径和跨素材汇总。`unclassifiedFailureCount` 必须保持为 0。汇总中的 observed fidelity loss 是同一批素材上的相关性，只用于排优先级，不代表因果归因。

`sizeClass` 把现有 17 个素材固定为 `small`，新增的大型素材固定为 `large`。报告和仪表盘分别汇总两组；small 继续承担既有 release 门禁，large 展示真实网络和解析成本，禁止用大量小文件的平均值稀释大型素材。

## 五类指标

| 指标 | 定义 |
| --- | --- |
| fidelity | 在显式透明 clear color 的同一浏览器帧内把 WebGPU swapchain texture 复制到 readback buffer，与固定 AE / lottie-web PNG 逐像素比较。单帧分数为 `0.75 × RGBA MAE similarity + 0.25 × alpha IoU`，同时保留 RMSE 与近似相同像素率。 |
| size | 源 Lottie JSON 与生成 HYA binary 的 raw bytes、gzip-9 bytes 及比率。 |
| HTTP delivery | 浏览器通过真实同源 HTTP、`cache: no-store` 和 `Response.body` 流式读取源 Lottie、HYA 及每个固定的图片、data、WOFF2 外部资源，分别记录 request-to-headers、body download、bytes、chunk count、Content-Length 和 Content-Encoding。 |
| parse | Node 中预热后重复执行 source-to-runtime；small 保留批量摊销，large 使用独立的大文件采样参数，避免一次观测重复解析数百 MB。Lottie 包含 JSON parse + conversion；HYA 包含 binary validation + typed-view construction，记录 median/p95/min/max。既有 small 语料额外执行 5 个独立轮次并保存最低 median speedup；任一轮低于 1.25x 都拒绝覆盖正式证据。 |
| first-frame | WebGPU adapter/device 已初始化并用一个不计入结果的样本预热共享 Animation2D pipeline 后，从每个素材的无缓存 HYA HTTP 请求开始，到素材专属运行时、外部图片、FontFace load、文字 atlas 重建、geometry/upload、提交和 GPU queue 全部完成；保存 HTTP/parse/runtime+GPU 分段。 |

首帧指标有意排除 adapter/device 获取，以减少 CI 机器与浏览器启动噪声；它仍包含资源请求、HYA 解析和首次 pipeline 成本。动画运行时只为当前有效时间窗内的节点创建视觉，未来节点在首次入场时再 tessellate/上传，避免大型素材把整条时间线的几何成本压到首帧。不同机器的绝对耗时不能直接横向比较，趋势比较应固定浏览器、GPU 和运行环境。

正式更新按 `small`、`large` cohort 分别比较最低 fidelity 和 first-frame P95；任一 cohort 相对自身正式基线回退超过 10% 都会拒绝覆盖报告，不能再用全体汇总掩盖单组回退。

## 运行

```sh
# 首次拉取或校验固定素材（缓存不会提交）
npm run hya:corpus:sync

# 构建所需包、转换全部素材、运行无头 Chrome WebGPU 并更新报告
npm run hya:dashboard

# 已有缓存时禁止网络，确保可复现
npm run hya:dashboard:offline

# 完整采集 fidelity/first-frame，但只写入忽略的 candidate-report，
# 不覆盖正式 latest.json 或仪表盘报告
node scripts/hya-corpus/run.mjs --offline --candidate

# 查看 candidate，不覆盖 examples/hya-corpus-dashboard/report.json
# 在项目静态服务器下打开：
# /examples/hya-corpus-dashboard/?report=/animation-spec/corpus/.cache/candidate-report.json

# 只采集 size/parse/conversion，写入忽略的 .cache/node-report.json，
# 不覆盖已提交的浏览器 fidelity/first-frame 基线
npm run hya:dashboard:node
```

产物位置：

- `.cache/assets/`：通过 SHA-256 验证的上游素材，不提交；
- `.cache/generated/`：本次转换生成的 `.hya`，不提交；
- `.cache/candidate-report.json`：完整浏览器候选证据，不提交，也不覆盖正式基线；
- `results/latest.json`：完整机器可读基线，提交；
- `../../examples/hya-corpus-dashboard/report.json`：浏览器仪表盘使用的同一份报告，提交。

仪表盘源码位于 `examples/hya-corpus-dashboard`。报告 schema v3 增加多来源 provenance、small/large cohort 和浏览器 HTTP streaming 阶段；schema v2 正式历史报告仍可读取。点击特性行会筛出关联素材，素材详情保留 diagnostic code、影响级别、精确 JSON path 和网络阶段。正式证据只在统一集成时更新；`--candidate` 永远不会覆盖 `latest.json`。

Dashboard 还会读取独立的 `examples/hya-corpus-dashboard/capabilities.json`：它只根据当前转换器在固定语料上的 diagnostics 生成能力支持矩阵，不携带或覆盖正式 fidelity/performance evidence。每个未完整支持的 feature 必须声明责任层、优先级和可执行完善路径；`layers/precomp` 的内部 merge-path/path 失败不能再反向污染 precomp 容器能力。

```sh
npm run hya:capabilities
npm run hya:capabilities:offline
```

完整 `hya:dashboard` 和 node-only runner 也会自动刷新该能力快照。能力变绿不代表交付成本自动达标：大型 path/morph 支持必须同时检查逐素材 HYA gzip、parse 和 first-frame，不能通过保留更多 Float32 数据换取表面上的 feature coverage。
