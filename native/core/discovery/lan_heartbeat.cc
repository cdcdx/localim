#include "core/discovery/lan_heartbeat.h"

#include <string>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/logging.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "net/base/address_family.h"
#include "net/base/io_buffer.h"
#include "net/base/ip_endpoint.h"

namespace localim {

namespace {
constexpr size_t kMtu = 65535;
// 同一份 presence 在多个网卡上重复到达的去重窗口（略小于心跳间隔）。
constexpr base::TimeDelta kDedupeWindow = base::Milliseconds(800);
constexpr base::TimeDelta kDedupeGc = base::Seconds(5);
constexpr size_t kDedupeMax = 256;
}  // namespace

// 每网卡一套 socket + 独立读缓冲（多网卡并发收包，互不覆盖 recv 缓冲）。
struct LanHeartbeat::IfaceSocket {
  IfAddr iface;
  std::unique_ptr<net::UDPSocket> socket;
  scoped_refptr<net::IOBufferWithSize> buf;
  net::IPEndPoint src;
};

LanHeartbeat::LanHeartbeat(const net::IPEndPoint& group,
                           std::string identity_payload,
                           OnPeer on_peer,
                           OnError on_error)
    : group_(group),
      identity_payload_(std::move(identity_payload)),
      on_peer_(std::move(on_peer)),
      on_error_(std::move(on_error)) {}

LanHeartbeat::~LanHeartbeat() {
  Stop();
}

void LanHeartbeat::Start() {
  if (running_)
    return;
  running_ = true;
  BindSockets();
  Announce();
  // 周期心跳（约 5 秒），保活 + 探测离线。
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&LanHeartbeat::Tick, weak_factory_.GetWeakPtr()),
      base::Seconds(5));
}

void LanHeartbeat::Stop() {
  running_ = false;
  weak_factory_.InvalidateWeakPtrs();
  socks_.clear();
  recent_.clear();
}

void LanHeartbeat::SetPayload(std::string identity_payload) {
  identity_payload_ = std::move(identity_payload);
}

void LanHeartbeat::RefreshIfaces() {
  if (!running_)
    return;
  const std::vector<IfAddr> now = LocalIfAddrs();
  // 无网卡可用时不拆掉现有 socket（URL/隧道类环境可能枚举为空），保持旧行为。
  if (now.empty() || now == ifaces_)
    return;
  LOG(INFO) << "lan_heartbeat: interfaces changed (" << ifaces_.size() << " -> "
            << now.size() << "), rebinding multicast sockets";
  BindSockets();
  Announce();
}

void LanHeartbeat::Announce() {
  for (auto& s : socks_)
    SendOn(s.get());
}

void LanHeartbeat::Tick() {
  if (!running_)
    return;
  Announce();
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&LanHeartbeat::Tick, weak_factory_.GetWeakPtr()),
      base::Seconds(5));
}

