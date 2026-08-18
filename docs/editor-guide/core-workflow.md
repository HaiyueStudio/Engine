# 核心工作流

## 打开与最近项目

- **Open**：选择场景 JSON。
- **Recent**：重新打开最近使用的文档。
- 编辑器会跟踪当前修订与已保存修订；存在未保存修改时，关闭或替换文档前会提示。
- 浏览器允许时，已打开的 `FileSystemHandle` 会用于原位保存；否则 Save/Save As 会生成文件。

## 编辑与撤销

- 在 Hierarchy 中选择实体，在 Inspector 中编辑组件。
- `W`、`E`、`R` 分别切换位移、旋转和缩放 Gizmo。
- Viewport 支持 world/local、active/center pivot 和吸附。
- 一次 Gizmo 拖拽合并为一个撤销命令；顶部 Undo/Redo 用于回退或恢复。
- 多选实体时 Inspector 会显示 mixed value，可对选择集合批量修改共有属性。

## 资源

Resources 按 Geometry、Material、Texture、Model、Prefab 和 Script 分类。搜索只过滤当前资源视图；导入或重导入的进度与失败信息显示在资源操作中心。

资源被场景引用时，删除或替换前应检查依赖关系。glTF 的扩展支持、mipmap、bounds 和降级信息来自 loader 的 compatibility report，而不是由资源面板重新推断。

## 保存与恢复

- **Save**：保存到当前文件句柄；没有句柄时转为 Save As。
- **Save As**：选择新位置或下载新的场景 JSON。
- 自动恢复副本保存在 IndexedDB，用于浏览器异常关闭后的恢复。
- 外部文件在编辑期间发生变化时，应先处理冲突，不要直接覆盖磁盘版本。

项目发布流程见 [Play、调试与导出](./play-debug-export.md)。
