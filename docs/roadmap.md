# LocalIM @ LAN — Roadmap

目标：把"可运行架构骨架"推进到"三平台可用的局域网聊天+远程"。

## 阶段 0 —— 骨架（当前）
- [x] 协议契约 `protocol/schema.json`（增补细节以它为准）
- [x] WebUI（Vite+TS）登录/roster/chat/composer/media 视图，`tsc + vite build` 通过
- [x] native daemon：`Daemon` 编排 + `WsHub(7615/7617)` 握手/帧 + `identity`
- [x] discovery：`lan_heartbeat` 多播 + `relay_client` 中继（跨网段）
- [x] session：`peer_registry` 在线表 + `room_manager` 群
- [x] transport：`file_transfer` 元数据账本
- [x] remote：`remote_control` + `input_injector` 三平台（win/mac/linux）
- [x] `native/BUILD.gn` + `src/localim` 挂载 + 根 `gn_all` 登记，GN 解析通过
- [x] 三平台构建脚本（`scripts/`：build_localim_win.ps1 / build_localim_unix.sh）——Windows 已实编出 `localim_daemon.exe`
- [x] dev 守护进程（`dev/daemon/daemon.mjs` node 协议子集）——已修掩码/长帧解析，原生与真实客户端均验证通过

**已完成（2026-09，Windows 实测）**：`localim_daemon` 编译+启动+三端口监听（7615/7616/7617），
WebUI↔daemon WS 全链路冒烟通过（identity/roster/room/message/discovery + 错误信封 + 事件回声）；
dev 模式连带 WebUI 静态托管可用。UDP 组播接收已修复（bind 0.0.0.0:port + JoinGroup）。

**2026-09 追加（单机双实例 A→B 文字单聊端到端打通）**：
两台实例（A: 7615/7617，B: 9165/9167，共享组播 7616）局域网互相发现 ✓，
A 拨号 B:9167 并以 WS 客户端握手，把文字消息作为 `message.relay` 中继到 B，
B 解析入站并广播 `message.chat` 到其 WebUI 订阅 ✓。连续 3 次不重启全部成功（3/3）。
排障中修复 4 个根因：
1. **静默订阅收不到广播**——`client_port_` 原仅在客户端发首条消息时登记；新增
   `WsHub::set_on_connect`，连接建立即按来源端口登记。
2. **拨号补发漏包 relay 信封**——`SendPeerMessage` 复用路径发含 `message.relay` 信封，
   但拨号后补发路径发的是**裸 pkt**，对端解不出信封而丢弃；现统一先构造信封再存
   `pending_out_`，两条路径发同一信封。
3. **ws_hub 单 accept 卡死**——peer 端口一次只持有一个待握手 socket，残留连接阻塞
   后续 accept；重写为**每端口多并发握手**（`PendingHandshake` 队列 + 持续 accept）。
4. **背靠背包丢失**——首次拨号时握手 GET 与 relay 帧可能一并到达，读握手后丢弃
   `\r\n\r\n` 之后字节；新增 `WsConnection::StartReadingWith` 把这些余帧注入读队列。

**2026-09 消息账本（重启可回看）**：
新增 `MessageStore`（`core/session/message_store.*`），JSONL 追加写 `<user-data-dir>/messages.jsonl`，
启动即载入内存。`message.send`（出向）、`message.relay` 入站都归一落库，按 `conv` 会话键
（单聊=对方 deviceId，群聊=roomId）组织，`(conv, nonce)` 去重防回显/重传重复。
`message.history {to, kind, limit}` 返回最近 limit 条（旧->新）。WebUI 进入会话时经
`native.loadHistory` 拉取并按 nonce 合并。顺带修正收/发双边 `from` 与会话键不一致：
单聊消息统一挂在"对方 deviceId"线程下（此前入站 `to` 落错键）。
**Windows 实测（2026-09）**：`message.history` 落库 3→重启回看仍 3→追加 2→累计 5→
同 nonce 重发去重仍 5，全部通过。

