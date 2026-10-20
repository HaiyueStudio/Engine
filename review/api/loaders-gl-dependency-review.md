# loaders.gl：问题、方法、结论

| 问题 | 方法 | 结论 |
| --- | --- | --- |
| caret范围让新消费者解析到当时不存在的worker-utils版本，独立安装报ETARGET | 将schema、worker-utils、textures固定4.4.4，并显式声明core4.4.4，避免peer自动选入不同patch；同步npm锁元数据 | 原独立全新安装、真实tarball消费通过；不是升级已安装版本，也不扩大其他依赖范围 |

现行值以[Engine manifest](../../engine/package.json)及[仓库锁文件](../../package-lock.json)为准。原检查仅证明当时注册表与冻结包集，不外推为未来上游可用性；重新发布仍需完整包消费。第一次安装与peer修正过程见[校验归档](../archive/engine-review-process-20261020.json)。
