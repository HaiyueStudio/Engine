# 像素基线与渲染修复结论

本路径仍被 PBR、Fog、Volume 像素基线引用，保留修复依据；逐轮检查、机器状态和完整数值已收入[原文归档](archive/engine-process-history-20261016.json)。后续旧版全局验收见[发布结论](release-history.md)，当前资格见 [Engine 0.2.1](engine-0.2.1/README.md)。

| 问题 | 结论与解决方法 |
| --- | --- |
| 原生 Metal 上 GTAO 输出接近黑色 | 独立读回与 CPU 积分定位有界循环尾部控制流；在 Shader Language 源码中将等价 `continue` 改为 `break` 并重新生成。AO-only 输出不套用场景 tone mapping，组合路径保持原输出边界 |
| CPU 基准复用跨帧 encoder，灯光缓存扩容导致重复上传 | 每帧创建 frame context 并执行 record／submit，使依赖与退役属于正确帧；扩容恢复有效记录、保留旧 buffer 的安全退役及预热成本；未改变的 shadow uniform 不重复上传 |
| PNG 编码哈希无法量化像素差异 | PBR／Fog／Volume 保存完整 RGBA 参考；原采用的平均通道误差不超过 2、偏差大于 8 的通道比例不超过 2%。尺寸、缺失／损坏参考、黑屏和 alpha 丢失仍须失败。具体值由当前基线拥有，本次没有修改基线 |
| HDR 输出改变平面反射显示值 | tone mapping／display transfer 在 SceneOutput 边界执行；参考更新保留原图与人工审阅，mirror planner 结构预算及原产品截图要求保持 |
| 未登记的 Mac 设备没有固定 P95 profile | 完整样本与结构校验仍执行；结果保留 `not-enrolled / diagnostic-only`，不伪造设备身份，不把命令退出 0 当成全部耗时预算通过 |
| Volume 接线和旧 Live2D 离线资源与当前构建不一致 | 显式纳入构建／像素验证目标；由当前确定性转换器重建资源并验证运行与设备恢复，不用旧产物冒充新资格 |

当时的 CPU 超线、首轮构建失败、候选 revision 差异和旧像素参考均保留在归档及 `artifacts/release/0.2.0-blocker-fixes/` 原始证据中。当前未完成项只在当前版本结论中维护。