## 阶段 1 —— 端到端可用（三平台可跑）
- [x] `scripts/`：win/mac/linux 构建脚本，产出可执行（win 已验证；mac/linux 待真机）
- [x] `dev/daemon`：node 版协议子集守护进程，喂 UI 联调（详见 docs/usage.md §5）
- [x] `scripts/dev.mjs` + dev daemon 内嵌服务 WebUI 静态目录（out/webui）
- [ ] 端到端：两台真机同网段互相发现 + 收发文字/图片（需两台机器实测）
- [x] 消息落库（JSONL 账本 `messages.jsonl`，`message.history` 重启可回看）——见 **2026-09 消息账本**
- [x] native daemon 直接托管 WebUI（`--webui-dist` 指向 ui/out/webui，HTTP 7619；
      内置 `WebServer`（`core/webserver.*`）基于 `net::HttpServer` 静态托管，
      默认 index、MIME 映射、404、路径穿越防御）

## 阶段 2 —— 媒体 / 远程
- [x] WebRTC offer/answer/ice 经守护进程信令中继打通（daemon 中继信封 + 前端 RTCPeerConnection 接线）
- [x] 文件分片（data channel fmeta+fhead+分片上传下载 + 接收端重组 + 进度事件）
- [x] 语音通话（mic → PeerConnection，被叫接听回调卷 + 双向音频端到端打通）
- [x] 视频通话（camera → PeerConnection → 对端 PiP 渲染）
- [x] 共享桌面（getDisplayMedia → track → PeerConnection → 观众渲染）
- [x] 远程控制（观众渲染 + data channel 回传输入 → 被控端 daemon input_injector 注入系统）

**2026-09 追加（文件分片端到端打通，真机双 Edge 实例 CDP 验证 3/3）**：
A/B 两个 daemon 各托管独立 WebUI，用 Edge `--headless=new` + CDP 驱动两页：
登录(identity.hello)→A 页 `sendFileTo` 256KiB 二进制→A 建 data channel 发起 offer，
`SendPeerSignal` 中继 offer/answer/ice→P2P data channel 建立(A createDataChannel / B ondatachannel)，
A 依次发 `fmeta`(元数据)+`fhead`+分片(1MiB 分片、setTimeout 整形防洪)→B 端 `onChannelMessage`
按 fileId 重组、`finishReceive` 产出 Blob objectURL、`pushReceivedFile` 挂进会话内联/可下载 ✓（3/3）。
排障修复 2 个根因：
5. **WebUI 登录后在线表为空**——daemon 只在 peer **新上线**时广播 `peer_found`，不重放既有
   roster；node 探针靠多次 `scan_ping` 维持而 WebUI 只 `scan_start` 一次。新增
   `native.loadRoster()`（identity.hello 后调 `roster.list` 填充），登录即拉一次在线表。
6. **`(Object as any).globalThis.__localim` 挂了**——TS 编译为 `Object.globalThis`(undefined) 抛错，
   应写 `(globalThis as any).__localim`；修复后 CDP 驱动才能注入调用。

**2026-09 追加（WebRTC 信令中继闭环）**：
单机双实例 A/B 互发现后，A 的 WebUI 经守护进程发 `media.offer/ice`（`SendPeerSignal`
包成 `media.relay` 信封按 `to` 拨号转发），对端 daemon `HandleInboundMediaSignal`
拆信封并以 innerM(offer/answer/ice) 广播为 `media` 事件给其 WebUI；B 回 `media.answer`
反向拨号回到 A。A→B offer/ice 与 B→A answer 双向全部送达对端 WebUI ✓（`scripts/ws_e2e_media.mjs`）。
信令中继与既有消息中继共用同一个拨号/复用连接内核（`SendPeerEnvelope`），innerNs/innerM
标内层命名空间供收端路由；数据面仍由 WebUI 侧 RTCPeerConnection 承载。

