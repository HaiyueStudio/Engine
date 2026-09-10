# Virtual joystick controls

入口：`@haiyue/extensions/controls`。新增稳定子入口的本地开发候选；正式发布须按 [API stability](../for-ai/api-stability.md) 进入经过评审的 minor，不改变已发布的 0.1.x 合同。

`VirtualJoystickControls` 是非渲染 `System`。构造函数接收事件表面和 `VirtualJoystickOptions`；加入 Scene/World 后自动更新，也可由宿主每帧调用一次 `step(deltaMilliseconds)`。不要同时使用两种更新方式。

## 参数

所有屏幕位置、距离和半径均为相对于输入表面左上角的 CSS/逻辑像素，不乘设备 DPR。

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `floating` | `fixed` 固定中心；`floating` 以有效按下点为本次中心 |
| `center` | 左下角附近 | 固定中心 `{x,y}` 或 `(viewport) => point` |
| `region` | 左下四分之一区域 | 两种模式的按下范围 `{x,y,width,height}` 或 viewport 回调；拖动可离开此范围 |
| `maxDistance` | 64 | 摇杆头中心的最大偏移，必须大于 0 |
| `activationRadius` | `null` | 固定模式命中半径；null 使用 maxDistance + knobRadius；同时受 region 限制 |
| `deadZone` | 0.1 | 死区占最大距离的比例，范围 `[0,1)` |
| `target` | null | 可选 Entity；不传则仅输出事件 |
| `plane` | `xz` | xz 需 CartesianTransform3D；xy 需 Transform2D |
| `moveSpeed` | 4 | 满力度每秒移动的父坐标系单位数 |
| `analog` | true | 按力度缩放速度；false 时超过死区即全速 |
| `rotateToDirection` | true | 移动时朝向运动方向，归零后保留朝向 |
| `turnSpeed` | Infinity | 每秒最大转角（弧度）；Infinity 即时转向，0 禁止转动 |
| `rotationOffset` | 0 | 模型默认朝向修正弧度 |
| `movementRotation` | 0 | 绕 +Y（xz）或 +Z（xy）旋转移动基准方向，可匹配相机航向 |
| `maxDeltaMilliseconds` | 100 | 内置位移/转向积分的单帧上限；不改变事件中的实际 dt |
| `guiRoot` | null | 可选的全表面 Engine GuiRoot；需由调用方加入场景并启用 GUI 系统 |
| `knobRadius` | 24 | 摇杆头显示半径，不改变输入最大偏移 |
| `showIdle` | true | 固定模式空闲时显示；浮动模式仅触摸时显示 |
| `baseStyle` / `knobStyle` | 蓝色半透明 | Engine GuiStyle；圆形尺寸/radius 由摇杆控制，建议用 backgroundColor 配色 |
| `shouldActivate` | 无 | `(point,event) => boolean`，返回 false 拒绝本次按下，可排除 HUD 命中 |

`configure(options)` 合并并验证参数，有效更新取消当前手势；`disabled=true` 取消并禁用输入、移动和帧事件。`cancel()` 可用于 Native 暂停/卸载。`destroy()` 幂等释放输入监听、捕获、生成的 GUI 节点和事件订阅，World 销毁自动调用；共享 GUI root 和 Entity 仍由宿主管理。

## 事件

通过 `controls.events.on('frame', ({ detail }) => …)` 订阅 Engine 事件。每次启用状态下的 `step()` 发送一次 `frame`，包含静止按住、空闲和 dt 为 0 的帧；不是仅在 pointermove 时发送。

`VirtualJoystickFrame` 包含：

| 字段 | 语义 |
| --- | --- |
| `deltaMilliseconds`, `deltaSeconds` | 宿主传入的实际帧间隔，两种显式单位 |
| `movementDeltaSeconds` | 内置移动使用的限幅后秒数 |
| `active`, `pointerId` | 是否持有触摸；空闲时 pointerId 为 null |
| `center`, `offset` | 本局部表面的中心和限幅后摇杆头偏移 |
| `direction` | 屏幕单位方向，右为 +X、下为 +Y；死区内为零 |
| `distance`, `rawDistance` | 限幅后距离和实际拖动距离，均为逻辑像素 |
| `strength` | 死区内为 0，死区外连续映射到 1 |
| `angle` | 从屏幕右方向顺时针的弧度角，死区内为 0 |

`start` 在接受触摸时发送；`end` 在正常松手后发送；`cancel` 在取消、捕获丢失、失焦、页面隐藏、布局改变、禁用和销毁时发送。后两者携带回中后的状态。所有事件状态均可保留且不可修改；`controls.state` 返回同样的即时只读快照，不含帧时间。

宿主首帧时间戳可能略早于启动时刻；System.update 会把这种负间隔归零。手动 step 要求非负有限间隔，避免无效输入中断渲染或造成反向移动。

## 坐标与边界

xz 模式下向上拖动对应 -Z，默认模型前方为 -Z，仅修改 X/Z 和 yaw；xy 模式下向上拖动对应 +Y，默认前方为 +X。位移采用目标的父坐标系，不会求解碰撞、NavMesh 或物理。物理角色应省略 target，通过 frame 事件驱动自己的角色控制器。

输入采用 Pointer Events，第一根符合条件的手指独占摇杆，其余手指不影响它；不要求 isPrimary，便于另一根手指同时操作技能按钮。浏览器表面设置 `touch-action:none`；Native 提供同名指针事件和边界测量，并在暂停时调用 cancel。尺寸或表面屏幕位置变化取消已有手势，下一次按下使用新的布局。

GuiSystem 默认对 canvas 指针执行 preventDefault 来禁止浏览器滚动；摇杆不会把它误判为输入已被其他控件占用。与 HUD 或其他摇杆的输入分区通过 region / shouldActivate 明确配置。

使用方法见 [虚拟摇杆指南](../engine-guide/virtual-joystick.md)，可运行示例见 [Virtual Joystick](../../examples/virtual-joystick/index.html)。
