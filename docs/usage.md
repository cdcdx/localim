# LocalIM 使用文档（User Guide）

> LocalIM @ LAN —— 用 Chromium 组件（`//base`/`//net`/`//url`）实现的**纯局域网即时通讯 + 远程桌面**工具。
> 本文面向**使用者 / 集成方**，只讲怎么构建、启动、链接和排查；协议与架构见
> [protocol](protocol/schema.json)、[architecture.md](architecture.md)。

---

## 1. 两种运行形态

| 形态 | 说明 | 适用 |
| --- | --- | --- |
| **native（真实守护进程）** | C++ 编译的 `localim_daemon`，真实 UDP/TCP/WS 服务 | 生产、真机联调、性能验证 |
| **dev（node 协议子集）** | Node 写的协议桩，内嵌 Web UI 静态服务 | 只调 WebUI 交互、画 UI、看信封结构 |

两者 WebSocket 协议完全一致（`protocol/schema.json`），前端代码无需区分。

---

## 2. 前置要求

### 通用
- 一份可用的 **Chromium 源码树**（`<chromium>/src`），已配置好 `depot_tools`（`gn` / `autoninja`）。
- LocalIM 源码位于 `<chromium>/localim`，**只依赖 chromium/src 内组件**。

### 各平台
| 平台 | 关键前提 |
| --- | --- |
| Windows | `depot_tools` 在 PATH；PowerShell 5+ |
| macOS | Xcode Command Line Tools |
| Ubuntu | `libxtst-dev` / `libxtst6`（远程桌面的 X11 输入注入用） |

---

## 3. 构建

### Windows
```powershell
# 脚本 <chromium>\localim\scripts\build_localim_win.ps1
# 自动完成：src/localim 目录连接点挂载 + 写 out\localim\args.gn + gn gen + autoninja
powershell -ExecutionPolicy Bypass -File localim\scripts\build_localim_win.ps1
# 产物：<chromium>\src\out\localim\localim_daemon.exe
```

### macOS / Ubuntu
```bash
# <chromium>/localim/scripts/build_localim_unix.sh
# 默认按当前主机选 target_os；跨编用 TARGET_OS=mac|linux 覆盖
TARGET_OS=linux bash localim/scripts/build_localim_unix.sh
# 产物：<chromium>/src/out/localim/localim_daemon
```

> 说明：`scripts/` 会在首次把 `src/localim -> ../localim` 以符号链接/连接点挂载进源码根，
> 因为 GN 要求构建目录与源码同根。手动方式：
> `gn gen ../out/localim --args="is_component_build=true use_siso=false symbol_level=0"`。

---

## 4. 启动守护进程（native）

```bash
# Windows
<chromium>\src\out\localim\localim_daemon.exe --user-data-dir=%USERPROFILE%\.localim

# macOS / Ubuntu
<chromium>/src/out/localim/localim_daemon --user-data-dir=~/.localim
```

启动成功后（可用 `Get-NetTCPConnection` / `ss -lntup` 观察）：

| 端口 | 协议 | 作用 |
| --- | --- | --- |
| 7615 | ws (127.0.0.1) | WebUI ↔ 本机守护进程 控制/信令 |
| 7616 | udp multicast | 同网段设备存在性广播 |
| 7617 | tcp/ws | 设备间 P2P 消息 / 中继 |
| 7618 | ws | 跨网段引导中继（可选，需另行起 relay） |
| 7619 | http (127.0.0.1) | 静态 WebUI 托管（仅 `--webui-dist` 启用，可用 `--web-port` 改） |

`--user-data-dir`：身份（`deviceId` 等）与配置的持久化目录，不传则用默认用户配置目录。

**启用 native 静态托管 WebUI**（省去 dev node 中间层）：
```bash
# 先构建 WebUI 产物（一次）
cd <chromium>/localim/ui && npm install && npm run build    # 产物 ui/out/webui
# 再用本地构建脚本（会自动把 ui/out/webui 拷贝到 exe 旁 out\localim\webui）
powershell -ExecutionPolicy Bypass -File localim\scripts\build_localim_win.ps1
# 启动 daemon（--webui-dist 指向 exe 旁产物，默认 HTTP 7619）
<chromium>\src\out\localim\localim_daemon.exe --webui-dist=<chromium>\src\out\localim\webui
# 浏览器打开 http://127.0.0.1:7619
```

---

## 5. 启动 WebUI 并连接

### 方式一：dev 模式（推荐先跑通 UI）
```bash
cd <chromium>/localim
node dev/daemon/daemon.mjs              # 默认 ws=7615, http=8080
# 自定义端口：PORT_WS=7615 PORT_WEBUI=8080 node dev/daemon/daemon.mjs
```
浏览器打开 `http://127.0.0.1:8080`。dev 守护进程自带 UI 静态服务，
`roster.list` / `identity.hello` / `room.create` / `message.send` 都有可交互的桩应答；
`discovery.scan_start` 后会自动出现一台假设备（`tax-2`）。

### 方式二：Vite 开发服务器（热更 UI，连 native daemon）
```bash
cd <chromium>/localim/ui
npm install          # 首次
npm run dev          # vite dev server（默认 5173）
```
先启动 native daemon（见第 4 节），再访问 Vite 页面，前端经 `ws://127.0.0.1:7615` 连真实守护进程。