**2026-09 追加（语音通话端到端打通，双 Edge 实例 CDP 验证 3/3 通过）**：
头无 Edge + `--use-fake-ui-for-media-stream` `--use-fake-device-for-media-stream` 双实例。
A 页 `startCall(deviceId,'voice')` 采集假麦克风→`addTrackFrom`→信令中继发起（call_invite→offer→answer→ice）→
B 页 `acceptIncomingCall` 采集本端麦克风补进会话应答；断言两端 `connectionState/iceConnectionState == connected`
且收发各有 `audio` 轨道（`scripts/drv_voice_e2e.mjs`，注入全局 `acceptIncomingCall/mediaDebug/hangupDebug/debugPcs`）。3 次均 PASS。
排障修复 3 个根因：
7. **被叫应答逻辑守卫反了**——`acceptIncomingCall` 原以 `signalingState !== 'stable'` 才应答；
   offer 先到被暂存 `pendingOffer` 时状态仍是 `stable`，导致永远不会应答。改为 `pendingOffer` 命中即答，
   并让会话对端取 `call_invite` 携带的 `from`（发起方 id），避免 offer 未到前建会话误用本端 id 致应答 `to` 错。
8. **trickle ICE 竞态丢候选**——offerer 的候选在对端 `setRemoteDescription` 之前到达即被 `addIceCandidate`
   抛错静默丢弃，被叫 ICE 永不连上。`PeerSession` 新增 `iceQueue`：远端描述未就绪先暂存，
   `setRemoteDescription` 后 `flushIce()` 补灌再应答。
9. **双实例 multicast 端口共享**——daemon 只向"自己 presence 端口"的组播组发声；同机两台若要互发现，
   必须共享同一 presence 端口(7616，缺省)而仅 webui/peer 端口区分。

**2026-09 追加（文件传输增强：进度 / SHA256 校验 / 取消 / 持久化，双 Edge CDP 验证 4 阶段全 PASS）**：
`scripts/drv_file_enh_e2e.mjs`：阶段1 A 发 16MiB 观察 `sending` 进度→`done`，B 重组后 `sha256Ok=true` 且有下载 URL；
阶段2 A 发 128MiB 约 250ms 后 `cancelFileByFileId`，采样见 `sending→canceled`，A/B 双方卡均 `canceled`；
阶段3 重载 B 页面后 `loadHistory` 仍能从历史回看文件消息（带 `fileId`）。状态机集中在 `ui/src/client/xfer.ts`，
文件卡渲染 `ui/src/views/chat.ts renderFileCard`（进度条/下载入口/内联预览/失败/取消态）。
排障修复要点：
10. **SCTP 单消息上限**——1MiB 分片超 Chromium 缺省 256KB 上限被静默丢弃；改为 64KB 分片且
    `dc.send` 包 try/catch（`sendFile(meta,blob,chunk=1<<16)`）。
11. **文件 offer 需自动应答**——纯数据面 offer 无来电流程，不自动 `setRemoteDescription` 会一直停留
    `connecting`；`media.offer` 带 `fileSignaling:true` 标记，收到即自动应答。
12. **二进制载荷统一**——data channel `binaryType` 缺省为 Blob 导致 `instanceof ArrayBuffer` 判定失败；
    `onChannelOpen` 显式置 `ch.binaryType='arraybuffer'` 后接收端按 ArrayBuffer 收敛。
13. **data channel 中断标记失败**——`onclose` 时若活动文件未收满则 `failReceive`，避免卡在接收中。
14. **发送取消状态机**——取消由发送方分片循环在切片边界 `sendCanceled` 命中后先发 `fend(reason=canceled)`
    再本地 `cancelSend`；接收方收到 fend 亦转 canceled，两侧相位终态一致。

