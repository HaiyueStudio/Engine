# E_AUDIO_CAPABILITY_UNAVAILABLE

当前宿主未提供本次音频操作需要的能力。2D 发射器要求原 mixer 的 `getCapabilities().stereoPan === true`；尚未建立 AudioContext 时为 `null`，建立后返回实际布尔值。

先在用户手势中调用原 mixer 的 `resume()`／`unlock()`，再检查能力和绑定发射器。缺少 StereoPanner 的宿主不能以单声道回退冒充立体声支持。Engine 与 extensions 必须使用配套的 0.2.3 候选包；游戏层借用原 mixer，不关闭或重新创建它的 AudioContext。
