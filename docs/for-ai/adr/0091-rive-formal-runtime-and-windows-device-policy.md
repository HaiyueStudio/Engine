# ADR 0091：Rive 正式证据接受 Node.js 22+ 与任意 Windows 10+ 物理设备

- 状态：Accepted
- 日期：2026-08-25
- 补充：ADR 0087、ADR 0090
- 兼容 tuple：`rive-7.3-webgl2-2.40.0`

## 背景

早期 G11 workload 把正式执行环境固定为 Node.js 22、Windows 10 集显和 Windows 11 独显。这把运行时最低版本与单一主版本混为一谈，也把 GPU 产品类别误当成 fidelity contract。Engine 的公共 Node 策略实际是 22 及以上；Rive/HYA parity 的正式要求是物理 WebGPU/WebGL2 执行和同机对比，不依赖集显或独显标签。

## 决策

1. G11 candidate、security、differential runner 和 formal closure 接受 Node.js major `>=22`。Node 21 及以下继续硬失败；报告仍记录精确 Node 版本。
2. 两个正式设备 slot 均接受 Windows 10 或更高版本及任意物理 GPU。设备记录必须显式声明 `physicalDevice: true`、native backend、OS/build、GPU/adapter 与机器 identity。
3. 原有至少两台真实设备、每台 Chrome 与 Edge、official/HYA 同机同 revision 的要求不变。两个 slot 必须使用不同的 `machineIdSha256`，不能由一台机器重复填充。
4. workload slot 改名为 `windows-10-plus-device-a` 与 `windows-10-plus-device-b`；名称表示证据位置，不表示 GPU capability class。

## 后果

- 当前 Node.js 24 环境不再单独产生 G11 blocker。
- 当前 worktree dirty、native host 未配置、双物理设备 trace 缺失等 blocker 不受本修订影响。
- 旧 device-class trace 可保留为历史诊断，但不能进入新 workload hash 的正式 candidate。

