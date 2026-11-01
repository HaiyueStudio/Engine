# 0.2.3 G01 合同诊断

本目录是冻结合同的只读来源验证，不实现规划能力，不推广发布资格。

- `source-probes.mjs`：原始输入轴、参数校验、场景释放、树窗口及真实 box2d.ts 扫掠/流形。
- `diagnose.mjs`：复用既有确定性 workload 与 audit device，保存27个CPU及3个结构cohort；旧HYA默认语义与CSS差异不等于新的gui-v1回归。
- `browser.mjs`：复用正式Chrome/server helper；`icon-oracle`是DOM几何参考，`native-reference`运行原直接全绘制参考，不覆盖旧证据。
- `policy.mjs` / `policy.test.mjs`：合同、目标声明、范围和证据的确定性验证及拒绝测试。

运行入口和最终哈希见 [唯一验收入口](../../../review/engine-0.2.3/README.md)。原始输出写到 artifacts/engine-0.2.3/g01，成功文件不覆盖。当前脚本运行不要求用户退出聊天；其结果不能作为空闲环境正式性能结果。
