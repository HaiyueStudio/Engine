# Shader Graph v1

## 定位

Shader Graph JSON 是可信度较低的资产输入，只描述节点、连接、资源引用、输出和 metadata。它不是任意程序容器，不能携带 JavaScript、WGSL 或 GLSL 源码。

[graph-v1.schema.json](./graph-v1.schema.json) 是 v1 的机器 schema，[pilot-pbr-composition.graph.json](./pilot-pbr-composition.graph.json) 是阶段 0 fixture。阶段 3 已实现严格 parser 和该 fixture 所需的内建 node registry；支持范围与证据见 [stage3.md](./stage3.md)。

## 根结构

```json
{
  "format": "haiyue-shader-graph",
  "version": 1,
  "kind": "material",
  "profile": "webgpu-portable",
  "resources": [],
  "nodes": [],
  "outputs": {},
  "sceneFeatures": [],
  "metadata": {}
}
```

- `format` 与整数 `version` 必填。
- `kind` v1 接受 `material`、`postprocess`、`compute`；portable material 对控制流和副作用有额外限制。
- `profile` 是最低目标能力，不是运行时自动降级请求。
- `resources` 使用符号 id，不包含 URL、GPU handle 或 binding 数字。
- `nodes[].id` 在 graph 内稳定且唯一，用于 diff、diagnostic 和 editor selection。
- `nodes[].type` 是 namespaced type id，`typeVersion` 独立版本化。
- `inputs` 只能是 literal、node output、semantic 或 resource reference。
- `outputs` 把 graph root 的语义槽位绑定到相同的 value 表示。

上述 7 个必填字段和 `sceneFeatures`、`metadata` 两个可选字段是 v1 的完整 root field set。`surface`、`lightingModel`、`coverage`、`vertexDisplacement`、`passRequirements` 不是隐藏的可选字段：parser 会以准确 path 拒绝，并报告它们当前分别由 output map、compiler entrypoint、renderer material descriptor、deformation program、compiler reflection/RenderGraph 拥有。

对 `kind` 的语法接受不等于存在通用 lowering：

- `material` 当前只有 `compileMaterialGraphV1()` 的 metallic-roughness pilot lowering；
- `postprocess` 当前只有经过门禁的 motion-blur aggregate lowering；
- `compute` 保留 v1 语法类别，但没有通用 Graph compute lowering；阶段 13 的 production compute family 是独立的受信任 compiler input。

因此工具不能仅根据 schema 中的 `kind` 或 `profile` 宣称对应渲染能力已经交付，必须同时查询具体 compiler entrypoint/capability contract。

## Node 类型与端口

node registry 由受信任的 compiler/plugin 代码提供，graph 只引用 node type。registry entry 必须声明：

- stable type id 和 type version；
- 输入/输出端口名称、类型、stage、space；
- 默认值与是否必填；
- requires/provides/conflicts；
- 是否纯函数、是否可常量折叠；
- 支持的 graph kind/profile/backend；
- schema migrator（如果 node payload 发生变化）。

未知 type/version 必须产生包含 node id 的错误，不能替换成零值或跳过。

## 规范化

canonical graph 用于 diff 之外的 hash，规则为：

1. 忽略 `metadata` 中不影响编译的 label、位置和注释。
2. resource 按 stable id 排序。
3. node 按依赖拓扑排序，再以 type/id 作稳定 tie-break。
4. object key 排序；数字使用有限 JSON number，不接受 NaN/Infinity/-0 的歧义形式。
5. literal 显式记录类型和颜色空间/space（适用时）。
6. 未连接的纯 node 由 DCE 删除。
7. node id 不参与纯语义 hash；source map 单独保留 id 到 canonical node 的映射。

若两个 graph 仅 UI 坐标、label 或无用 node 不同，它们应具有相同 IR hash。

## 版本与迁移

- graph format、node type 和 compiler IR 分别版本化，不能共用一个模糊版本号。
- 外部输入先作为 `unknown` 通过 schema 和语义校验，再进入 IR。
- 阶段 0/1 尚未对外发布，仓库只承诺读取 graph v1；破坏式调整提升 version 并替换 fixture。
- migration pipeline 的接口必须是 `unknown vN -> validated vN+1` 的纯转换，逐级执行并保留精确 path diagnostic。
- 编辑器首次保存真实用户 graph 的支持窗口、备份和失败恢复由 ADR 0062 固定；不得默认沿用“永远只读最新版本”。
- 未知更高版本必须失败并保留原始资产，不能尝试 best-effort 打开后覆盖保存。

## 安全与所有权

- graph JSON 不执行代码，不动态 import URL，不解析函数文本。
- 资源 URL/Asset handle 属于场景或材质资产系统；graph 仅引用 stable resource slot。
- custom node package 是受信任插件能力，安装、版本锁和生命周期不藏在 graph 内。
- editor preview 编译采用可取消、latest-wins 的 Worker/job；失败不替换当前有效 pipeline。
- graph destroy 只释放 graph-owned compilation/cache reference，不直接销毁共享 texture 或 renderer resource。
