# Lighting and shadow scaling

灯光与阴影规模化是条件式性能项目，不是当前稳定功能承诺。当前实现为 PBR/Blinn-Phong 每个 scene render snapshot 最多 8 盏灯；PBR 可为前 3 盏有效投影方向光生成独立 shadow map，Toon 等兼容路径仍只消费第一张。第 4 盏及之后的投影方向光继续参与照明，但不生成阴影。实现边界见 [ADR 0049](./adr/0049-fixed-capacity-multi-directional-shadows.md)。

## 启动条件

开始实现原型前，必须先登记一个真实游戏内容需求，并同时满足：

1. 场景在可复现的相机轨迹中确实出现超过 8 盏会影响同一视区的灯，或单张方向光阴影无法同时满足近景质量与远景覆盖。
2. 该需求至少覆盖一个 required device class 和一个性能较弱的 required/extended device class。
3. A/B 场景、采样区间、设备、浏览器版本、分辨率、目标帧率和阈值在运行原型前写入版本化 baseline，不能根据结果回改门槛。

只提高灯光数组长度、只测灯光收集函数，或只展示静态技术 demo，都不满足启动条件。

## 真实游戏矩阵

首轮使用同一份可游玩场景和固定 camera replay，保留物理、动画、材质、阴影与后处理负载：

| 维度 | 必测档位 | 目的 |
| --- | --- | --- |
| 局部灯数量 | 1 / 8 / 32 / 128 | 找到 forward 上限和 culling 收益拐点 |
| 屏幕重叠密度 | 低 / 中 / 高 | 区分总灯数与每 tile/cluster 实际工作量 |
| 动态灯比例 | 0% / 25% / 100% | 测试 light list 更新、上传和 cache 失效 |
| camera/viewport | 1 / 2 / 4 | 验证 per-view 隔离、共享收益和显存增量 |
| 方向光阴影 | off / 1 / 2 / 3 张 / 2 / 4 cascades 原型 | 分离固定多光阴影、shadow pass 与 CSM 成本 |
| 分辨率 | 1280×720 / 1920×1080 | 识别 screen-space culling 与 shadow fill 成本 |

基准至少包含一个现有 3D game 的增强场景；`billiards-3d` 当前 manifest 指向的 mega-batch benchmark 只能证明批处理控制路径，不能作为灯光规模化证据。室外 CSM 评估应另选有长视距、连续移动相机和足够几何密度的 game fixture。

### 固定 fixture v1

`scripts/benchmark/lighting-scaling-fixture.mjs` 固定了
`billiards-3d-lighting-camera-v1` camera replay，并生成完整的 216 个局部灯矩阵：

- 1 / 8 / 32 / 128 盏局部灯；
- low / medium / high 屏幕重叠；
- 0% / 25% / 100% 动态局部灯；
- 1 / 2 / 4 个独立 camera/view target；
- 1280×720 / 1920×1080。

Replay 为 60fps、240 帧的闭环轨迹。所有档位共享相同 keyframe，额外 view 只应用固定的小角度偏移；每个 view 都保留所选的完整 720p 或 1080p 工作量，不用缩小分屏抵消多 view 成本。灯位、颜色、range、动态灯选择和运动相位均由 fixture 版本决定，不使用运行时随机数。25% 档按稳定的每四盏选择一盏；1 灯档因离散化实际为一盏动态灯，结构化结果同时输出请求比例和实际比例。

真实 WebGPU 入口为 `scripts/webgpu-gate/lighting-scaling-fixture.html`，一次进程只运行一个矩阵 case，避免选择最佳运行或把 216 个 case 混入现有正式预算。例如：

`?lights=32&overlap=high&dynamic=0.25&views=4&resolution=1080p`

