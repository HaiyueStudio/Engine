# 按视图选择灯光

日期：2026-09-06。架构和实验 API 变更见 [ADR 0099](../docs/for-ai/adr/0099-view-light-selection-before-clustering.md)。

## 结果

前八盏灯的遍历顺序截断改为视图级重要性选择。先过滤无效/无影响灯，再选择影响较大的光源；10% 保留权重与稳定 ID 排序减少临界切换和槽位重排。三层方向光阴影仍与所有视图的前几个光源槽对应。

PBR、Blinn-Phong、Toon 和 Instanced PBR 使用一致的列表。独立的动态 uniform 区域保证一次提交中多个视图的灯光数据不会相互覆盖；共用 packer，不改 WGSL 字段或灯光上限。静态记录和相同 IBL 内容跳过重复上传。

诊断分开记录候选、无效、视锥外、有效、入选、超额和替换数量。这里的有效表示影响球通过视锥测试，尚未统计逐物体或 cluster 的实际受光重叠；本次没有引入 clustered。

## GPU 证据

入口：`node scripts/verify-webgpu-view-light-selection.mjs`；产物：`artifacts/webgpu/view-light-selection-diagnostic.json`。产物附带 git revision/dirty、source fingerprint、设备、Chrome runner 和采样信息，属于有未提交改动工作区上的诊断结果。

128 盏点光，两个相距 100 单位、分别由红光和蓝光照明的视图。每视图 119 盏灯在视锥外，9 盏有效，选择 8 盏，报告 overflow 1。验证 PBR、Blinn、Toon、Instanced PBR、动态入选替换，以及三层方向光阴影占用容量、同一提交加入 35 个额外视图触发缓冲扩容时的结果。7 组、每组两个视图，与独立的单视图预期灯场景逐像素比较，最大误差均为 0；WebGPU validation error、销毁后的 owner residual 均为 0。

构建任务结束后，在扩容回归完成的同机静态场景预热 6 帧、采样 12 帧，2 个对象、128 盏点光、2 个视图；时序包括审计与诊断开销。GPU timestamp 仅统计 render pass，队列等待单列。这是当前实现的成本记录，没有匹配的旧实现计时对照，不能推导性能提升比例或 clustered 的收益。

| 指标 | 结果 |
| --- | ---: |
| 灯光 / IBL 稳定帧上传 | 0 / 0 |
| GPU draws / render passes | 6 / 4 |
| 全部 buffer 上传次数 / 字节 | 30 / 1512 |
| 稳定帧新 GPU buffer / bind group | 0 / 0 |
| 热池 miss / owner residual | 0 / 0 |
| CPU 录制 / 提交 ms，中位数 | 1.085 / 0.020 |
| GPU render-pass / queue wait ms，中位数 | 0.027 / 3.810 |

## 验证状态

全仓 typecheck 与 1246 项测试通过：Shader Language 112、Engine 616、animation-spec 139、extensions 372、示例目录 7。选灯/照明/资源/间接批次的聚焦测试 36 项通过。modules（446）、responsibilities、renderer-prepare、docs 和 diff whitespace 检查通过。已有 indirect bundle WebGPU 回归 10 组也通过，本轮只用其像素与结构结果确认兼容性，不引用那次与构建重叠的计时推导性能。

全仓核心 workspace 构建通过；示例限定 blinn-phong、toon-layers、pbr-showcase、shadow-map、gpu-driven-instancing、instancing 六个目标，加上两个共享目标，共 8 个 freshness 检查通过。没有构建全部示例。

API 检查仍因现有 workspace graph、audio/simulation/GUI/animation 等基线差异失败；本次实验参数和诊断字段的审核记录在 ADR 0099，没有更新无关基线。较早一次将仓库 typecheck 与 test 同时执行时，typecheck 内含的依赖构建造成临时模块导出读取失败；已将完整检查串行重跑并通过。

本次没有修改 clustered 准入预算或现存 API / shader 预算基线。新诊断不是正式产品场景的 lighting-scaling 准入证据。

最终 GPU source fingerprint：`sha256:4bac17dcf5be821154dc8aeba955338f169efdf7ee9788580347a1e98c0d2e89`。较早与构建重叠的灯光诊断保存为 `artifacts/webgpu/view-light-selection-build-overlap-diagnostic.json`，上表使用构建完成后的独立测量。
