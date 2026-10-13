# NVIDIA 3D 设置保存失败：控制面板与 API 一致

日期：2026-10-09。接续 [GPU 状态诊断](gpu-state-closed-result.md)。用户在 NVIDIA 控制面板的 Google Chrome 程序设置中应用电源管理模式，弹出“拒绝访问，无法应用选定的设置到您的系统”。[截图证据](../../../artifacts/engine-0.2.1/g09/nvidia-drs-diagnostic-20261009T033912Z/control-panel-access-denied.png)与此前 NVAPI 保存失败一致，排除了问题仅出在我们的调用入口这一解释。

## 已完成的定位

当前显卡 GTX 1070 Ti，驱动 560.94；系统 NVAPI DLL 为 32.0.15.6094，驱动包为已签名的 oem39.inf。诊断进程已具有管理员权限。

- NVIDIA DRS 目录及文件无只读标记，现有 ACL 允许写入。对目录中六个文件进行共享读写打开后立即关闭，全部成功，写入字节数为 0。没有修改 ACL、所有者或文件属性。
- NVIDIA Display Container LocalSystem 与 NVIDIA LocalSystem Container 服务均在运行。单独重启显示配置服务后，仍返回相同保存错误；服务恢复为 Running，启动类型保持 Auto。未重启 GPU、未停止安全软件。
- 在独立会话中读取配置成功，但向工作区导出以及不更改设置的保存均返回 NVAPI_ERROR (-1)。这不是 Chrome 电源值才触发的唯一失败路径。
- 短时 Microsoft-Windows-Kernel-File 跟踪记录 13153 个事件；关联到 NVIDIA DRS 目录的 29 次创建/打开操作均成功，保存锁文件的独占打开也成功，未见该目录访问被拒或共享冲突。导出目标文件没有被创建/打开。这支持进一步调查驱动配置处理/序列化路径，不证明某个数据库文件已经损坏，也不排除其他未采集通道的限制。
- 只读枚举了 7192 个 profile，读取 50647 项设置。23 个 profile 的公开枚举数量小于元数据数量，相关 API 仍返回成功；可能涉及隐藏设置，不能据此删除这些游戏配置，也不能把计数差直接认定为损坏。

文件跟踪已停止，未留下采样进程。Chrome 电源策略的新会话回读仍无显式条目，CPU 仍为原平衡方案最低 5% / 最高 100%。四个配置文件的哈希在全部探测后保持不变。

## 备份与范围

已将 nvdrsdb0.bin、nvdrsdb1.bin、nvdrssel.bin、update.bin 原样复制到 [诊断目录](../../../artifacts/engine-0.2.1/g09/nvidia-drs-diagnostic-20261009T033912Z/backup-manifest.json)，逐一比较复制前、副本、复制后的 SHA-256，并保存 ACL。原样备份用于保留现状和后续恢复评估，不能保证跨驱动版本直接导入旧数据库仍兼容。

已完成当前 oem39.inf 显示驱动包的导出：315 个文件、1882219579 字节，每个文件均记录 SHA-256。备份位于同一证据目录；这是显示驱动包备份，不冒充所有 NVIDIA 应用/组件的完整系统恢复镜像。

未删除或重命名系统 DRS 文件，没有还原所有默认值、升级驱动或重启电脑。上述检查没有改变 Engine 实现、正式基线、5% 回归预算或 20%/10% 稳定性门槛。

## 建议的下一步修复

低影响的权限核查及服务重启未恢复保存功能。下一步建议使用 NVIDIA 官方安装器对 GeForce Security Update Driver 582.78 执行“自定义（高级）→ 执行清洁安装”，作为修复尝试。官方 [582.78 发布说明](https://us.download.nvidia.com/Windows/582.78/582.78-win11-win10-release-notes.pdf) 第 29–30 页明确支持 Windows 10 64 位与 GTX 1070 Ti；该版本也是用户 GeForce Experience 界面提供的版本。[官方清洁安装步骤](https://nvidia.custhelp.com/app/answers/detail/a_id/10/kw/setup)要求安装完成后重新启动电脑。发布说明没有承诺修复本机这个具体错误，不能预先保证成功。

此操作会影响 Chrome 之外的驱动设置，清洁安装会重置应用的自定义 3D 配置，并涉及驱动更换、显示中断及重启，需要用户确认后再执行。C 盘当前仅约 3.3 GiB 可用；下载和解压应放在 D 盘，安装前还须检查系统盘所需空间。没有自动清理用户文件。

批准并完成修复后，先复核驱动版本、Chrome 电源策略的写入/回读/恢复以及原生正确性，再进行短时 GPU 状态对照。只有统一 GPU 条件经过验证后，才能冻结协议并为 A0/B4 重新建立同驱动、同机器基线。旧 560.94 证据完整保留，不能与新驱动数据混算；5% 预算不变。
完整检查、备份清单及来源哈希见[驱动保存检查索引](nvidia-settings-save-checks.json)。
