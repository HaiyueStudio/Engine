# G04 视觉小说播放界面

`ReadingPlayback` 连接已编译的行表、既有 NarrativeRuntime 和 I18n。用宿主的场景帧更新调用 `tick(deltaMs)`。使用 `GuiReading` 将界面挂到已有 GuiRoot 和 GuiSystem，键鼠及已绑定的手柄沿用该输入域。调用 `setInsets` 接入宿主安全区。宿主在退出时销毁播放会话，也可以用 AbortSignal 提前卸载界面。

字速为每秒字素数，零表示即时显示。确认键先显全当前行，再由下一次确认推进。自动播放等待完整文字、最短阅读时间和当前行配音。快进只处理已读对白，遇到新对白、选项或演出动作立即交回手动模式。播放器可以接收持久已读集合，读取和写入由宿主存档层接管。阅读设置有带版本的存储适配器，舞台动作读取当前的 `reducedMotion` 设置。

行内保留完整 Unicode 字素。界面借用 GUI 字形度量预排完整行，再逐步更新同一批标签。设置和历史菜单使用原有模态焦点恢复。长历史保留有界逻辑记录，滚动复用可见行；选中记录可查看全文并按当前语言重听。

`ReadingAudio` 在既有 GameAudio 和 OwnerSafeAudioMixer 上使用独立语音租约。配音资源解析器返回已登记的缓冲区和释放函数。将当前场景的音乐 voice ID 传入 `setMusicVoice` 后，配音只临时压低这条音乐。调音量、替换音乐、结束、关菜单、切行或进入后台时，都以当前设置重新合成音量。共享音频上下文的解锁和应用级暂停仍由宿主管理。

```sh
npm run build -w ./engine
node --test extensions/test/visual-novel-ui.test.mjs extensions/test/visual-novel-audio.test.mjs engine/test/owner-safe-audio-upgrade.test.mjs
node scripts/fixtures/visual-novel-ui/run.mjs g04-native
```

浏览器夹具记录原生 GPU 界面、自动化键鼠、长历史、静音 Web Audio 增益和资源所有权。物理键鼠／听音及发布候选资格由 G07 验证。
