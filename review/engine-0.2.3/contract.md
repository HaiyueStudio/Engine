# 0.2.3 冻结行为合同

本合同由 G01 接受，授权依据见 [ADR 0139](../../docs/for-ai/adr/0139-engine-023-gameplay-contracts.md)。[机器数值与符号](../../config/gameplay-023-contract.json)和[目标声明](api-contract.d.ts)是未来实现的约束，不是当前发布声明。仅本页保存行为结论；原始记录见 [验收入口](README.md)。

## API 与依赖

新 focused 入口 stable-on-integration；实现前不可在用户指南中作为已可用 API。新符号的准确名称、旧基线、目标数量和 owner 在机器合同中，声明保存准确参数、返回值和既有类型增量。Engine 根 30 项不变。实验 InputActionMap／mixer 具名提升采用同一原对象，原路径继续兼容；BrowserMultiplayerInput 等其他实验能力不自动提升。

scene-flow 只依赖 Engine core/scene/assets；character2d 只依赖物理与 ECS；camera2d 不带入 Box2D；input-actions 不创建轮询器；gui-collections、gui-controls、gui-layout 共用 Engine GUI，不能带入 3D、HYA、OpenType。game audio 只依赖 Engine audio，不带入 HYA/GUI。Tilemap 使用原 material、render 与生产 shader。G11 的实际 tarball 消费必须证明这些边界；不能用源码 tree-shaking 猜测安装结果。

## 流程、物理与输入

| 范围 | 固定语义 | 必验失败／边界 |
| --- | --- | --- |
| SceneFlow | create 返回全新场景时转移所有权；同一个 active、已拥有或已销毁 Scene 拒绝；最多一个 prepared；新 generation 使旧任务失效；默认并发 4，32 项生产／256 项压力 | factory 迟到返回仍销毁；逐请求 signal 与 flow signal 合并；失败释放全部新 owner；当前场景与借用常驻层保持；cancel仅取消pending，prepared.dispose在commit后幂等no-op，不销毁active；cancel/dispose幂等 |
| prepare/commit | 原Scene.load装载时先移除assign、暂存结果；全部load成功后按原请求序执行assign各一次，每次检查generation/signal，完成才ready；assign只操作暂存场景；commit 同步检查代次后调用原 switchScene | 原 loadMany 保持逐项 assign；新流程失败不承诺回滚任意应用外部副作用；应用不得在 assign 写旧场景或全局。提交钩子抛出时不发布 active 事件并恢复旧 active；无法恢复则明确 SceneInvalidState |
| 场景退役 | destroy-owned 默认只销毁 flow 先前提交且拥有的场景；原外部 active 不销毁；retain 把旧场景所有权交还调用方，不建无限注册表 | dispose 取消待提交并释放其句柄；已提交 active 的最终销毁归 engine/应用，不能在 flow dispose 后留下悬空 active |
| 固定时钟 | deltaMs→秒一次，有限正步长与正整数 maxSubSteps 在 world 分配前验证；原 clamp、子步顺序、触顶清零保持；暂停／复位无补跑 | 0/NaN/Infinity/负数参数拒绝，3D 原 RangeError 类型保持；无效构造零 world；before→原 step→接触→after，每个真实 tick 一次；插值只读不写物理 |
| 单位 | 原 Physics2DSystem 重力 render-unit/s²，默认 [0,-980]，100 render-unit/m；原速度 API m/s 不改变；新 character 速度 render-unit/s，sweep origin/translation/distance 为 render-unit | backend 一律 m、s、rad；normal 无量纲；px→m 只在 system/driver 边界一次；y 轴 up 默认 [0,1] |
| 真实扫掠 | box/circle，旋转静态目标、有限平移；先 broadphase 按 mask/sensor/exclude 过滤，再真形状查询；最早 fraction，等距按既有 body 稳定序号 | raw point 无效；TOI 距离 witness+目标 radius×normal；正常命中法线单位化；初始穿透小于 -slop 返回 overlap/null normal/null point；触碰的切向／离开不阻挡、向内阻挡；候选溢出报错不能截断 |
| 角色 | 借用同场景已有运动学 body，不能改动态体类型；setVelocity是调用方提供的render-unit/s运动速度，不暗中增加重力/跳跃状态机；safeMargin/floorSnap覆盖值也是render-unit；每tick一次移动／投影滑动，最多4次；坡角 45°，floorSnap 4 render-unit，skin=backend slop；落地/墙/平台在一次事务提交 | 高速薄墙、30/45/60°坡、台边、两形状、平台平移；durationSeconds默认0表示冻结目标；角色以原tick时长预测匀速运动学平台，relativeDelta=角色delta-平台velocity×dt，TOI接触点加回平台delta×fraction；broadphase补入原kinematic registry的扫过AABB候选，防止平台从查询框外进入；每tick carry一次；旋转／变形平台不承诺；初始穿透 stuck，不自动挤出；teleport、恢复重置前帧 |
| 相机 | 原 Camera2D/Transform2D；update 的 deltaMs 有限非负；damping 默认 8/s，指数平滑；deadZone 为世界单位宽高，bounds 限制中心；震屏 seeded、呈现偏移 | delta0 不前进；默认 seed0；reset 停止震屏并跳至目标；dispose 不销毁借用 camera；插值回调不强制物理依赖 |
| 动作 | keys 仍为布尔 +1；新增 keyboardAxes 负/正组，同按抵消；默认 MoveX 左/A=-1、右/D=+1，MoveY 上/W=-1、下/S=+1，与浏览器手柄轴一致 | 同一物理采样器与输入层；按键查询覆盖轴按键；动作合并取绝对值最大，平手沿原顺序，零不输出；保留不可变快照和旧 JSON |
| 重绑 | 原 map 借用；offer 接收已有设备快照，不加监听／存储；释放/回中后捕获下一按下，轴阈值 .5、回中 .15；negative/positive 捕获键盘方向或轴；冲突默认 reject，可显式 share/replace | profile format haiyue-input-profile/v1；先完整验证再原子替换，失败保持原 map；取消无变化；失焦/断连/模态交接原 owner 完成，无重复 down/up；存储复用应用既有 save |

