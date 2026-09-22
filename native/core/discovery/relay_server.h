// 独立跨网段引导中继服务端：接受 daemon 的 RelayClient 连接，维护
// deviceId -> 连接 的路由表，注册/注销时向其它客户端广播 peer_online/offline，
// 使不同网段的 daemon 能通过本 relay 互发现并拿到对端 host/port 直连。
// 复用 WsConnection 的帧编解码与服务端握手（与 ws_hub 一致）。
#ifndef LOCALIM_CORE_DISCOVERY_RELAY_SERVER_H_
#define LOCALIM_CORE_DISCOVERY_RELAY_SERVER_H_

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/memory/ref_counted.h"
#include "base/memory/weak_ptr.h"
#include "net/base/ip_endpoint.h"
#include "net/socket/stream_socket.h"
#include "net/socket/tcp_server_socket.h"

namespace net {
class ServerSocket;
}  // namespace net

namespace localim {

class WsConnection;

// 服务 IO 线程。监听 relay 端口(7618, IPv4AllZeros 以便跨网段可达)，接受
// WS 客户端后按路由表广播在线表。字符串字段缺省回落空串，便于容错。
class RelayServer {
 public:
  RelayServer();
  ~RelayServer();
  RelayServer(const RelayServer&) = delete;
  RelayServer& operator=(const RelayServer&) = delete;

  void Start(uint16_t port);
  void Stop();

  // 调试/测试：当前已注册路由条数。
  int route_count() const { return static_cast<int>(routes_.size()); }
  // 调试/测试：已注册的 deviceId 列表。
  std::vector<std::string> registered_devices() const;

 private:
  struct PendingHandshake {
    std::unique_ptr<net::StreamSocket> socket;
    std::string buffer;
    scoped_refptr<net::IOBuffer> io;
  };
  struct Client {
    std::unique_ptr<WsConnection> conn;
    std::string device_id;
    std::string name;
    std::string host;
    uint16_t port = 0;
  };

  void DoAccept();
  void OnAccept(int result);
  void ReadHandshake(PendingHandshake* p);
  void OnHandshakeRead(PendingHandshake* p, int result);
  void SendHandshake(PendingHandshake* p, const std::string& key);
  void OnHandshakeWritten(PendingHandshake* p, int result);
  void DropPending(PendingHandshake* p);
  void OnClientMessage(int client_id, const std::string& json);
  void OnClientClosed(int client_id);

  // 注册(含重新注册)：入库路由表；向新客户端回放既有 roster，并向其它客户端广播 online。
  void Register(int client_id, const std::map<std::string, std::string>& fields);
  // 向某客户端推送单个 peer_online(deviceId) 事件。
  void SendPeerOnline(int client_id, const std::string& device_id);
  // 构造 {op:"peer_online", deviceId,name,host,port,via:"relay"}。
  static std::string BuildPeerOnlineJson(const Client& c);
  // 构造 {op:"peer_offline", deviceId}。
  static std::string BuildPeerOfflineJson(const std::string& device_id);
  void Send(int client_id, const std::string& json);
  void BroadcastExcept(int except_client_id, const std::string& json);

  std::unique_ptr<net::ServerSocket> server_;
  std::vector<std::unique_ptr<PendingHandshake>> pending_handshakes_;
  std::map<int, Client> clients_;          // client_id -> 已建立连接的客户端(device_id 可空)
  std::map<std::string, int> routes_;      // deviceId -> client_id(路由表)
  bool accepting_ = false;
  int next_id_ = 1;
  base::WeakPtrFactory<RelayServer> weak_factory_{this};
};

}  // namespace localim

#endif  // LOCALIM_CORE_DISCOVERY_RELAY_SERVER_H_