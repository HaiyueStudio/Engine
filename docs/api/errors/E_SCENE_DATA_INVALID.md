# E_SCENE_DATA_INVALID

场景、GUI 或其他持久化数据不符合声明的格式与版本。根据错误对象的 `path` 定位无效字段，并检查 `format`、`version`、字段类型和嵌套结构。

不要跳过 `unknown` 输入校验或静默猜测旧格式。若数据来自外部文件，应保留完整的 serialization domain、code、context、path 和 cause，再提示用户修复或通过受支持的迁移器转换。