## GUI 集合与复合控件

全部长度是逻辑 px。left/right 是物理图文顺序，RTL 不暗中交换；焦点仍按树序/既有规则。用户图像、页面内容、extra 与 row element 保留借用/拥有边界，不能复制 GUI/input 类身份。可序列化数据不包含回调、GPU、DOM、应用内容对象；恢复通过 stable key 和调用方重接内容，未知 key／重复 key／非法数值在提交前拒绝。

| 能力 | 行为与默认值 | 验证责任 |
| --- | --- | --- |
| 固定行集合 | 生产 1,000 逻辑项，诊断 10,000；28px 行高、560px 视口、每边 overscan2，完整对齐时最多24行；部分行可多1行但仍受256总上限；默认最多100,000逻辑项 | G07 稳定 key、可见/逻辑序分离、只重新绑定变化的窗口；滚动钳制；同帧变更一次有效结果；HYA 原 overscroll/carousel/限额不变 |
| 行复用 | createRow 返回新受集合管理 row，bind 返回解绑函数；解绑后再 bind；dispose 一次，集合不销毁调用方外部模型 | 移出编辑行前按原 host 确认或取消预编辑，释放 capture、拖放和旧监听；焦点记 key，跨窗导航滚入视口；删除焦点项选下一项，再前一项，再容器；嵌套树禁止循环/重复 key |
| 共享图文 | GuiStyle.iconPosition 默认 left，无 icon 的 gap=0；图像等比约束，padding/insets 缩放保持；right 把图标放内容区右侧，文字占左侧剩余区 | G10 共用 GuiContent 测量/绘制；iconPosition、尺寸、间距、字体/图像代次入缓存失效；颜色仅 paint；迟到图像监听先解除旧代次 |
| Tabs | 增强原 GuiTabPage：icon/iconPosition/iconSize/iconGap；setPageHeader按具名字段合并更新，显式icon:undefined清除页图标、未提供字段保持；旧 id/title/content/closable/hidden、切换/关闭 veto 和焦点历史兼容 | 左/右/无图标，缺省与旧纯文字一致；同页可左右混合；只 active 页参与布局/命中/绘制，借用页面不销毁 |
| Breadcrumb | 稳定 key，label/icon/position；默认分隔符 /，逐项 separator 覆盖；current 默认最后 enabled 项，当前与 disabled 不导航；显式currentKey=null表示无当前项；setItems保留有效current，否则回退 | 祖先鼠标/键盘/手柄确认回调一次，应用负责路由；一级可选 menu 复用 GuiElement/GuiButton与原焦点模态作用域，关闭恢复触发项焦点；菜单 key 全组件唯一，onNavigate 返回菜单 key；没有隐式网页历史 |
| Badge | count/dot/status；数值为非负安全整数，文本非空；count 默认 value0、showZero=false、overflow99，100显示99+；文本不参与数值溢出；dot 不依赖计数，status支持 default/processing/success/warning/error | 独立或附着借用 content，默认 top-right/offset[0,0]；setOptions按字段合并且先验证后提交；状态文本有可访问名称；装饰不获得焦点/命中，底层交互保持；processing 首版不强制动画，静态不要求帧 |
| Collapse | 稳定 key，默认多开/allclosed；accordion≤1，切换最多通知一次；toggleArea header 或 icon；extra 的独立操作消费事件不重复展开；expandIconPosition left默认 | 保留内容及其业务状态，闭合 display-none、零命中/绘制；关闭前焦点/IME 经原输入域转至标题，禁用不切换；setExpandedKeys默认notify=false，真实交互true；未知/重复key或accordion多key在变更前拒绝，禁用仅限制用户动作；回调keys按条目序只读；同状态不回调；嵌套/删除/重排/销毁 |

