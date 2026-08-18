# ADR 0041：PBR Transmission 与 Volume 场景颜色路径

## 决策

`KHR_materials_transmission` 与 `KHR_materials_volume` 由 `PbrMaterial` 原生表达，并通过不透明场景颜色快照渲染，不把光学透射降级为 alpha blend。

渲染顺序固定为：

1. 天空与不透明对象写入离屏颜色和深度；
2. resolved color 复制到只读场景颜色纹理；
3. 透射及其他透明对象在保留的颜色、深度和 MSAA attachment 上继续渲染；
4. 后处理链运行；没有用户后处理时执行一次全屏 present。

透射强度纹理读取 R，厚度纹理读取 G。厚度按对象世界缩放换算，有限 `attenuationDistance` 使用 Beer-Lambert 衰减；零厚度保持薄表面路径。

## 绑定预算

材质公开 14 个纹理槽，但单个 shader 变体只绑定 12 个。普通变体绑定 Sheen 的两个纹理，Transmission 变体复用同一绑定位置放置 transmission/thickness。加上 diffuse/specular environment、shadow 与 scene color，fragment stage 恰好使用 WebGPU 最低保证的 16 个 sampled textures。

组合限制是：Transmission 变体保留 Sheen factor BRDF，但不读取 Sheen 的两张纹理。这一限制必须在材质文档和兼容报告中保持可见，不能静默增加设备限制。

## 已知边界

- 场景颜色是单层不透明快照；多个透射对象不会递归折射彼此。
- 粗糙透射使用屏幕空间多点模糊，不是离线级路径追踪。
- 超出屏幕的折射坐标会钳制到视口边缘。
