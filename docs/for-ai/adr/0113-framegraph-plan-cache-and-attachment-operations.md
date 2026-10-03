# ADR 0113：结构计划缓存与安全附件操作

- 状态：Accepted
- 日期：2026-10-02
- 关联：[ADR 0111](0111-framegraph-dependency-culling.md)、[ADR 0112](0112-transient-texture-lifetime-reuse.md)

## 决策

在私有帧计划、后处理依赖图和临时纹理分配器中使用各自有界的结构缓存。每个缓存最多 16 项，按最近使用淘汰，owner 重置/销毁时清空；帧计划与后处理 owner 更换设备时清空。缓存命中不跳过当前帧的 GPU 准备、相机/灯光上传、历史推进、提交回调或物理资源解析。

| 缓存 | key / 失效依据 | 仅保存的数据 |
| --- | --- | --- |
| 帧拓扑 | pass class、完整节点名称/类型、reads/writes/after、副作用、imports/exports，以及当前 view/family 的目标身份、尺寸、显示尺寸、格式、MSAA、深度方向、load、viewport/scissor 与后处理开关；Deferred 另包含实际 Tiled/回退分支、扩展材质/透明分支、输出格式和最新 G-buffer 观察者 | 当前声明的节点索引、排序、依赖名称、资源区间和计数 |
| 后处理 | 每个效果的名称、实际颜色依赖、副作用、depth/normal/motion/outline 需求；执行 owner 的尺寸/格式/附件配置 | 节点索引和结构诊断；每次重新绑定当前效果实例 |
| 分配方案 | 是否复用、每项逻辑名称、完整纹理描述符/兼容条件和包含端点的使用区间 | 按生命周期排好序的请求索引及可共用的逻辑槽位 |

拓扑 key 使用完整序列化值，不依赖有碰撞风险的短 hash。无效图在 miss 时完整验证，失败不会插入缓存。命中必须声明完全相同的结构，外部观察者的增删由 imports/exports 显式体现。材质数值、相机矩阵、灯光内容和时间等仅改变执行数据时，无须失效；引起图分支或效果需求变化时必须失效。粗粒度 coordinator 图不包含材质或 profile 的内部选择，实际 Deferred 子图独立处理这些分支。

缓存不保存执行闭包、view/context、纹理、bind group 或命令编码器。每帧调用当前声明的动作。分配方案命中仍重新检查当前 held/pending/submitted 状态与预算：不同未提交 encoder 不可借用同一纹理，绝不缓存上一帧的物理 ID。稳定配置有界；稀疏变化只替换一个 LRU 条目。

同一个 FramePlan 执行期间拒绝 clear/add/import/export/execute/改变缓存作用域，异常后释放执行锁；嵌套录制需独立 plan。不同 owner 不共享可变缓存。私有统计提供 hits、misses、evictions、invalidations、size 和最近原因；私有开关只供消融，不扩大公共 API。

## 附件操作的证明边界

- 已证明只用于一次辅助表面深度测试的临时深度附件保持 clear/discard；不将“局部 viewport 写入”推断为完整覆盖。
- visible outline 的所有 pipeline 都禁止深度写入，且使用已存在的场景深度，因此使用 depthReadOnly。按照 WebGPU 描述符合同省略 depthLoadOp/depthStoreOp，场景深度内容仍保留供后续系统使用。
- 任何后续采样、透明/扩展材质阶段、外部目标/叠加系统、诊断读回或历史需要的内容继续 store。clear 本身是一次写入，不允许将需要 clear 的附件标成只读。
- G-buffer 必须供 resolve、扩展材质和最新诊断读取；AO raw/denoised、visibility 和 Gaussian horizontal 必须供下游采样或 copy，均保留 store。
- MSAA 的现有 resolve/preserveMsaa 语义和透射 copy 保留；没有证明可以省略的 resolve/copy。相邻 Deferred 阶段存在附件采样、深度与透明顺序约束，本阶段无额外安全合并候选。

不把原来已有的辅助深度 discard 或 MSAA discard 计为本阶段新增收益。只读声明及缓存命中数是结构证据，不能直接换算为 GPU 带宽、CPU P95 或帧率收益。

## 验证

覆盖缓存开关等价、当前回调/实例重绑、坏图拒绝、观察者变化、设备/尺寸/DPR/格式/MSAA/视口切换、300 个作用域的容量上限、LRU、执行重入、pending encoder 隔离与销毁。原生对照检查同画质、相机动态更新、实际工作数、物理分配、只读深度选择和零残留。完整性能资格继续归 G09/G05 最终候选验收。