**2026-09 追加（视频通话 + 共享桌面端到端打通，`scripts/drv_video_share_e2e.mjs`）**：
阶段1 视频：A `startCall(b,'video')`（伪摄像头）→ B `acceptIncomingCall` → 两端 PeerConnection `connected`
且收发各有 `audio+video` 轨道，媒体浮层 `.vid.main`(远端)/`.vid.local`(本地 PiP) 绑上真实流（`videoWidth` 非 0）。
阶段2 共享：A `startCall(b,'share')` 用 `getDisplayMedia` 采集屏幕 → B 应答 → B(观众)收到远端 `video`
轨道并渲染 `.vid.main`(800×)，A(主播)本地屏幕流渲染主画面。媒体流集中登记在
`ui/src/client/webrtc.ts` 的 `localStreams/remoteStreams` 注册表并对外暴露 `sessionStreams/onStreamsChange`，
`ui/src/views/media.ts` 据此绑定 `<video>`；装饰类聚在 `app.css`（共享近全屏、视频 PiP、语音脉冲指示、无流占位）。
排障根因：
15. **共享桌面 B 收不到画面**——测试/真实用户在 offer 抵达前抢先接听：`acceptIncomingCall` 读到
    `pendingOffer` 为空则产生不了 answer，而稍后 offer 到达时 offer 处理器只是暂存进 `pendingOffer`
    却已无人消费 → 主叫 A 永久卡在 `checking`。新增 `armedAnswer`（接听时若 offer 未到先上弹匣，
    offer 处理器命中即自动补应答）；测试侧同时等 `mediaDebug()` 出现该 callId（offer 已到）再接听。
16. **共享主播 headless 噪音**——`getDisplayMedia` 在无头环境带 `requestAudio` 会抛错，屏幕采集仅 `{ video: true }`
    （音频回传留给远程控制通道自理）。

**2026-09 追加（远程控制端到端打通，`scripts/drv_remote_control_e2e.mjs`）**：
宿主 A `startCall(b,'remote')` 共享屏幕且作为 offerer 开设 data channel，并 `media.remote_host` 武装本机注入器；
操控端 B 接听渲染 A 屏幕，media.ts 的远程面板把鼠标/键盘/滚轮（坐标按视频显示尺寸/源分辨率比例换算回被控端像素）
经 `sendRemoteInput`（`PeerSession.sendInput`）→ data channel → A 的 `onChannelMessage` 收到 `{t:'input'}` →
转发本机 daemon `media.remote_input` → `RemoteControl::HandleInput` → 平台 `input_injector`(SendInput) 落真实系统输入。
被控 daemon 日志 `media.remote_input ... hosted=1 injected=1` 确认注入。坐标/事件 6 类（mousemove/mousedown/mouseup/
keydown/keyup/wheel）全量回传验证通过。排障要点：
17. **remote_input 原本被当中继转发**——daemon 的 `media.*` 一律按 `to` 中继给对端，被控端 WebUI 把输入发本机 daemon
    走的是中继而非注入；在 `media` 分支特判 `remote_input`（本机注入不中继）与 `remote_host`（武装 `hosting_`）。
18. **offerer(被控) 需主动开 data channel**——远程输入回传通道由宿主创建（`createDataChannel`），操控端经
    `ondatachannel` 获得同通道；`acceptIncomingCall` 不采集（观众纯应答）。
19. **SendInput 绝对坐标**——`MOUSEEVENTF_ABSOLUTE` 用 0-65535 归一化而非像素，`input_injector_win.cc` 由像素按
    虚拟屏幕尺寸换算绝对坐标（含多显示器边界）。

