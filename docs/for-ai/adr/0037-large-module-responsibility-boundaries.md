# ADR 0037：大型模块按运行时职责边界拆分

- 状态：Accepted
- 日期：2026-07-22

## 背景

Render3DSystem、glTF loader、ResourcePool、player 与 runtime export 在持续扩展后，同时承担了协议声明、状态缓存、资源解析、运行时更新和宿主编排。继续在单文件内增加能力会形成反向 facade 依赖，使动画、渲染和导出链路难以独立验证。

## 决策

1. 原入口只保留兼容导出和工作流编排，不再拥有已拆出的实现职责。
2. Render3DSystem 负责帧与 pass 编排；公共 DTO、renderer 注册策略、存活缓存和方向光阴影缓存分别由独立模块拥有。
3. glTF loader 负责容器加载与节点实例化；公开 contract、accessor、Draco、材质/纹理和动画运行时分别独立。morph/skinning 的逐帧更新不属于一次性加载流程。
4. ResourcePool 负责资源所有权与引用协调；变更日志、身份索引、prefab variant 纯操作和引用集合路由分别独立。
5. player 负责应用生命周期；runtime inspector 与断点暂停状态机独立。
6. runtime export 分为 schema/校验、scene 变换、依赖驱动源码生成、稳定子路径导入规划和项目文件打包；模板正文按生成目标拆分。
7. 内部协作者直接依赖 contract/职责模块，不反向依赖原 facade。公共入口保持原有 API surface。

## 边界

- 不以行数、类数或“一函数一文件”作为拆分标准；新模块必须拥有可命名的状态、策略或数据生命周期。
- 不在职责模块中重新构造宿主工作流，也不从职责模块导入原入口。
- 原入口可以聚合导出稳定类型，但内部模块不得借此形成循环依赖。
- 新职责必须加入 responsibility boundary gate，防止声明或实现回流。

## 验证

- 全仓 TypeScript、workspace/module boundary、editor architecture 和 responsibility boundary 门禁。
- engine、components、editor 单元测试，重点覆盖 Render3D、glTF 动画/材质、ResourcePool 和 runtime export。
- 全仓生产构建；公共 API surface 由独立 release 门禁继续管理。
