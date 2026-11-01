# E_ASSET_INVALID_DATA

提供的资产或运行时配置不符合调用方声明的数据合同。应检查 `EngineError.message` 定位字段，按 `code` 分类处理，不对非法数据自动重试。

在 0.2.3 开发版的 `@haiyue/extensions/tilemap` 中，图集尺寸、margin／spacing、纹理尺寸或用途、单元格编号、变换和显式分块上限不合法时会返回此既有错误码。图集编号从 1 开始，0 为空；atlas／显式 chunk 地图最多 1,048,576 格，chunkSize 为 1–64，maxResidentChunks 为 1–256。输入校验在提交配置变更前完成。

GPU 图集源由应用借用，不能写入组件序列化数据；保存应用资产标识并在加载后重新绑定。原始 cells／palette 的直接修改完成后调用 `markDirty()`。参数和所有权说明见 [Tilemap 使用说明](../../../extensions/README.md)。
