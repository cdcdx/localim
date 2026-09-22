// 跨网段引导中继客户端：注册本机到 relay(7618)，收取其它网段 peer 列表事件。
#ifndef LOCALIM_CORE_DISCOVERY_RELAY_CLIENT_H_
#define LOCALIM_CORE_DISCOVERY_RELAY_CLIENT_H_

#include <memory>
#include <string>

#include "base/functional/callback_forward.h"
#include "base/memory/ref_counted.h"
#include "base/memory/weak_ptr.h"
#include "net/socket/tcp_client_socket.h"

namespace localim {

// 服务 IO 线程。连接到 relay 的 ws/hub(7618) 作为 WS 客户端：
//  1) 发握手 + 第一条 {op:"register", deviceId, host, netmask, public}
//  2) 循环读 UAOS「 unmasked 服务器帧」，把对端事件转发给 on_event
//  3) 收发用 EncodeClientFrame(掩码) 复用 ws_connection 的帧封装
class RelayClient {
 public:
  using OnEvent = base::RepeatingCallback<void(const std::string& json)>;
  using OnState = base::RepeatingCallback<void(bool connected)>;

  // register_payload 为 {op:"register", deviceId, host, netmask, public}
  RelayClient(const net::IPEndPoint& relay,
              std::string register_payload,
              OnEvent on_event,
              OnState on_state);
  ~RelayClient();

  void Start();
  void Stop();
  void SendEnvelope(const std::string& json);

 private:
  void Connect();
  void OnConnected(int result);
  void SendRegistration();
  void StartRecv();
  void OnRecv(int result);
  void DoReads();

  net::IPEndPoint relay_;
  std::string register_payload_;
  std::unique_ptr<net::TCPClientSocket> socket_;
  scoped_refptr<net::IOBuffer> buf_;
  std::string read_queue_;
  OnEvent on_event_;
  OnState on_state_;
  bool running_ = false;
  bool handshaken_ = false;  // 已跳过服务端 HTTP 101 握手应答
  base::WeakPtrFactory<RelayClient> weak_factory_{this};
};

}  // namespace localim

#endif  // LOCALIM_CORE_DISCOVERY_RELAY_CLIENT_H_