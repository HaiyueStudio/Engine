# 运行 Gameplay Kit

[Gameplay Kit 示例](../../examples/gameplay-kit/index.html)使用配对的 0.2.3 开发候选。左侧设置区按需刷新，右侧显示活动场景；切换场景时保留设置模型、原 GUI 和音频宿主。

从 Play 页开始关卡，观察加载进度。Cancel loading 取消尚未提交的加载；Try failed load 保留旧关卡；Return to menu 释放关卡的物理、地图和声音。点击右侧画面取得游戏输入，方向键／A、D 移动，Space 跳跃；点击设置区或按 F1 返回 GUI。切换输入归属后，先松开按钮、让摇杆回中，再重新操作。

Profile 页提供重绑、保存和恢复。List／Tree 页使用稳定 key 的集合，滚动不会为全部逻辑条目创建控件。Play 中的折叠面板保留文本；标题和独立 Reset name 按钮分别处理交互。标签图标可在文字左右显示，面包屑返回由应用回调处理，徽标装饰不抢下方按钮的点击。

Audio 页需要先点击 Unlock。可分别听左／中／右、远距离静音、两秒淡出和静音恢复；支持能力由原音频宿主报告。示例不会在页面打开时自动发声，也不会把自动化日志当作实际听音结果。

Map 页的 1%／10% 连续更新是明确的压力选项；Static map 停止修改。Camera 页提供震屏、暂停和瞬移复位。默认 32 个角色、128 个障碍及 512×512 地图用于组合验证；新功能的其他冻结负载由对应验收器分别覆盖。

应用复用 `HaiyueEngine.createScene()`、SceneFlow、原 World 的实体转移和区域管线。设置保存使用原 GameSaveService。退出时先停止应用回调和输入，再释放借用控制器、场景和资产，最后销毁引擎；实现见 [application.ts](../../examples/gameplay-kit/application.ts)。最终设备、性能和发布资格以 [验收入口](../../review/engine-0.2.3/README.md)为准。
