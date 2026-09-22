// LocalIM 守护进程：接线 ws_hub + lan/relay 发现 + 会话/群/文件/远程 + 信封派发。
#ifndef LOCALIM_CORE_DAEMON_H_
#define LOCALIM_CORE_DAEMON_H_

#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback_forward.h"
#include "base/threading/thread.h"
#include "base/values.h"
#include "core/cipher.h"
#include "core/discovery/lan_ifaces.h"
#include "core/identity.h"
#include "core/session/message_store.h"
#include "core/session/peer_registry.h"
#include "core/session/room_manager.h"
#include "core/transport/file_transfer.h"

namespace net {
class StreamSocket;
}  // namespace net

namespace localim {

class WsHub;
class WsConnection;
class WebServer;
class LanHeartbeat;
class RelayClient;
class RemoteControl;

// 端口集合：本机并存多实例调试时可用 --webui-port/--peer-port/--presence-port/--relay-port 覆盖。
struct Ports {
  uint16_t webui = 7615;     // WebUI 控制面
  uint16_t peer = 7617;      // LAN 对端消息/文件
  uint16_t presence = 7616;  // UDP 多播存在性
  uint16_t relay = 7618;     // 跨网段引导中继
  uint16_t web = 0;          // 静态 WebUI HTTP 托管端口（0=不启用）
};

// 运行时选项：--webui-dist 指向 Vite 构建产物目录时启用静态托管；--relay-host
// 指向跨网段引导中继服务（缺省 127.0.0.1，即本机跑 localim_relay）。
struct DaemonOptions {
  base::FilePath webui_dist;
  std::string relay_host;
  // 局域网预共享口令：非空时启用 AES-256-GCM 消息加密 + 信封 HMAC 认证。
  // 两端填同一口令才互通；仅存于 daemon，不进 WS 链路。
  std::string psk;
};

class Daemon {
 public:
  // io 线程用于所有 net 套接字与消息处理。
  explicit Daemon(identity::Profile profile, const Ports& ports = {},
                  base::FilePath data_dir = {}, const DaemonOptions& options = {});
  ~Daemon();

  void Start();
  void Stop();
  bool IsStarted() const { return started_; }

 private:
  void StartOnIo();
  void OnHubMessage(int client_id, uint16_t port, const std::string& json);
  void OnHubClosed(int client_id);
  // src_ip：这份 presence 从哪个源地址来（多网卡对端按它优先直连）。
  void OnLanPeer(const std::string& peer_json, const std::string& src_ip);
  void OnRelayEvent(const std::string& json);
  void HandleEnvelope(int client_id, const std::string& json);
  void Dispatch(int client_id, const std::string& ns, const std::string& method,
                const base::DictValue& d, const std::string& txn);
  void SendResult(int client_id, const std::string& txn, const std::string& ns,
                  const std::string& method, base::DictValue result);
  void SendError(int client_id, const std::string& txn, int code, const std::string& msg);
  void SendToWebUi(const std::string& json);
  void AnnounceSelf();
  void PruneStalePeers();
  // 会话键：单聊=对方 deviceId，群聊=roomId。msg 需已含 from/kind/to。
  std::string ConvKey(const base::DictValue& msg) const;