void LanHeartbeat::BindSockets() {
  // 旧 socket 上挂着的读回调全部作废，避免重建后往已释放的缓冲里写。
  weak_factory_.InvalidateWeakPtrs();
  socks_.clear();
  recent_.clear();

  const std::vector<IfAddr> ifaces = LocalIfAddrs();
  ifaces_ = ifaces.empty() ? std::vector<IfAddr>{IfAddr{}} : ifaces;

  auto AddSocket = [&](const IfAddr& iface) {
    auto s = std::make_unique<IfaceSocket>();
    s->iface = iface;
    s->socket = std::make_unique<net::UDPSocket>(
        net::DatagramSocket::DEFAULT_BIND, nullptr, net::NetLogSource());
    // 组播接收惯例（跨平台含 Windows）：bind 到 0.0.0.0:<port> 再 JoinGroup，
    // 直接 bind 组播组地址会返回 ERR_ADDRESS_IN_USE。
    int rv = s->socket->Open(net::GetAddressFamily(group_.address()));
    if (rv != net::OK) {
      LOG(WARNING) << "lan_heartbeat: open failed if=" << iface.name
                   << " rv=" << rv;
      return false;
    }
    // 必须在 Bind 之前：JoinGroup 用它作 imr_ifindex/imr_interface，决定这套
    // socket 锚在哪块网卡上；缺省接口（0）时即旧的单网段行为。
    if (iface.index != 0)
      s->socket->SetMulticastInterface(iface.index);
    s->socket->SetMulticastLoopbackMode(true);
    s->socket->SetMulticastTimeToLive(1);
    s->socket->AllowAddressReuse();
    s->socket->AllowAddressSharingForMulticast();
    const net::IPEndPoint recv_endpoint(net::IPAddress::IPv4AllZeros(),
                                        group_.port());
    rv = s->socket->Bind(recv_endpoint);
    if (rv != net::OK) {
      LOG(WARNING) << "lan_heartbeat: bind failed if=" << iface.name
                   << " rv=" << rv;
      return false;
    }
    rv = s->socket->JoinGroup(group_.address());
    if (rv != net::OK) {
      LOG(WARNING) << "lan_heartbeat: join group failed if=" << iface.name
                   << " rv=" << rv;
      return false;
    }
    s->buf = base::MakeRefCounted<net::IOBufferWithSize>(kMtu);
    socks_.push_back(std::move(s));
    return true;
  };

  for (const auto& iface : ifaces_)
    AddSocket(iface);
  if (socks_.empty()) {
    // 全部按网卡加入失败（某些平台/虚拟网卡不支持）：退回"缺省接口"单 socket，
    // 保持改造前的单网段行为，不至于整机发现功能失效。
    LOG(WARNING) << "lan_heartbeat: per-interface join failed, fallback to default interface";
    ifaces_ = {IfAddr{}};
    AddSocket(IfAddr{});
  }

  if (socks_.empty()) {
    Fail("no usable multicast interface");
    return;
  }
  LOG(INFO) << "lan_heartbeat: multicast on " << socks_.size()
            << " interface(s), group=" << group_.ToString();
  for (auto& s : socks_)
    StartRecv(s.get());
}

void LanHeartbeat::Fail(const std::string& msg) {
  if (on_error_)
    on_error_.Run(msg);
}

void LanHeartbeat::StartRecv(IfaceSocket* s) {
  if (!running_ || !s || !s->socket)
    return;
  const int rv = s->socket->RecvFrom(
      s->buf.get(), kMtu, &s->src,
      base::BindOnce(&LanHeartbeat::OnRecv, weak_factory_.GetWeakPtr(), s));
  if (rv != net::ERR_IO_PENDING)
    OnRecv(s, rv);
}

void LanHeartbeat::OnRecv(IfaceSocket* s, int result) {
  if (!running_)
    return;
  if (result > 0 && s) {
    const std::string payload(s->buf->data(), static_cast<size_t>(result));
    const std::string src_ip = s->src.address().ToString();
    const base::TimeTicks now = base::TimeTicks::Now();
    auto it = recent_.find(payload);
    if (it != recent_.end() && now - it->second < kDedupeWindow) {
      StartRecv(s);  // 另一块网卡刚送来过同一份 presence，跳过。
      return;
    }
    recent_[payload] = now;
    if (recent_.size() > kDedupeMax) {
      for (auto jt = recent_.begin(); jt != recent_.end();) {
        if (now - jt->second > kDedupeGc)
          jt = recent_.erase(jt);
        else
          ++jt;
      }
    }
    if (on_peer_)
      on_peer_.Run(payload, src_ip);
  }
  StartRecv(s);
}

void LanHeartbeat::SendOn(IfaceSocket* s) {
  if (!s || !s->socket)
    return;
  auto buf = base::MakeRefCounted<net::StringIOBuffer>(identity_payload_);
  s->socket->SendTo(buf.get(), identity_payload_.size(), group_,
                    base::BindOnce(&LanHeartbeat::OnSend, weak_factory_.GetWeakPtr()));
}

void LanHeartbeat::OnSend(int result) {
  // 组播发送失败（例如某块网卡不支持组播）仅记录，不中断其它网卡。
  if (result < 0)
    VLOG(1) << "LanHeartbeat send failed rv=" << result;
}

}  // namespace localim
