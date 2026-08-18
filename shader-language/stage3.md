# 阶段 3：Graph v1、MaterialSurface 与 PBR Pilot 1

阶段 3 将不可信 Shader Graph v1 JSON 降为阶段 2 Typed IR，再通过稳定 `MaterialSurface` 槽位进入 metallic-roughness PBR 和 lighting 后的 scene Fog。Graph 不包含 WGSL、binding 数字、GPU handle 或可执行脚本。

## 已实现

- Graph v1 根结构、资源、节点、value union、版本和额外属性验证；输入始终先作为 `unknown`/JSON text 解析。
- 内建节点 registry v1：UV noise、2D texture sample、tangent normal decode、world-height gradient 和 linear color multiply。
- 未知 node/version、缺失或多余 port、无效 reference、cycle、surface 类型错误均为独立 classified diagnostic，并保留 node/port path。
- Graph 资源自动转为 Composer 符号资源；四个 material 标量合并为一个 16-byte uniform block，reflection 可直接驱动 `packShaderUniformBlock()`。
- `MaterialSurface` v1 定义 14 个槽位、默认值与范围策略；metallic-roughness Graph lowering v1 消费其中 7 个基础槽位，其余高级槽位以 `E_SHADER_SURFACE_UNSUPPORTED` 精确失败。
- metallic-roughness PBR、tangent-space normal/TBN、线性 Fog；Fog 固定在 lighting 后，normal/noise/gradient/Fog 不成为 specialization 维度。
- 从可达 graph 自动收集 `TEXCOORD_0`、world position/normal、world tangent 和 tangent sign，并写入 vertex semantic/varying reflection。
- backend 只内联单消费者且不跨 source boundary 的纯表达式；共享纹理采样、跨 node diagnostic boundary 与多消费者值仍保留命名临时值。

阶段 3 输出 fragment program 和完整 varying contract，但不猜测引擎 vertex layout，也不生成生产 vertex program。自动 vertex/varying codegen 属于下一阶段；当前 WebGPU pilot 使用固定、独立的参考 vertex fixture。

## Pilot 1 证据

运行：

```bash
npm run verify:shader-language-stage3
```

浏览器会通过 HTTP 读取规范 graph，分别编译生成 WGSL 与独立手写 PBR/Fog shader，以相同纹理、sampler 和 reflection-packed uniform 绘制 32×32 帧并逐通道比较。

当前固定证据：

- 中心像素 `rgba8 = 26,27,39,230`，容差 2；
- 全帧生成/参考最大与平均通道差分别要求 `≤2`、`≤0.25`；当前均为 0；
- 生成 WGSL gzip 1538 B，手写参考 1446 B，比例 1.064x，低于 1.15x 上限；
- WebGPU compilation/validation error 和 unclassified failure 均为 0；
- 当前没有可达 specialization axis，实际 specialization variant 为 1；clearcoat/transmission 只是保留轴，specialization 预算上限为 4。实际 pilot-family variant 同样为 1，8 是预算而不是已生成数量；
- material uniform block 为 16 B，geometry varying contract 为 5 项。

Graph compile/pipeline 时间会作为观察值输出，但当前不设本机 timing baseline。阶段 3 没有修改 engine、renderer 或预生成生产 shader，因此既有生产 first-frame 路径结构性回归为 0；不能将这一结论外推为未来 runtime adapter 的性能证据。

## 明确延期

- 自动 vertex program/varying allocation 与真实 renderer vertex ABI 接入；
- custom node plugin registry、Graph migration/save contract 和编辑器 Shader Graph UI；
- morph/skinning/displacement 多 pass 派生（Pilot 2）；
- postprocess graph（Pilot 3）；
- GLSL ES 300 backend、WebGL2 fallback、生产 PBR 迁移和稳定公共 API。
- clearcoat、transmission、thickness 和 sheen 的通用 Material Graph lowering 与对应多 pass requirement。

权威机器范围见 [stage3-contract.json](./stage3-contract.json)。
