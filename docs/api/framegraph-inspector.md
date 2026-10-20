# FrameGraph Inspector（experimental）

入口 `@haiyue/engine/experimental/renderer`，不承诺 stable 兼容。

| 符号 / 方法 | 合同 |
| --- | --- |
| `createFrameGraphInspector(system)` | 为已有 Render3DSystem 注册单帧观察者；同一 system 重复注册抛 Error |
| `FrameGraphInspector.requestCapture()` | 捕获下一次 record；不启动渲染。dispose 后调用抛 Error |
| `snapshot()` | 深冻结的 JSON-safe 副本；未捕获/清除后 null。重捕获完成前仍可读上一份快照 |
| `clear()` | 清除快照，取消 pending 捕获及过期提交回调 |
| `dispose()` | 幂等注销；应在场景/引擎退出时调用 |
| `FrameGraphSnapshot` | schemaVersion、frame、status/error、scope、plans、allocations、pools、work、overhead、truncated |

status 为 recorded/submitted/failed。提交和 bundle 内 draw 的不可观测值使用 null；编码数不保证 GPU 成功执行。资源区间是各自图/分配批次局部闭区间；physicalId 需与 pool ID 联用。池字节是估算，非真实驻留。外部附件和持久历史不在临时池映射中。

snapshot 本身、JSON 导出和 PNG 图导出均不读 GPU。metadataCopyMs 仅包含内部元数据复制的部分 CPU 成本，不含代理、冻结和 UI。每类事件及其条目上限 256，truncated 必须检查。局部图存在父子关系，不可把节点总数称为 GPU pass 数。

[操作指南](../engine-guide/deferred-lighting.md#framegraph-诊断) · [ADR 0114](../for-ai/adr/0114-framegraph-one-shot-diagnostics.md)