  // 对端直投：拨号 peer 的 peer-port，发中继帧；断连时清理。
  // inner_ns/inner_m 标识被中继的内层命名空间与方法，收端据此路由。
  void SendPeerMessage(const std::string& device_id, base::DictValue pkt);
  void SendPeerSignal(const std::string& device_id, const std::string& inner_ns,
                      const std::string& inner_m, base::DictValue pkt);
  // 复用既有对端连接，否则拨号并暂存待发帧。
  void SendPeerEnvelope(const std::string& device_id, base::DictValue relay);
  // 多网卡/多网段智能选路：
  //  · RefreshLocalIfaces —— 刷新本机网卡快照（增删/换网段时重建组播与注册载荷）；
  //  · PeerCandidates    —— 对端候选地址按"同子网优先"排序（上次拨通的地址优先复用）；
  //  · DialNext          —— 按候选逐个拨号，失败自动换下一个，全部失败才丢弃待发帧。
  void RefreshLocalIfaces();
  std::string SelfPayload() const;
  std::vector<std::string> PeerCandidates(const PeerRecord& rec) const;
  std::string PickPeerAddress(const std::string& device_id);
  void DialNext(const std::string& device_id, std::string pending_json);
  void OnPeerDialResult(const std::string& device_id, const std::string& host,
                        uint16_t port, int rv);
  // 离线投递：对方不在线时按设备入队，上线后补投；送达由对端回执确认。
  void QueueOffline(const std::string& device_id, base::DictValue msg);
  bool Connected(const std::string& device_id) const;
  bool EnsureConnection(const std::string& device_id);
  void FlushQueue(const std::string& device_id);
  void MaybeRedeliver(const std::string& device_id);
  void SendMessageAck(const std::string& device_id, const std::string& nonce);
  void OnOutgoingFrame(const std::string& device_id, const std::string& json);
  void OnOutgoingClosed(const std::string& device_id);
  // 消息加密（--psk）：出向对文字 body 用 AES-GCM 加密，入向解密；信封统一 HMAC 认证+防重放。
  bool EncEnabled() const { return cipher_ && cipher_->enabled(); }
  // 就地加密 pkt 的 body（加 enc/iv 字段）；空 body 跳过，返回是否已改。
  bool SealMessageBody(base::DictValue& pkt);
  bool DecryptMessageBody(base::DictValue& pkt);
  // 校验并让 peer 信封通过认证（时间窗 + nonce 防重放 + HMAC）；失败丢弃。
  bool VerifyPeerFrame(const std::string& json);
  void HandleInboundPeerEnvelope(const std::string& json);
  void HandleInboundMediaSignal(const std::string& json);
  // 跨设备房间控制：invite/sync/member_* 走 peer 信封（ns=room）。
  void SendPeerRoomSignal(const std::string& device_id, const std::string& inner_m,
                          base::DictValue pkt);
  void HandleInboundRoomSignal(const std::string& json);
  // 向群内(除指定者外的)在线成员广播 room.sync，保持各端成员表一致。
  void FanOutRoomSync(Room* rm, const std::string& exclude);
  // 向本机 WebUI 推 room.<m> 事件。
  void EmitRoomEvent(const std::string& m, base::DictValue d);

  identity::Profile profile_;
  Ports ports_;
  base::FilePath data_dir_;
  DaemonOptions options_;
  // StartOnIo 经 io_task_runner_ 投递；所有 core 组件都在该 runner 上执行。
  scoped_refptr<base::SingleThreadTaskRunner> io_task_runner_;
  std::unique_ptr<base::Thread> io_thread_;
  std::unique_ptr<WsHub> hub_;
  std::unique_ptr<WebServer> web_server_;
  std::unique_ptr<LanHeartbeat> heartbeat_;
  std::unique_ptr<RelayClient> relay_;
  std::unique_ptr<RemoteControl> remote_;
  std::unique_ptr<MessageStore> messages_;
  PeerRegistry peers_;
  RoomManager rooms_;
  FileTransfer files_;
  std::map<int, uint16_t> client_port_;  // client_id -> 来源监听口
  std::map<std::string, std::unique_ptr<net::StreamSocket>> dialing_;  // devId -> 拨号中的 socket
  std::map<std::string, std::unique_ptr<WsConnection>> outgoing_;     // devId -> 已建立的对端连接
  std::map<std::string, std::string> pending_out_;                    // devId -> 待发的 pkt json
  std::vector<IfAddr> locals_;                                        // 本机网卡快照（选路基准）
  std::map<std::string, std::vector<std::string>> dial_plan_;         // devId -> 已排序候选地址
  std::map<std::string, size_t> dial_idx_;                            // devId -> 下一个待试候选
  std::map<std::string, std::string> route_;                          // devId -> 上次拨通的地址
  // 离线投递队列：devId -> 对方不在线期间入队的消息（FIFO，上限 kOfflineQueueCap）。
  std::map<std::string, std::vector<base::DictValue>> offline_q_;
  // 消息加密（AES-GCM 内容机密 + 信封 HMAC 认证/防重放）。
  std::unique_ptr<MessageCipher> cipher_;
  std::set<std::string> seen_sig_;  // 防重放：窗口内已见 (fromId|nonce)
  bool is_scanning_ = false;
  bool started_ = false;
  base::WeakPtrFactory<Daemon> weak_factory_{this};
};

}  // namespace localim

#endif  // LOCALIM_CORE_DAEMON_H_