GuiBreadcrumb/Badge/Collapse 为组合控制器，element 仍是原 GuiElement，不是新 GUI 框架。可访问名称使用 label/title/statusText；button 等 action 复用原输入语义。不是完整 antd API 兼容实现，不引入 React/DOM/router。参考 [Breadcrumb](https://ant.design/components/breadcrumb/)、[Badge](https://ant.design/components/badge/)、[Collapse](https://ant.design/components/collapse/)。

## 地图与音频

| 范围 | 固定规则 | 拒绝或不承诺 |
| --- | --- | --- |
| Tilemap | 旧颜色与 cells Int16Array 身份不变；0空格，atlas正值为1-based tile；sourceWidth/Height与tile/margin/spacing显式；只借用 texture；one texture、nearest采样、预乘透明与原2D混合 | atlas尺寸≤4096，索引越界拒绝；无跨texture图集、自动瓦片、碰撞或导航生成；flip/90/180/270是单独枚举、不组合flag |
| 脏块 | 默认32²块，最多64 resident/可配置≤256；1,048,576 CPU cells上限仅本版 atlas/chunk 路径，旧纯色尺寸语义保持；setCell只标对应块，markDirty/更换cells/尺寸/图集全失效 | raw cells直接修改仍需markDirty；视口裁剪仅axis-aligned平面安全启用，其他保守全候选；工作/退役/缓存全计量，达到上限有界分批/直接绘制，不静默丢画面；shader改源及生成器 |
| GameAudio | 原mixer借用不dispose、不close context；默认128总/32owner，原最大1024不变；总线volume0..4，mute保留原配置；fade线性时间、update deltaMs一次；profile haiyue-game-audio/v1 | play仍用原request/startTick语义，不把tick解释为新音频时钟；HYA sample时钟不降级；dispose解绑发射器并只停止本wrapper记录的voice ID，不以owner批量误停外部声音；bindEmitter只管理通过本wrapper创建的channel |
| 2D声像 | listener/emitter回调render-unit，距离衰减 gain=base×max(0,1-distance/maxDistance)^attenuation，attenuation默认1；pan=clamp(dx/maxDistance×panStrength,-1,1)，默认strength1 | 无3DHRTF/效果器图/流媒体；getCapabilities在未建context时stereoPan=null，建成后显式bool；panner=false或尚未建context而为null时绑定发射器抛AudioCapabilityUnavailable，提示先resume再绑定，不把单声道退化算支持 |
| 宿主 | 支持AudioContext的浏览器真实立体声、解锁/暂停/后台恢复；原Native PCM bank是独立接口，不等于WebAudio | G09/G11物理iPhone记录实际WebAudio能力和受影响恢复；若缺失所需能力保留具名阻塞并提交有限宿主适配提案，不把未测或模拟算通过；本版不授权PCM伪装AudioContext |

## 验收与未实施项

工作负载、变更比例、有限资源、采样与设备使用机器合同。生产依旧60Hz、P95≤20ms、P99≤34ms、>50ms比例≤1%、连续≤2；预热起点按原配置是首个rendered frame，保留全部启动帧与两个完成帧readiness；禁止延后取样删掉坏帧。CPU微基准和headless原生参考只作诊断，不能顶替生产可见窗口采样。继承HUD layout/measure2ms、GUI4ms等适用限制；新功能没有随失败临时加出的CPU硬线。

所有能力仍待G02–G10实现。G11接收真实Windows IME/手柄、Mac与物理iPhone、包闭包、画质与资源，并做全局门禁/无发布演练。软件环境原300秒总时限保持，旧版例外不自动继承。哈希复核仅在既有ADR或新的明确具名批准内进行；改变运行时需重采受影响项。
