// 同网段设备存在性：UDP 多播组 239.255.0.16:7616 心跳 + 发现。
#ifndef LOCALIM_CORE_DISCOVERY_LAN_HEARTBEAT_H_
#define LOCALIM_CORE_DISCOVERY_LAN_HEARTBEAT_H_

#include <memory>
#include <string>

#include "base/functional/callback_forward.h"
#include "base/memory/ref_counted.h"
#include "base/memory/weak_ptr.h"
#include "net/base/ip_address.h"
#include "net/socket/udp_socket.h"

namespace localim {

// 服务 IO 线程。周期广播本机 presence；收到他人 presence 时回调 on_peer。
class LanHeartbeat {
 public:
  // identity_payload 为已序列化的本人身份 JSON（含 deviceId/name/platform/host）。
  using OnPeer = base::RepeatingCallback<void(const std::string& peer_json)>;
  using OnError = base::RepeatingCallback<void(const std::string& msg)>;

  explicit LanHeartbeat(
      const net::IPEndPoint& group,
      std::string identity_payload,
      OnPeer on_peer,
      OnError on_error);
  ~LanHeartbeat();

  void Start();
  void Stop();

  // 立即广播一次（上线/改名时调用）。
  void Announce();

 private:
  void BindSocket();
  void Fail(const std::string& msg);
  void StartRecv();
  void OnRecv(int result);
  void SendHeartbeat(const net::IPEndPoint& dst);
  void OnSend(int result);
  void Tick();

  net::IPEndPoint group_;
  std::string identity_payload_;
  std::unique_ptr<net::UDPSocket> socket_;
  scoped_refptr<net::IOBuffer> recv_buf_;
  net::IPEndPoint recv_src_;
  OnPeer on_peer_;
  OnError on_error_;
  bool running_ = false;
  base::WeakPtrFactory<LanHeartbeat> weak_factory_{this};
};

}  // namespace localim

#endif  // LOCALIM_CORE_DISCOVERY_LAN_HEARTBEAT_H_