**2026-09 追加（群聊模式端到端打通，`scripts/drv_group_e2e.mjs` 全 PASS）**：
双 daemon + 双无头 Edge。A(Alice) `room.create` 生成 roomId → `room.invite(Bob)` 经 peer 信封(ns=room)
把完整群信息(完整成员表)直达 B → B 本地 `RoomManager::Upsert` 导入成员表 + WebUI 弹出群；
其后 A 发 `message.send{kind:'room'}` 由 daemon 按已同步成员表 mesh 众发在线成员，端侧以 `roomId` 为会话键
挂群线程；B 回一条 → A 也收到；A `loadHistory(roomId,'room')` 回看双向消息。排障要点：
20. **rand 碰撞/组播发现**——首次 invite 时对端 peer 连接未建立，`SendPeerEnvelope` 返回 rv=-1 掉包；
    e2e 先经 data channel 传一次 64KB 文件预热，复用 outgoing 连接后再做群操作。
21. **`base::ListValue` 迭代**——`list->GetList()` 不存在，遍历改 range-based for 直接 `*list`。
22. **message 语义字段**——群消息身份读 `channel` 缺省回落 `kind`；统一 `kind==room` 判定广播。
23. **建群/邀请 UI 刷新**——`room.create` 后 `EmitRoomEvent("joined")`、`invite/kick` 后 `EmitRoomEvent("sync")`
    让房主本端成员表/群列表即时一致；远端靠 invited/sync/member_* 事件增量更新。

**2026-09 追加（群共享桌面端到端打通，`scripts/drv_group_share_e2e.mjs` 全 PASS）**：
host-driven 广播：三 daemon(房主 A + 观众 B/C) + 三无头 Edge。预热 → A `room.create`+`invite(B,C)` →
A `startRoomShare(roomId)` 用 `getDisplayMedia` 采集屏幕，向**每个在线成员各建一条独立 `PeerSession`**
（各自 `callId`、`roomShareByCallId` 索引；以 `app.state.peers.has(m)` 滤除自己与离线成员）→
B/C 各收到 `media.call_invite`(share) 振铃浮层 → `acceptIncomingCall`（观众无采集纯应答）→
两端 PeerConnection `connected` 且 B/C `.vid.main` 绑上 A 远端视频流（`videoWidth>0`）；A 本端以 roomId
作 callId 预览自己屏幕，`viewerCount=2`。`endRoomShare` 挂断全部观众会话并停采，B/C 浮层消失。
`call_hangup` 特判：观众断连只摘除该观众会话，全部观众走净才结束整场共享。
排障要点：
24. **首条 media.call_invite 看似丢失实为 UI 未动**——一开始 B/C 的 `app.state.media` 始终为 null、
    观众不接听、A 的共享会话卡 `have-local-offer`；实为旧构建缓存 + 时序抖动（daemon 已把
    offer/call_invite 转发到 WebUI，但页面处理滞后）。在 `native_client` 增加 `evlog`（原始事件信封
    缓存，`window.__localim.native.evlog`）用于核对 daemon 是否送达、字段是否齐全（callId/from/mode），
    重建后三实例稳定通过。

**2026-09 追加（群共享增强：音频同步 + 成员控制，`scripts/drv_group_share_e2e.mjs` 扩展后全 PASS ×2）**：
33. **音视频同步采集**——`getShareStream()` 优先 `getDisplayMedia({video,audio})`，采集失败回退纯画面；
    群共享与 1:1 share 共用，无头测试环境也能产出 `audio`+`video` 双轨（`localTracks` 断言通过）。remote
    （输入控制）保持纯画面。
34. **成员控制（谁可停共享，房主裁决）**——观众仅能 `requestRoomShareStop(roomId)` 经 daemon 中继发
    `media.room_share_stop_request` 给共享发起方；房主浮层 `shareReq` 亮出待办，可 `resolveRoomShareStopRequest`
    （同意→`endRoomShare` 整场停 / 忽略→`room_share_stop_ack{approved:false}`）。房主另有
    `endRoomShareViewer(roomId, memberId)` 只挂断指定观众（其余观众与整场不受影响；观众被清空才结束）。
    浮层 UI：房主 `renderRoomShareBar` 列出观众并可逐个踢出；观众侧加「请求结束共享」按钮。

