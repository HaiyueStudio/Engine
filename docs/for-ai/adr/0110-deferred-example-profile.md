# ADR 0110：Deferred 示例的 experimental profile facade

日期：2026-09-29。状态：accepted。

## Context

[ADR 0109](0109-deferred-lighting-021-contract.md) 冻结了 Deferred 的实现合同，并把公开入口留给 G07。用户现已明确要求先实现多光源示例，跨引擎设备评测另立 Goal。示例必须使用公共包入口，不能跨 workspace 引用 private factory。

## Decision

将最小实验入口集成前移到 G06，使用已有 `@haiyue/engine/experimental/renderer`。新增一个异步 factory 和四个配套类型，同步到兼容 experimental 聚合入口；stable root、package subpath、版本和渲染 ABI 不变。详见 [API 评审](../../../review/engine-0.2.1/g06-example-api-review.md)。

Facade 只返回复制的诊断值、主动读取的像素/深度以及释放方法，不导出 backend 或 GPU 资源句柄。Scene/system 拥有后端，过期 profile 不能释放新实例。调试读回是显式操作，不进入正常帧路径或正式性能样本；同一 handle 最多一个在途读回。

## Consequences

用户可通过包入口运行多灯示例，保留普通 Forward 的按需加载边界。示例和入口完成不代表 G05 性能达标；G07 仍需同时验收 G05/G06 和 clean package。设备预算、跨引擎实测独立规划，不改变已有失败记录。

## Verification

入口类型/取消与替换隔离测试、浏览器像素与生命周期验证、API diff、包体及消费检查。教程见[多光源示例](../../engine-guide/deferred-lighting.md)。
