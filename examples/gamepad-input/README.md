# Gamepad Input · 手柄实时反馈

在示例目录的「交互」分组打开 **Gamepad Input**，或访问 `/examples/gamepad-input/`。
通过 USB / 蓝牙连接手柄，按任意按键让浏览器识别，然后保持页面在前台。
多设备时可在顶部选择当前手柄。

- 标准 ABXY 布局：左右摇杆、L3/R3、十字键、ABXY、LT/RT、LB/RB、Back、Menu，以及 Home（浏览器可能保留该按键）。
- 摇杆位置显示原始标准轴值；扳机显示连续压力，按键有高亮与下压动画。
- 记录按下、松开、摇杆移动/回中、压力变化、设备切换和断开，最新记录在上方，最多 100 条，可清空。
- 日志忽略 0.12 范围内的摇杆漂移；模拟量变化至少 0.08、间隔至少 160ms 才再次记录。开始操作和回中/松开立即记录。画面不采用日志死区。
- 失焦/隐藏时清空高亮并暂停采样；返回后恢复。断开与切换设备会释放旧状态。
- 仅对 `mapping === 'standard'` 的设备启用图中映射；其他设备提示切换标准 / XInput 模式，不猜测按键含义。

## 实现

这个示例专门展示输入能力：通过公开实验入口
`@haiyue/engine/experimental/simulation` 的 `BrowserMultiplayerInput` 和动作绑定采样。
SVG 是代码绘制的可缩放检查界面，不创建无关的 3D 场景或 GPU 资源，也不模拟手柄输入。
`pagehide` 释放采样器和监听器、停止动画帧，恢复浏览器历史缓存时重新建立会话。
`body.dataset.gamepad` 提供只读诊断状态。

## 验证

```sh
npm run typecheck -w ./examples
npm run examples:catalog:check
npm run build:target -- example:gamepad-input
node --test engine/test/gamepad-example.test.mjs
node engine/test/gamepad-example-gate.mjs
```

浏览器门禁使用合成 Gamepad API 数据经过真实 Engine 采样器，验证画面像素、所有标准按键、摇杆/扳机、日志、稀疏设备索引、切换/断开、失焦恢复、窄屏及生命周期；结果与截图写入 `artifacts/engine-0.2.2/gamepad-input-<timestamp>/`。
这不代替物理手柄验收。真机应逐一按下/松开上述按键，转动两个摇杆、渐压扳机，测试多设备切换、拔插和切换浏览器标签页。确认高亮、位置、压力与日志一致，且释放后无残留。
