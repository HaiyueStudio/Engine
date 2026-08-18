# ADR 0013：分层资产管线与受信任脚本 capability

- 状态：Accepted
- 日期：2026-07-13
- 范围：engine、components、editor、examples/games、CI

## 背景

阶段八之前，glTF、Draco、KTX2 与 Spine 已能加载，但 worker 与主线程存在不同程度的重复解析实现，取消、超时和迟到结果控制分散在各系统。脚本在页面主线程用动态函数执行，API 扁平、默认能力过宽，资源脚本替换后也没有统一清理监听和定时器。

## 决策

1. 每种复杂资产只有一个生产解析实现。glTF/Draco worker 导入 `loadParsedGltfAsset` 与 `prepareGltfGeometryPayloads`，KTX2 worker 导入 `prepareKtx2TexturePayload`，Spine worker 导入 `parseSpineAssetPayload`；main fallback 调用同一函数。
2. 默认采用 worker-first。只有 worker 协议、启动或传输等基础设施错误可以回退主线程；资产内容错误直接保留原 `EngineError.code/path`，禁止通过 fallback 掩盖坏数据。
3. `AssetJob` 是异步资产工作的统一控制面，负责状态、优先级、进度、超时、取消和迟到结果失效。共享资产的引用计数仍由 `AssetManager` 负责，单个 owner 取消不能终止仍被其他 owner 使用的去重任务。
4. 缓存固定分为网络响应、解析后的 CPU 数据和按 `GPUDevice` 隔离的 GPU 数据。每层都有字节/条目预算、引用保护与 LRU；device lost 只清除旧设备 GPU 层，网络和 CPU 层可用于重建。
5. 大资源 GPU 提交进入 `AssetUploadScheduler`。系统按帧显式 drain，优先级只决定队列顺序，不能绕过帧字节预算；超预算原子任务会失败，KTX2 按 mip/layer/block-row 拆分。
6. 项目脚本被定义为“受信任项目代码”。`trusted-project` 在页面 JavaScript realm 中执行；capability 是可维护的 API 边界，不是恶意代码安全隔离。
7. capability 固定分成 `read`、`scene`、`asset`、`input`、`physics`、`debug`。默认只启用 read/input/debug；编辑器、player 和导出 runtime 必须逐项声明能力。
8. `SCRIPT_RUNTIME_CONTRACT` 同时驱动运行时过滤、编辑器提示和导出的 `.d.ts`。声明生成时传入启用的 capability 集合，可用字段为必选、未启用字段不声明。修改脚本 API 时必须原子更新 contract，不建立第二份声明手稿。
9. 脚本异常转换为 `E_COMPONENT_SCRIPT_FAILED`，包含 script resource、entity、component、lifecycle 和源码位置。默认只禁用故障组件，不终止帧循环；也可选择 pause 或 continue。
10. `ScriptExecutionScope` 拥有脚本通过 debug capability 注册的监听、timer 与 disposer。资源或内联代码变化、组件移除、world 移除和销毁都会先 dispose 旧 scope 再编译新代码。
11. glTF 外部 buffer 与 primitive geometry preparation 按原索引并发执行；结果矩阵必须保持 glTF 索引顺序。geometry preparation 与纹理预载同时启动，模型构造前等待两条分支收敛，以便统一清理已取得的 handle。
12. 传入场景 `AssetManager` 时，glTF 解析结果按规范化资源 URL 共享；纹理按稳定的 image identity 共享。嵌入 bufferView 产生的临时 blob URL 不能成为 GPU cache identity。
13. glTF GPU 纹理去重以 image 而非 texture/sampler 为单位；sampler 仍是材质槽状态。同一普通图片的 sRGB 与 linear 用途必须分开，KTX2/Basis 则使用源纹理格式。模型持有解析和纹理 handle，并在 `disposeGltfModel()` 统一释放。

## 不受信任代码

本 ADR 不授权运行不受信任代码。如果产品以后需要第三方脚本或联网内容执行，必须另立 ADR，在 Worker、sandboxed iframe 或独立进程中建立可验证的内存、DOM、网络和 GPU 隔离；不得把 capability object 或 `new Function` 描述为安全沙箱。

## 验证

- `npm run asset-script:check`
- engine 的 AssetJob/cache/upload/script isolation/hot reload 测试
- components 的 glTF/Draco/KTX2/Spine main-worker contract test
- components 的 glTF buffer 并发、并发解析去重、image/sampler/color-space 纹理去重测试
- `npm run benchmark` 的 parse/upload/animation sampling P95 预算
- `npm run check:fast`