### 方式三：构建静态 UI + dev 守护进程托管
```bash
cd <chromium>/localim/ui && npm install && npm run build    # 产物 ui/out/webui
cd <chromium>/localim && node dev/daemon/daemon.mjs          # daemon 自动托管 out/webui
```

---

## 6. 使用流程

1. **连接**：打开页面后 WebSocket 自动连到 7615，`identity.hello` 拿到本机 `deviceId/name/platform`。
2. **在线设备**：同网段设备自动被 UDP 心跳发现并出现在会话列表（`roster`）；
   跨网段设备需经过 relay。dev 模式下 `scan_start` 会注入一台模拟设备。
3. **单人聊天**：选设备 → 发文字/语音/图片/视频/文件（媒体与分片走 WebRTC data channel，
   元数据走 WS）。框架内已留信令与数据面，媒体厂家实现见 [roadmap](roadmap.md)。
4. **自建群组**：`room.create` 建群、`room.invite` 拉成员、`message.send` 群发。群共享桌面由房主
   `startRoomShare(roomId)` 向每个在线成员各建一条独立 PeerConnection 广播本机屏幕（优先同步采集系统音频，
   失败回退纯画面）。房主浮层可逐个踢出观众；观众可「请求结束共享」由房主裁决。
5. **群共享内嵌控制**：观众在共享浮层「请求控制」→ 房主「同意控制」后，该观众可在共享画面上直接操作
   房主鼠标/键盘（经 data channel 回传 → 房主 daemon `input_injector` 注入系统）；观众「结束控制」或
   房主「撤销控制」即回收权限并解除房主注入武装。房主观众列表标注「· 控制中」。
6. **远程连接（1:1）**：对端需装有输入注入器（`native/platform/input_injector_{win,mac,linux}`），
   随守护进程一体部署。

---

## 7. 本机多实例联调（不用真机）

守护进程端口可经命令行覆盖，可**在同机并开多个 daemon**，经局域网组播互相发现，
适合单机验证「设备发现 / 单聊」全链路：

```bash
# 实例 A：默认端口
localim_daemon --user-data-dir=~/.localim_a

# 实例 B：换 webui/peer 端口；presence 口保持同一组播(7616)以便互发现
localim_daemon --user-data-dir=~/.localim_b \
  --webui-port=9165 --peer-port=9167 --presence-port=7616
```

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `--webui-port` | 7615 | WebUI 控制面 |
| `--peer-port` | 7617 | 对端消息/文件 |
| `--presence-port` | 7616 | UDP 多播地址（多实例互发现需保持一致） |
| `--relay-port` | 7618 | 跨网段中继 |

- 公告携带各自的 `peer-port`，对方据此连入正确的对端口。
- WebUI 可指向任意实例：`http://127.0.0.1:8080/?port=7615` 或 `?port=9165`。
- 快速看各实例在线表：`node scripts/roster_poll.mjs 7615 A` / `... 9165 B`。

---

## 8. 协议冒烟测试

仓库自带一个独立于 UI 的联调脚本，直接验证 WebSocket 全链路：

```bash
# 先启动 native 或 dev 守护进程（见第 4/5 节）
node <chromium>/localim/scripts/ws_e2e.mjs
# 自定义端口：LOCALIM_WS=ws://127.0.0.1:7615 node scripts/ws_e2e.mjs
```

它依次发 `identity.hello / roster.list / room.create / message.send / discovery.scan_start / 未知方法`，
打印每个应答信封。期望：前 5 个 `ok:true`，未知方法返回 `-32601`，
且 `message.send` 后会收到 daemon 广播的聊天事件包（`dir:"ev"`）。

---

## 9. 常见问题（FAQ）

| 现象 | 原因 / 处理 |
| --- | --- |
| `exe 被占用`、链接报 Permission denied | 前一个 daemon 进程未退出，任务管理器结束或 `Stop-Process -Name localim_daemon` |
| WebUI 连不上 7615 | daemon 未启动，或先起了 dev 守护进程占用 7615（先停掉它） |
| `udp bind failed` 日志 | 该问题已修复：组播 socket 须 bind `0.0.0.0:port` 再 `JoinGroup`（见 lan_heartbeat.cc） |
| 同网段看不到设备 | 检查防火墙放行 **UDP 7616 入/出站**；确认组播未被交换机隔离 |
| 跨网段找不到设备 | 需要运行 **relay（7618）** 中继，尚未随构建一起产出，见 roadmap |
| Ubuntu 编译缺头文件 | 安装 `libxtst-dev`（`sudo apt install libxtst-dev`） |
| 首启进程崩（退出码异常） | 组件构建需线程池：确认运行的 `localim_daemon` 是**最新重链产物**（older exe 缺线程池初始化） |

---

## 9. 目录速查

```
localim/
├─ protocol/schema.json   协议契约（唯一事实源）
├─ ui/                    WebUI（Vite+TS），out/webui 为构建产物
├─ native/app/            daemon 入口 localim_main.cc
├─ native/core/           编排 + ws + identity + 各业务模块（discovery/session/transport/remote）
├─ native/platform/       三平台输入注入
├─ dev/daemon/daemon.mjs   dev 协议桩（node）
├─ scripts/               构建脚本 + ws_e2e.mjs 联调脚本
└─ docs/                  本文档 / PRD / architecture / protocol / roadmap
```