# LocalIM @ LAN — 架构

## 1. 总览

LocalIM 是**两层**结构：

- **native 守护进程**（`//base` `//net`）：局域网发现、跨网段中继、消息/房间/文件/远程的
  信令编排，提供两个 WebSocket 服务端（7615 控制面、7617 对端会话）。
- **WebUI**（Vite + TS）：被 Chromium 承载的壳内聊天界面；音视频、共享桌面、远程画面、
  文件分片等**大流量媒体**全部由 WebUI 内经 `RTCPeerConnection` 的 Web 标准栈承载，
  守护进程只做信令中转，不搬运媒体字节。

该分层保证：守护进程轻量、可无人值守；媒体质量与扩展交给浏览器内核的 WebRTC 传输。

## 2. 组件图

```
┌─────────────── WebUI ───────────────┐        ┌────────── 对端设备 ──────────┐
│  view(/roster/chat/media)          │        │  daemon(7615/7617)          │
│  client/native_client (ws 7615)    │        └─────────────▲───────────────┘
│  client/webrtc (PeerConnection)    │                      │ 7617 帧
└──────┬─────────────────────────────┘        ┌─────────────┴───────────────┐
       │ ws control 7615                      │   native daemon (C++)       │
       ▼                                      │  Daemon ── 编排 & 派发       │
┌──────────── 守护进程 ─────────────────────┐  │  ├─ WsHub(7615+7617)        │
│  Daemon                                  │  │  ├─ LanHeartbeat(7616)      │
│   · 控制器：启动/停止/消息路由/SendResult   │  │  ├─ RelayClient(7618)       │
│   · 各业务命名空间分发                     │   │  ├─ PeerRegistry/RoomManager │
│   · peer 在线表 + 超时清退                 │  │  └─ FileTransfer/RemoteControl│
│  WsHub: loopback 7615 + peer 7617        │   └──────────────────────────────┘
│       · TCP accept + RFC6455 握手 ⇔ 帧   │  
│  LanHeartbeat: UDP multicast 239.255.0.16│
│  RelayClient: relay 的 WS 客户端          │ 
└──────────────────────────────────────────┘
```

所有网络套接字均在独立 **IO 线程**（`base::Thread("localim-io")`）上运行，
主线程仅装配与响应停止；业务回调用 `WeakPtrFactory` 绑定到该线程，保证不跨线程调用。

## 3. 单/群聊与路由

- **同网段**：`daemon -> 7617 (peer daemon)` 信封直投。
- **跨网段**：`daemon -> relay(7618)#register -> 收到事件后经 relay 信封转发`。
- **群聊**：以房主为根的 mesh，成员向房主订阅，房主做拓扑广播；房主离线由次级接替（占位）。

骨架阶段的真实媒体路径如下（数据面全部在 WebUI WebRTC）：

| 业务 | 信令（守护进程） | 数据（WebUI） |
| --- | --- | --- |
| 语音/视频 | 7615←→7617 offer/answer/ice | RTCPeerConnection media flows |
| 共享桌面 | share_start/stop | getDisplayMedia → track → PeerConnection |
| 远程连接 | remote_start/remote_input | canvas 接收画面 + data channel 下发输入 |
| 文件传输 | transfer_begin/ack + chunk_header | data channel 二进制分片 |

> 信令中继：WebUI 的 `media.*`/`file.*` 经本机 daemon(7615) 收到后，由 `SendPeerSignal`
> 包成 `media.relay` 信封（带 innerNs/innerM）按 `to` 经 daemon↔daemon(7617) 转发，对端
> 拆信封并以 innerM 广播为 `media` 事件给其 WebUI —— 与消息中继共用同一拨号/复用连接内核。
>
> 文件数据面：WebUI data channel 上先发 `fmeta`(元数据) 再 `fhead`+二进制分片(1MiB)，
> 接收端按 fileId 重组为 Blob→objectURL；普通文件进会话可下载，image/video/audio 内联展示。

## 4. 关键守则

- **只依赖 chromium/src 组件**：`//base`（线程/JSON/路径）、`//net`（socket/网络接口）、
  `//url`、`//build`。**严禁**出现 arupa / nomad 头与依赖。
- **本地优先**：无中心服务器依赖；relay 仅做跨网段引导，不存储消息。
- **三平台隔离**：仅在 `native/platform/` 与 `scripts/` 出现平台分支。

## 5. 构建接线

- `src/localim` 是到 `../localim` 的**目录连接点**（junction），使 GN 能以 `//localim` 寻址
  外部源码树（与 `src/chrome/browser/arupa_desktop` 挂 arupa_kernel 同款）。
- `node_modules` / `ui/out` 等在 `.gitignore` 中排除。
- 顶层 `localim/BUILD.gn` 聚合 `//localim/native:native`；`src/BUILD.gn` 的 `gn_all`
  登记 `//localim/native:native` 以便进入图（不随浏览器默认产物打包体积）。

## 6. 运行方式（骨架）

1. `autoninja -C <out> localim/native:localim_daemon`（或 `build_localim_win.ps1`，会把 WebUI 产物一并搬到 exe 旁 `out\localim\webui`）
2. 三选一吐 WebUI：
   - **native 自托管（推荐）**：`localim_daemon --webui-dist=<dist>`，内置 `WebServer`（`core/webserver.*`，基于 `net::HttpServer`）在 HTTP 7619 静态服务 index/assets，默认 index、MIME、404、路径穿越防御；
   - 独立的 web 静态服务吐 `ui/out/webui`（如 dev node 托管）；
   - 由内容 shell 内嵌（见 roadmap）。
3. WebUI 连 `ws://127.0.0.1:7615` 开始聊天。