当前 fixture 不改变 renderer ABI、灯光 uniform 或 shader 上限。真实 billiards 内容自带 1 盏环境光和 1 盏投影方向光；在总计 8 个 Forward 灯槽中，局部 PointLight 的实际容量为 6。schema v2 分别记录 ambient、directional、local 和 total 的 authored/submitted/overflow 计数，同时输出 `rendererTotalLightCapacity=8` 与 `rendererLocalLightCapacity=6`，禁止用 submitted 数量反推容量。8/32/128 局部灯档都会明确报告 `known-forward-light-cap`，不能把截断后的耗时当作规模化路径已经正确渲染的证据。代表性 case 的已验证结果写入 `artifacts/webgpu/lighting-scaling.json`；该 artifact 是正式功能证据，但不设置时序性能 baseline。

## 必须采集的指标

- end-to-end frame CPU/GPU P50、P95、P99 与 1% low；
- scene environment、light culling/list build、light upload、opaque shading、shadow pass 的分阶段耗时；
- 总灯数、可见灯数、每 tile/cluster 灯数分布与 overflow 数；
- light-list/cluster/shadow buffer 上传字节、峰值显存、重分配次数；
- draw/dispatch/pass 数、pipeline cache hit/miss，以及 warmup 后同步 pipeline create 次数；
- 按 camera + viewport + layer mask 隔离的 cluster/light list，以及每个 view 的 atlas 占用和实际共享字节；
- WebGPU validation error、device recovery 后资源残留、camera/viewport churn 后 owner residual。

耗时先 report-only；overflow、错误引用其他 camera 的 view 数据、validation error 和最终资源残留从第一次实验起必须为 0。

## Go / no-go

只有同时满足以下条件，候选路径才能从实验进入产品实现：

1. 在发生真实灯光上限的游戏档位上，正确渲染所需灯光没有 overflow 或静默截断。
2. 相比能够产生相同画面的基线，固定 runner 的 GPU P95 有稳定且可解释的收益；CPU P95、upload 和 allocation 没有把成本转移到另一阶段。
3. 1/8 灯的小场景没有显著退化，32/128 灯的收益在至少两个 device class 上方向一致。
4. 多 camera/viewport 的成本随 view 数可解释增长，共享资源不会导致跨 camera 污染或生命周期耦合。
5. 像素、灯光列表一致性、阴影稳定性、resize、camera churn 与 device recovery 门禁全部通过。

若 CPU tiled/clustered 已满足目标，就不因为 GPU clustered 技术上更先进而继续扩大实现。若真实产品始终不超过当前能力，则维持现状并关闭该阶段。

### 可执行决策门禁

`npm run lighting:architecture:check` 使用
`config/lighting-architecture-policy.json` 分别评估 Forward+/Clustered 与 CSM。
当前 128-light billiards fixture 只证明固定 8-light cap 会发生截断；这些局部灯是 benchmark
增强负载，并不证明某个产品画面必须同时保留超过 8 盏灯，因此当前 Forward+ 决策仍为
`hold`。登记真实内容需求、同画面 baseline、固定 replay、至少两个 device class，并证明
内容确实要求超过当前容量后，状态才能改成 `prototype-approved`。这只授权原型。原型完成
后还必须提供无 overflow 的候选结果、可解释的 GPU P95 收益和小场景无明显回退，才能将
状态进一步改成 `product-approved`；两层证据不能互相替代。

CSM 使用独立的 `haiyue-csm-product-decision@1` 证据。它必须来自长视距室外内容，并证明
单 shadow map 在近景质量或远景覆盖上不能满足需求；灯光数量超过 8、Forward+ 获批或局部
灯 benchmark 都不能解锁 CSM。两项决策的证据路径与当前状态均由上述 policy 文件登记，
防止用技术 demo 代替产品需求。

## 候选实现顺序

1. 先建立可回放 game fixture、逐 pass GPU timestamp 和 light-overlap 诊断。
2. 把 World/frame master light data 与 camera/view light list 分开，但不改变 stable API。
3. 用同一输入比较 CPU tiled/clustered 与 GPU clustered light list。
4. 选定 lighting path 后再评估 shadow atlas；CSM 作为独立实验，不能捆绑进 lighting 原型。
5. 最后接入异步 warmup、编辑器可视化、capability fallback、像素与 recovery 门禁。
