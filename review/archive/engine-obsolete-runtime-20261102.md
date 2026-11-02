# 过期 G11 运行副本与安装缓存归档

2026-11-02，共十四批离线归档：87,585 个普通文件，原内容 1,315,783,763 bytes，ZIP 合计 413,965,331 bytes。源文件移除前均完成逐文件解包与 SHA-256 回读；当前主仓源码、合同、发行基线、父级检查／注册记录、主仓采样和 Git 对象库继续在原位。

第二轮新增七份旧候选安装缓存：28,107 个文件、347,297,722 bytes，压缩为 97,652,347 bytes；本轮观测 D 盘空闲量增加 289,677,312 bytes。46 份配置／基线／验收检查文件的字节数和 SHA-256 均未改变。单文件隔离恢复和十四批、87,585 文件的恢复工具回读全部通过。

## 范围与依据

| 批次 | 原位置（相对于 Studio 根目录） | 依据 |
| --- | --- | --- |
| 01 | `Engine/artifacts/engine-0.2.3/g11/qualification-preparation-1793518757355-af903066/checkout` | 准备失败，正式采样未启动 |
| 02 | `Engine/artifacts/engine-0.2.3/g11/qualification-preparation-1793518854890-34345e2c/checkout` | 已被 GUI P2 取代，正式入口已阻止启动 |
| 03–07 | `Engine/artifacts/engine-0.2.3/g11/prototype-candidate{,-2,-3,-4,-owner-fixed}/consumer/node_modules` | 首轮确认的旧原型安装缓存 |
| 08–14 | 同一 G11 目录的 `combined-current-candidate`、`combined-diagnostic-candidate-2`、`controls-current-candidate`、`output-fixed-candidate`、`physical-current-candidate`、`physical-qualified-candidate`、`settings-fixed-candidate` 下的 `consumer/node_modules` | 早于 GUI P2 的旧特性／诊断安装，`releaseQualified=false`；1925 份现行文档／脚本无 owner 路径引用，目录名补查也无匹配，未发现相关进程 |

主检查索引仍是 [G11](../engine-0.2.3/g11-checks.json)。被该索引引用的 `prepared-current-candidate`、主仓安装、原始采样、包文件和基线继续保留。历史记录中的原路径、原文件哈希、失败和未取得资格的结论均不改写；Git 目录和重解析链接也保留原位。

## 存储、读取与恢复

离线目录：`D:\HaiyueStudio\_archives\engine-obsolete-runtime-20261102`。最新不可覆盖索引为 `index-20261102-round2-verified.json`，SHA-256：

```text
75357e51451f4709242dc408c2634064d4314cfd02151f94eede22a8c057b0bc
```

首轮的 `index-20261102-final.json` 原字节与哈希仍保留：`a1c06c2cf2bfbb4bd65480af40cadc9ff99a1a95d9c3e2b12bcc92ad8e1d249c`。索引绑定逐文件清单、ZIP 哈希、恢复工具，以及筛选／恢复验证资料的原路径→存储路径映射。原位置的 `ARCHIVED-20261102.json` 也提供入口。

```powershell
$archive = 'D:\HaiyueStudio\_archives\engine-obsolete-runtime-20261102'
python "$archive\restore.py" --verify
python "$archive\restore.py" --read 'Engine/artifacts/.../original-file' --output 'D:\temporary-readback.bin'
python "$archive\restore.py" --restore-one 'Engine/artifacts/.../original-file'
python "$archive\restore.py" --restore
```

也接受原始 `D:\HaiyueStudio\...` 绝对路径；`--root` 可指定隔离恢复根目录。恢复工具支持 Windows 超长路径，遇到后来改动的同名文件会拒绝覆盖。首轮 324 字符路径恢复和本轮实际文件恢复记录分别保存在 `restore-smoke.json`、`restore-smoke-round2.json`。

当前 GUI P2 的正式验收仍按 [0.2.3 入口](../engine-0.2.3/README.md)准备新候选；复核旧候选时先按映射读取或恢复离线副本。
