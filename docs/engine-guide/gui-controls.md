# 用复合 GUI 组织设置页面

0.2.3 开发候选提供带图标的标签页、面包屑、徽标和折叠面板。它们沿用原 GUI 的主题、布局、焦点及资源所有权；请使用配对的 Engine/extensions 候选包。完整运行方式见 [GUI Controls 示例](../../examples/gui-controls/index.html)，参数边界见 [API 说明](../api/gui-controls.md)。

## 装配页面

在应用已有的 `GuiRoot` 和 `GuiSystem` 上创建控件，并把 `gui.focus` 传给需要焦点恢复的组件。内容由应用提供，组件只借用它。

浏览器页面需要原生文本输入和输入法时，为已有 `GuiSystem` 配置 `textInputHost: 'browser'`；Native 应用传入自己的平台响应器。复合组件不再创建文本宿主。

```ts
import {GuiElement, GuiInput} from '@haiyue/engine/gui';
import {GuiTabContainer, attachGuiLayout} from '@haiyue/extensions/gui-layout';
import {GuiCollapse} from '@haiyue/extensions/gui-controls';

const content = new GuiElement({width: '100%', height: 64});
content.add(new GuiInput({x: 12, y: 12, width: 240, value: 'Player'}));
const settings = new GuiCollapse({
  focus: gui.focus,
  items: [{key: 'profile', title: 'Profile', content}],
  expandedKeys: ['profile'],
});
const tabs = new GuiTabContainer({
  focus: gui.focus,
  pages: [{id: 'settings', title: 'Settings', content: settings.element}],
});
root.add(tabs.element);
const layout = attachGuiLayout(root);
layout.setStyle(tabs.element, {width: 600, height: 400});
```

向页面的 `icon` 传入原 `GuiImageSource`，用 `iconPosition: 'right'` 将图标放到文字右边；也可以调用 `tabs.setPageHeader` 更新页头。没有图标时不保留图标间距。图片资产的持有和释放仍由应用处理。

长面板可放入原 `GuiScrollView`。在同一个 layout binding 上对该滚动视图调用 `setStyle(scroll, {direction: 'column'})`，让布局在标签页分配视口后计算可滚动内容。未配置流式布局的旧手动坐标子节点继续使用原有位置。

## 更新和导航

面包屑的 `onNavigate` 返回稳定 key，应用根据该 key 切换页面；当前项和禁用项不触发导航。可选菜单复用原模态焦点域。需要允许所有祖先导航时，可用 `setCurrent(null)` 清除当前项。

用 `new GuiBadge({content: button, value: unread})` 装饰未挂载的按钮，再把 `badge.element` 放进界面。计数用 `setValue` 更新；例如 100 默认显示 `99+`。装饰不抢点击和焦点，也不改变按钮的内容流。状态徽标可同时提供 `status` 和 `statusText`，无需持续动画。

折叠面板以 key 保存展开状态。普通配置调用 `setExpandedKeys(keys)` 不通知；需要同步应用模型时传入 `true`。用户切换会通知一次。收起面板前，原输入域处理焦点和预编辑；不要销毁文本框来模拟隐藏。

## 释放页面

先停止应用对控件的回调，再调用 `tabs.dispose()`、`settings.dispose()`、`badge.dispose()` 和 `layout.dispose()`，最后销毁 GUI 场景。父控件的销毁只解绑借用内容；嵌套控制器、集合行绑定和资产句柄由各自 owner 释放。示例同时演示 G07 虚拟列表，面板关闭后条目状态仍由应用模型保存。
