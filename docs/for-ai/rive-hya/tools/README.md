# Census tools

`generate-census.mjs` 从 G01 冻结的官方 `rive-runtime` source tree 读取：

- `include/rive/generated/core_registry.hpp` 中可实例化 object type 与 property dispatch；
- `include/rive/generated/**/*_base.hpp` 中数值 key、继承和声明 owner；
- `src/lua/**/*.{cpp,mm}` 中 `luaopen_*`、`luaL_Reg` 与 global 注册符号。

运行方式：

```powershell
node docs/for-ai/rive-hya/tools/generate-census.mjs <rive-runtime-source> docs/for-ai/rive-hya/runtime-census.json
```

生成器按数值 key 和名称稳定排序，不写时间戳。object/property/script 任一条目缺少 family、Goal、diagnostic 或 fixture owner 时命令失败；重复 key 同样失败。输出的 `source.inputDigestSha256` 必须与 [compatibility tuple](../compatibility-tuple.json) 对应的 source 重现结果一致。

`CoreRegistry` 的 generated case label 可能在 `Base::` 后换行；生成器将该空白视为同一 token boundary。ADR 0088 修正后的 frozen totals 为 288 objects / 618 properties，且 verifier 会核对 7 个曾被单行正则漏记的 property key。

ADR 0089 后生成器还会从 generated `deserialize` case 机械标注 property binary eligibility：source census 保持 618，binary property denominator 为 565；asset source census 为 14，binary asset denominator 为 9。Lua module/symbol 标为 behavioral capability，不进入 `.riv` wire-key uncovered count。

G01 状态更新后运行：

```powershell
node docs/for-ai/rive-hya/tools/verify-contracts.mjs
```

该 verifier 交叉检查 tuple/source、census totals/unique keys/ownership/diagnostics、ADR 状态、corpus/deny-list 和 M07 的 G01/G02 机器状态。