**2026-09 追加（离线消息投递端到端打通，`scripts/drv_offline_msg_e2e.mjs` 全 PASS）**：
单聊对端不在线时，`message.send` 不再静默丢弃而是按设备入 `offline_q_`（`daemon.cc`，FIFO 上限
`kOfflineQueueCap`）；对方（重新）上线触达 `OnLanPeer`/`OnRelayEvent` 时 `MaybeRedeliver` →
已连接则 `FlushQueue` 整队补投，否则 `EnsureConnection` 拨号成功后补投。收端回 `message.ack`
（`SendMessageAck`）→ 发送端 WebUI 把该消息 `status` 翻转为 `delivered`（chat.ts 显示「已送达」）。
`drv_offline_msg_e2e.mjs`：A 发文本时 B 已下线 → daemon log `offline queued` → 重启 B（同数据目录，
`profile.json` 持久化 deviceId 保证离线队列按键可命中）→ 自动补投 → B 经 `loadHistory` 落库可回看 →
A 侧全会话按 nonce 扫描到 `delivered`。排障要点：
35. **送达回执需要知道对方地址**——对端刚重启/尚无 presence 条目时回执拨号会因「无对端地址」发不出。
    `SendPeerEnvelope` 统一携带发送方 `fromHost`/`fromPort`，收端 `OnHubMessage` 据此即时 `Upsert` 进
    `peers_`，回执即可对刚上线对端立即拨号回来（不再依赖 presence 心跳时序）。
36. **WebUI 会话键与 daemon id 不一致**——`message.send` 回显将 `from` 置为 daemon deviceId（非 WebUI
    localStorage 生成的 self id），发送消息落在发送方 daemon id 键下；前端不回显不落库、仅作展示，测试对
    发送态须按 nonce **全会话扫描**而非 `conversations.get(对端id)`。

## 阶段 3 —— 群聊与中继增强
- [x] 群 mesh：房主广播/成员订阅，离线次级接替（离线次级接替仍为后续优化）
- [x] relay 服务端（独立小服务 `localim_relay`）多网关注册与路由表
- [x] 群聊共享桌面（media 目标为 roomId；房主一人采集屏幕向每在线成员各自独立通道广播）

**2026-09 追加（跨网段中继服务端到端打通，`scripts/drv_relay_e2e.mjs` 四阶段全 PASS）**：
新增独立小服务 `localim_relay`（`core/discovery/relay_server.*` + `app/relay_main.cc`，复用
`WsConnection` 握手/帧编解码），维护 `deviceId -> client` 路由表，注册时向同联其它客户端广播
`peer_online` 事件、断连广播 `peer_offline`。daemon 新增 `--relay-host`/`--relay-port`（缺省
`127.0.0.1:7618`），`RelayClient` 注册本机身份并消费在线/离线事件落入 `peers_`（roster）。
e2e 起本地 relay(7718) + 两台**不同 presence 端口**的 daemon（各自独立网段语义、无局域网组播互发现），
两实例仅经共享 relay 互发现（`peer.via='relay'`），随后直拨对端 peer 端口收发文字双向互达，
停 B 后 relay 注销并广播 offline，A 侧 `loadRoster` 移除该 peer。排障要点：
25. **握手同批到达的帧立即解析**——`WsConnection::StartReadingWith` 把握手余帧注入读队列并即时
    `TryParse`，否则要等下一次 socket 读才触发，注册响应/首个 peer_online 延迟。
26. **客户端侧剥离 HTTP 101 应答**——`RelayClient::OnRecv` 在 `handshaken_` 前先剥掉 `\r\n\r\n`
    之前的握手应答，防止握手尾字节被当帧体解析。
