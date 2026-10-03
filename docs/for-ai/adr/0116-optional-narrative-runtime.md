# ADR 0116：可选剧情运行时与游戏状态机接口

- 状态：Accepted
- 日期：2026-10-03
- 入口：`@haiyue/extensions/narrative`

## 决策

剧情归属 extensions 的独立可选能力，不加入 Engine 根入口。剧情图执行不依赖 DOM、GUI、
计时器或某一动画状态机。`NarrativeGui` 通过公开 Engine GUI 接口展示，复用 i18n 与资源租约。
动画状态机仍负责动画；游戏状态机通过具名 action 请求/结果连接剧情流程。

JSON schemaVersion 1 定义 dialogue、choice、branch、effect、action、end 六类节点。
条件使用有限声明式运算，变量仅允许 string/finite number/boolean；禁止 eval/脚本表达式。
文本、角色与图片引用 i18n key。宿主显式注册动作 allowlist，不从剧情文本导入可执行模块。

## 执行与存档不变量

- 玩家操作和后续自动节点在暂存状态中执行，自动步数默认最多 256；错误使整次状态变更回滚。
- 回调在状态提交后触发，观察者异常不回滚已提交状态；所有观察者均有机会收到事件。
- 事件分发期间禁止重入修改；动作连接器延迟调用 handler，避免同步状态机回调嵌套推进。
- GUI 按钮携带 revision，旧按钮不能推进新节点。
- 存档只保留可恢复节点，不保留 branch/effect 等中间执行位置。恢复不重放此前变量效果。
- action token 保存同一剧情版本/运行/执行序号/节点身份；读档保持 token，但确认 id 更新。
- 外部副作用不能与内存存档跨系统原子提交。宿主必须以 token 持久化幂等记录和结果；
  运行时不宣称跨进程 exactly-once。全局唯一成就仍需宿主自身的奖励标识。
- restore、重新开始、销毁会取消旧 handler；忽略 AbortSignal 的旧结果也不能提交。
- GPU GUI detach 本身不是销毁，场景退出需 dispose 或 AbortSignal，释放图片租约与订阅。

## API 审阅

4 个值：NarrativeRuntime、validateNarrativeDefinition、NarrativeGui、connectNarrativeActions。
15 个类型，共 19 个符号，仅 ./narrative 新增能力预算。根入口和既有预算保持不变。
[API 与验证](../../../review/api/narrative-validation.md)。

## 首版边界

等待现实时间、视频/音频演出、限时选择、剧情编辑器、跨版本存档迁移不在首版内。
宿主可通过 action 接入异步操作；需要跨退出恢复的计时不能只用未保存的 setTimeout。
GUI 默认用保守字宽估计换行，允许注入精确 measureText；字体覆盖由游戏配置。
JSON 协议可以跨语言共享，本变更不实现 Rust 端解释器或 Native 真机发布。
