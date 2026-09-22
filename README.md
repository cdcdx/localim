# LocalIM @ LAN

利用 **Chromium 系统组件**（`//base`、`//net`、`//url`，全部来自 `chromium/src` 内部，
**不依赖** arupa / nomad 任何目录）实现的一种**纯局域网即时通讯 + 远程桌面**工具。
三平台一键构建（Windows / macOS / Ubuntu）。

## 核心能力

| 能力 | 覆盖 |
| --- | --- |
| 局域网自动扫描在线设备 | 同网段 UDP 多播心跳（239.255.0.16:7616） |
| 跨网段发现设备 | 网关注册 + 引导中继（relay :7618） |
| 单人聊天 | 文字 / 语音 / 图片 / 视频 / 文件，远程连接 |
| 自建群组聊天 | 文字 / 语音 / 图片 / 视频 / 文件，共享桌面 |

> 媒体（音视频/桌面/远程画面）与文件分片走 **WebRTC data channel** / `RTCPeerConnection`
> （WebUI 侧实现）；信令与元数据走守护进程 WebSocket。见 [protocol/schema.json](protocol/schema.json)。

## 仓库结构

```
localim/
├─ protocol/     协议契约（唯一事实源）：schema.json
├─ ui/           WebUI（Vite + TS 单页聊天界面，构建产物 out/webui）
├─ native/       C++ 守护进程（chromium 组件驱动）
│  ├─ app/       入口 localim_main.cc
│  ├─ core/      编排层 daemon + ws_hub + ws_connection + identity
│  │  ├─ discovery/   lan_heartbeat（多播）+ relay_client（中继）
│  │  ├─ session/     peer_registry + room_manager
│  │  ├─ transport/   file_transfer（元数据账本）
│  │  └─ remote/      remote_control（输入注入转发）
│  └─ platform/   三平台输入注入 input_injector_{win,mac,linux}
├─ docs/         PRD / architecture / protocol / roadmap
├─ scripts/      三平台挂载/构建脚本
└─ dev/          dev 守护进程（node 协议子集）
```

## 通信端口

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 7615 | ws(127.0.0.1) | WebUI <-> 本机守护进程 控制/信令 |
| 7616 | udp multicast | 同网段设备存在性广播 |
| 7617 | tcp/ws | P2P 直连/中转 消息与文件会话 |
| 7618 | ws | 跨网段引导中继 |

## 构建（三种度）

`//localim` 通过 `src/localim -> ../localim` 目录连接点挂载进浏览器源码根，
并登记进 `src/BUILD.gn` 的 `gn_all`（与 arupa_kernel 同款方式）。

```bash
# 1) 一次性 gen
cd <chromium>/src
gn gen ../out/localim --args="is_component_build=true use_siso=false symbol_level=0"
# 2) 构建 daemon
autoninja -C ../out/localim localim/native:localim_daemon
# 3) 运行
./../out/localim/localim_daemon --user-data-dir=~/.localim
```

三平台差异均在 `native/platform/` 与 `scripts/` 内隔离，见 [docs/architecture.md](docs/architecture.md)。

## 当前状态

可运行架构骨架：GN 目标解析通过、daemon 可在三平台 build，WebUI 构建通过。
语音/视频/远程桌面/文件传输的**实际媒体链路走 WebRTC（骨架内已留信令与数据面）**，
跨设备间数字历、群聊跨设备 mesh 等见 [docs/roadmap.md](docs/roadmap.md)。

> **上手使用见 [docs/usage.md](docs/usage.md)**（两种运行形态 / 三平台构建 / 启动 / 联调 / 排查）。