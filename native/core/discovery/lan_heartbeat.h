// 同网段设备存在性：UDP 多播组 239.255.0.16:7616 心跳 + 发现。
//
// 多网卡机器按"每网卡一套 socket"收发：
//  · 每套 socket 先 SetMulticastInterface(iface.index) 再 Bind + JoinGroup，
//    于是组播收发都锚在该网卡上（POSIX 下 JoinGroup 用 imr_ifindex，
//    缺省接口的旧写法只能覆盖路由表选中的那一个网段）；
//  · 同一份 presence 会在多网卡上被各自听到，故按载荷去重后再回调。
#ifndef LOCALIM_CORE_DISCOVERY_LAN_HEARTBEAT_H_
#define LOCALIM_CORE_DISCOVERY_LAN_HEARTBEAT_H_

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/functional/callback_forward.h"
#include "base/memory/ref_counted.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "core/discovery/lan_ifaces.h"
#include "net/base/ip_address.h"
#include "net/socket/udp_socket.h"

namespace localim {

// 服务 IO 线程。周期广播本机 presence；收到他人 presence 时回调 on_peer。
class LanHeartbeat {
 public:
  // identity_payload 为已序列化的本人身份 JSON（含 deviceId/name/platform/host/addrs）。
  // src_ip 为收到该 presence 的源地址（同一 deviceId 多网卡时用于选路）。
  using OnPeer = base::RepeatingCallback<void(const std::string& peer_json,
                                              const std::string& src_ip)>;
  using OnError = base::RepeatingCallback<void(const std::string& msg)>;

  explicit LanHeartbeat(
      const net::IPEndPoint& group,
      std::string identity_payload,
      OnPeer on_peer,
      OnError on_error);
  ~LanHeartbeat();

  void Start();
  void Stop();

  // 立即广播一次（上线/改名/网卡变化时调用）。
  void Announce();

  // 身份载荷变化（改名、地址变化）后更新，下一次 Tick/Announce 生效。
  void SetPayload(std::string identity_payload);

  // 网卡增删（VPN 拨号、Wi-Fi 切换）后重建每网卡 socket；无变化则空转。
  void RefreshIfaces();

  // 当前参与收发的网卡（测试/排障用）。
  std::vector<IfAddr> ifaces() const { return ifaces_; }

 private:
  struct IfaceSocket;  // 定义见 .cc（持有 socket 与读缓冲）

  void BindSockets();
  void Fail(const std::string& msg);
  void StartRecv(IfaceSocket* s);
  void OnRecv(IfaceSocket* s, int result);
  void SendOn(IfaceSocket* s);
  void OnSend(int result);
  void Tick();

  net::IPEndPoint group_;
  std::string identity_payload_;
  std::vector<IfAddr> ifaces_;
  std::vector<std::unique_ptr<IfaceSocket>> socks_;
  // 去重：同一份 payload 在多网卡上重复到达时，窗口内只回调一次。
  std::map<std::string, base::TimeTicks> recent_;
  OnPeer on_peer_;
  OnError on_error_;
  bool running_ = false;
  base::WeakPtrFactory<LanHeartbeat> weak_factory_{this};
};

}  // namespace localim

#endif  // LOCALIM_CORE_DISCOVERY_LAN_HEARTBEAT_H_
