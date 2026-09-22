// WsHub：localhost 7615（WebUI 控制面）+ LAN 7617（对端 daemon）两个握手 WebSocket
// 服务端。所有连接共用 dispatcher：收到的完整 TEXT 信封交给 daemon。
#ifndef LOCALIM_CORE_WS_HUB_H_
#define LOCALIM_CORE_WS_HUB_H_

#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "base/functional/callback_forward.h"
#include "base/memory/weak_ptr.h"
#include "net/base/ip_endpoint.h"
#include "net/socket/stream_socket.h"
#include "net/socket/tcp_server_socket.h"
#include "net/socket/server_socket.h"

namespace localim {

class WsConnection;

class WsHub {
 public:
  // port=来源监听口（对应 7615=WebUI雅，7617=对端 daemon）。
  using OnMessage = base::RepeatingCallback<void(int client_id, uint16_t port, const std::string& json)>;
  using OnConnectionClosed = base::RepeatingCallback<void(int client_id)>;
  using OnConnect = base::RepeatingCallback<void(int client_id, uint16_t port)>;

  WsHub();
  ~WsHub();

  // loopback_port=7615（127.0.0.1），peer_port=7617（LAN）。都在 IO 线程调用。
  void Start(uint16_t loopback_port, uint16_t peer_port, OnMessage on_message);
  void Stop();

  void Send(int client_id, const std::string& json);
  void Broadcast(const std::string& json);

  void set_on_closed(OnConnectionClosed cb) { on_closed_ = std::move(cb); }
  void set_on_connect(OnConnect cb) { on_connect_ = std::move(cb); }

 private:
  // 每次 accept 得到的一个待握手连接（独立 buffer/io，互不阻塞）。
  struct PendingHandshake {
    std::unique_ptr<net::StreamSocket> socket;
    std::string buffer;
    scoped_refptr<net::IOBuffer> io;
  };
  struct Listener {
    std::unique_ptr<net::ServerSocket> server;
    bool accepting = false;
    std::vector<std::unique_ptr<PendingHandshake>> pending;
  };

  void StartListener(uint16_t port, const net::IPEndPoint& endpoint);
  void DoAccept(uint16_t port);
  void OnAccept(uint16_t port, int result);
  void ReadHandshake(uint16_t port, PendingHandshake* p);
  void OnHandshakeRead(uint16_t port, PendingHandshake* p, int result);
  void SendHandshake(uint16_t port, PendingHandshake* p, const std::string& key);
  void OnHandshakeWritten(uint16_t port, PendingHandshake* p, int result);
  void DropPending(uint16_t port, PendingHandshake* p);
  void OnClientClosed(int client_id);

  std::map<uint16_t, Listener> listeners_;
  std::map<int, std::unique_ptr<WsConnection>> clients_;
  OnMessage on_message_;
  OnConnectionClosed on_closed_;
  OnConnect on_connect_;
  int next_id_ = 1;
  base::WeakPtrFactory<WsHub> weak_factory_{this};
};

}  // namespace localim

#endif  // LOCALIM_CORE_WS_HUB_H_