27. **`roster.list` 需整体替换**（`native_client.loadRoster`）——按新 roster 重建 `peers` Map 而非合并，
    否则下线 peer 因旧条目残留而无法从 WebUI 在线表移除（阶段4 离线检测依赖于此）。

**2026-09 追加（断点续传端到端打通，`scripts/drv_resume_e2e.mjs` 全 PASS + 取消回归 `drv_file_enh_e2e.mjs` PASS）**：
64MiB 文件传输中途 `interruptFile` 静默中断（保留源与进度），随后 `resumeFile` 重开会话并经
`fresume`/`fresume_ack` 控制帧向对端询问已收连续字节，发送端据此从 `Math.ceil(got/chunk)` 只补发缺失块——
e2e 断言续传起点 `sndFrom>0` 且接收端累计 `recvBytes==size`（证明已收块没有重复传输）。实现要点：
28. **接收端持久化分片**（`persistRecv: Map<fileId, RecvState>`）——已收分片按 `chunkIndex` 落位、跨会话保留；
    中断/断连不清，通道重建后同 fileId+size 的 `fmeta` 复用同一 `RecvState` 继续拼接。
29. **发送端保留源与进度**（`sendState: Map<fileId, SendState>`）——interrupt 只置 `sendCanceled+interruptSilent`，
    不删源、不发 fend；续传用原 `blob`/`chunk`，`native_client` 暴露 `canResumeFile` 决定卡片是否显示「续传」。
30. **续传协商需等通道 open**——`resumeFile` 先 `waitDcOpen` 再发 `fresume`（connecting 状态 send 抛异常致
    协商 Promise 直接 reject）；`resumeAndSend` 带超时回落 `got=0`（对端无记录则全量从 0 重传）。
31. **发送中断/取消分支修正**（`sendFile.stop`）——原 `if(...); else` 因中间插入日志语句成为非法语法且语义错乱；
    现明确两分支：`interruptSilent` 走 `failReceive`（卡片标「传输中断」+续传按钮，清不源），否则发
    `fend(canceled)` + `cancelSend` + `sendState.delete`（不可续传），两侧相位终态一致。
32. **背压等待可中断**——`bufferedAmount>CHUNK*16` 时等 `bufferedamountlow`，等待中每 30ms 探测
    `sendCanceled`/`readyState` 及时放行到 `stop()`，否则取消/断连会卡死在背压 Promise 里。

## 阶段 4 —— 打磨
- [x] 断点续传（接收端已收分片跨会话保留，发送端经 `fresume` 协商断点只补缺失块）
- [x] 离线消息（离线按设备入队 / 上线补投 / `message.ack` 送达回执 → WebUI「已送达」）
- [x] 消息加密（`--psk` 预共享口令 → HKDF 派生子钥；文字 `body` 走 AES-256-GCM 机密+认证，peer 信封整体 HMAC-SHA256 签名 + 时间窗 + nonce 防重放；缺省明文保持兼容）
- [ ] 自动升级、开机自启、托盘
- [ ] 多网卡/多网段智能选路

## 决策记录
- 与 arupa/nomad **完全隔离**，只依赖 `chromium/src` 内组件（用户硬约束）。
- 跨网段用 **网关注册 + 引导中继**（用户选定）。
- 远程桌面用 **WebRTC 自研瘦客户端**（用户选定），不为它引入 chromium 的 remoting host。
- 骨架内媒体/文件的数据面由 WebUI WebRTC 承载；守护进程只信令、不搬运字节。
- 消息加密强度选 **AES-GCM 机密+认证**（对内容保密兼认证），密钥来源选 **局域网预共享口令 PSK**（`--psk` 注入，
  仅存于 daemon 不进 WS 链路）；子密钥经 HKDF-SHA256 派生（enc 用于 AES-GCM、mac 用于信封 HMAC，两钥分离）。
  信封签名覆盖除 ts/nonce/sig 外的规范化整帧，附带时间窗（±2min）与 (fromId|nonce) 防重放。