# 可选能力：问题、方法、结论

本页合并已结束的摇杆、国际化、剧情和分享内容评审。表内结果仅对应原记录的源码、设备与范围；原文和逐次日志见[校验归档](../archive/engine-review-process-20261020.json)，当前 API 以公开声明和能力预算为准。

| 问题 | 方法 | 结论与边界 |
| --- | --- | --- |
| 需要通用移动摇杆，避免游戏重复处理多指、GUI 与移动输入 | `/controls` 提供单一 System、固定/浮动模式、指针归属与 parent-local 移动；按 Engine 帧发事件，复用 GUI；取消时清理捕获与资源 | 原 packed consumer、类型、测试及 Mac Metal 横竖屏验证通过；不处理碰撞，不冒充 Native/iPhone 资格。[ADR 0101](../../docs/for-ai/adr/0101-virtual-joystick-extension-controls.md)、[公开面](virtual-joystick-api.json)、[设备与构建证据](virtual-joystick-evidence/README.md) |
| 语言切换、异步图片及字体字库可能不同步 | `/i18n` 使用版本化纯数据语言包、latest-wins、预加载不提交、失败保留旧图；GUI 使用公开 setter 与可释放 texture lease，显式提供各语言字库 | 原浏览器语言/图片/参数切换和真实字体显示通过；不自动提供 ICU、RTL shaping 或任意玩家输入字体，Native 仍需宿主 Intl/字体/纹理能力。[ADR 0115](../../docs/for-ai/adr/0115-optional-i18n-runtime.md)、[API](i18n-api.json)、[浏览器](i18n-browser.json)、[包测量](i18n-package-measurement.json) |
| 剧情分支、存档与外部动作可能重复产生副作用 | `/narrative` 复用 i18n，图数据与可选 GUI 分离；事务提交后通知，拒绝重入；已完成 effect 不重放，待确认动作保留 durable token，宿主负责持久去重 | 原三分支/双结局、存档恢复、回调取消及浏览器 GUI 通过；不把浏览器结果当 Native 资格，不含视频/编辑器/存储迁移。[ADR 0116](../../docs/for-ai/adr/0116-optional-narrative-runtime.md)、[API](narrative-api.json)、[浏览器](narrative-browser.json)、[包测量](narrative-package-measurement.json) |
| 游戏需要截图卡片与挑战链接，但平台分享不属于 Engine | `/share-content` 提供一次性 Canvas2D 排版与编码，输入图片借用、输出表面拥有；取消抑制晚回调；挑战数据按宿主 origin/game/rules 校验 | 原浏览器及 Native 独立宿主的图像/本地化/解析通过，平台系统 sheet 结果另记；挑战链接无签名，不能当成绩/奖励证明，也不注册 OS deep link。[ADR 0118](../../docs/for-ai/adr/0118-share-content-composition.md)、[浏览器](share-content-browser.json)、[包测量](share-content-package-measurement.json) |

这些能力保持 focused 入口、无根聚合、无新平台依赖。旧全仓测试计数、构建重试与当时兄弟仓库缺失造成的门禁失败保存在归档，不再作为当前待办；原失败没有改判为通过。当前包、设备与发布资格需由对应候选门禁重新证明。
