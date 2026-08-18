# E_COMPONENT_CLONE_UNSUPPORTED

具体的 `ComponentWithData` 子类没有显式实现 `clone()`，引擎无法安全推断其资源、TypedArray 或可变数据应共享还是复制。

为具体组件实现 `clone()`，并明确复制后的资源所有权。不要通过 JSON 或通用深拷贝绕过该错误，因为组件可能持有 GPU 资源、资源句柄或带身份的数据结构。
