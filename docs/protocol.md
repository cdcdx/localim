# LocalIM @ LAN — 协议

> **唯一事实源是 [protocol/schema.json](../protocol/schema.json)**。本文是人话版导航，
> 字段与示例以 schema.json 为准，任何不一致以 schema.json 胜出。

## 1. 信封（envelope）

所有信令都是 JSON 文本帧，`dir ∈ {req, res, ev}`。

```jsonc
// 请求（WebUI → daemon）
{ "v":1, "txn":"t-1", "dir":"req", "ns":"message", "m":"send",
  "d": { "to":"node-2", "type":"text", "kind":"chat", "body":"hello" } }
// 响应（daemon → WebUI）
{ "v":1, "txn":"t-1", "dir":"res", "ns":"message", "m":"send",
  "ok":true, "d": { "seq": 12 } }
// 事件（daemon → WebUI / 对端）
{ "v":1, "dir":"ev", "ns":"presence", "m":"peer_online",
  "d": { "deviceId":"node-2", "name":"tax-2", "addr":"192.168.1.22" } }
```

错误响应：`ok:false`，`d: {code, msg}`（`-32600` 参数错 / `-32601` 方法不存在 / `-32001` 找不到对象）。

## 2. 命名空间与方法

| ns  | 方法(req) | 事件(ev) | 说明 |
| --- | --- | --- | --- |
| identity | hello, set_profile | – | 身份握手、改名 |
| discovery | scan_start, scan_stop | peer_found, peer_lost, segment_dirty | 扫描控制与发现事件 |
| roster | list | peer_ready | 在线设备快照 |
| message | send, history | chat | 单聊/群聊消息 |
| room | create, join, leave, invite, kick, members, exit | joined, left, invited, member_joined, member_left, room_message, room_sync | 自建群组 |
| media | call_invite…remote_input | call, media | 音视频/共享/远程信令 |
| file | transfer_begin, transfer_ack, transfer_cancel | transfer_status | 文件分片元数据 |
| profile | get, update | – | 本机资料 |

## 3. 发现协议

- **同网段**：多播组 `239.255.0.16:7616`，端点周期广播
  `{deviceId,name,platform,version,host,port,addrs:[{ip,prefix,if}]}`。
  `addrs` 为本机**全部**非回环 IPv4 网卡（多网卡机器多条）；多播**每块网卡各发一份**，
  收端回调同时给出这份 presence 的**源地址**（该源地址在本网段必达，选路时优先）。
  收到对端广播 → `Upsert(PeerRecord)` → `discovery.peer_found(*peer)`。
- **跨网段**：`relay_client` 连 `relay:7618`，先发 `{op:"register", deviceId, host, port, addrs}`，
  再收 `{op:"peer_online"|"peer_offline", …}` 事件，汇入同一 `PeerRegistry`；
  relay 原样透传 `addrs`（接受 `[ip]` 或 `[{ip,…}]` 两种写法，归一为字符串数组）。

Peer 去重：以 `deviceId` + `via(lan|relay)` 为键；同一设备多网卡/多 via 留多条目。

### 3.1 智能选路（多网卡 / 多网段）

候选地址来自：`addrs`（对端公告 + 历史听到）+ 组播源地址 + `host`。排序规则：

| 优先级 | 条件 |
| --- | --- |
| 0 | 与本机某块网卡**同子网**（前缀比较，无需跨路由） |
| 1 | 私网其它网段（10/8、172.16/12、192.168/16、100.64/10） |
| 2 | 链路本地 169.254/16 |
| 3 | 公网 / 其它 |
| 5 | 回环（仅单机双实例调试兜底） |

拨号按该顺序**逐个尝试**：上一个失败自动换下一个（日志 `SendPeer: dial … (cand i/n)`），
全部失败才丢弃待发帧；拨通的地址记为本机优选路由，后续优先复用。
网卡增删（VPN/Wi-Fi 切换）时刷新快照，重建每网卡组播 socket 并重发 presence 与 relay 注册。

## 4. 消息与历史

- **发送/落库**：`message.send` 收到即本地回显 `message.chat` 事件并入账本
  `<user-data-dir>/messages.jsonl`（JSONL 单行一条）。对端经 `message.relay` 送达，
  收端入站同样入账本并转回 `message.chat`。统一带 `from`/`direction(in|out)`。
- **会话键**：单聊以"对方 deviceId"为键（收发都在同一条线程下），群聊以 `roomId` 为键。
- **回看**：`message.history` `{to: 对方deviceId|roomId, kind, limit?}` → `{items:[旧->新], cursor}`，
  重启 daemon 后仍可查询。

## 5. 媒体信令

- `media.offer/answer/ice`：SDP / ICE 经 daemon 中继到对端；实际媒体走 P2P。
- `media.remote_input`：`{t,x,y,btn,code,d}`，被控端 `remote_control` 转发到
  `input_injector`（Win SendInput / macOS CoreGraphics / Linux XTest）。
- `media.share_start/stop`：触发 `getDisplayMedia`，流经 `RTCPeerConnection`。

## 5. 文件

信令面：`file.transfer_begin` 专注元数据，`transfer_ack` 确认完成，`transfer_cancel` 取消。
数据面：data channel 按 `chunk_header`（fileId,chunkIndex,total,offset,len）分片投递。
单聊直连，群聊由房主转发；断点续传在 roadmap。

## 6. 群（room）

`room.create` → `{roomId}`；`room.join/leave`；房主 `invite/kick`；成员变化发
`member_joined/member_left/room_message/room_sync`。以房主为根 mesh，seq 单调递增。