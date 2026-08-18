# ADR 0056：Production Material Lighting 必须共享生成期 Family 与 ABI

## 状态

Accepted

## 决策

1. PBR、PBR Clearcoat、PBR Transmission、PBR Transmission + Clearcoat、Blinn-Phong 与 Toon 作为同一个 production material-lighting family 迁移，禁止 renderer 各自维护 Fog、light 或 BRDF 片段。
2. Fog、PBR BRDF、Clearcoat、Sheen 与 directional shadow 位于 compiler-owned standard library；六个 pass 必须记录相同 lighting module hash。
3. PBR clearcoat/transmission 是生成期 specialization。生产 artifact 不得保留容量或 feature 占位符，runtime 不得重新编译 DSL 或组合 WGSL。
4. 现有规模契约保持八盏灯；PBR 为三个方向光 shadow slots，Toon 为一个有效方向光阴影。本迁移不暗示 Forward+/Clustered 或 CSM 已实现。
5. PBR 复用 ADR 0055 的 morph → skin module 和 current deformation ABI。材质光照迁移不得复制第二套 morph/skinning 实现。
6. renderer 继续拥有 bind-group layout、GPU resource、透明排序与 pass lifecycle；Artifact V2 reflection 冻结绑定和 uniform byte layout。
7. 六个 pass 的 WGSL 编译、renderer-owned layout 创建以及代表性 lighting/Fog 像素必须进入独立 Chrome/WebGPU 门禁。

## 结果

- `PbrRenderer`、`BlinnPhongRenderer` 与 `ToonRenderer` 改为消费私有生成 artifact，旧八个 engine WGSL 源退休。
- Fog 标准库变为自包含模块，生成 family 与尚未迁移的受控 composer 共用同一来源。
- specialized rendering 和 compute 保持后续独立 family，不借阶段 11 扩大公开 API 或 API baseline。
