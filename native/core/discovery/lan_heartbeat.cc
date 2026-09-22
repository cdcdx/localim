#include "core/discovery/lan_heartbeat.h"

#include <string>

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
}

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
  BindSocket();
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
  socket_.reset();
}

void LanHeartbeat::Announce() {
  if (!socket_)
    return;
  // 组播 + 本网段广播地址（广播需 AllowAddressReuse；此处以组播为主）。
  SendHeartbeat(group_);
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

void LanHeartbeat::BindSocket() {
  socket_ = std::make_unique<net::UDPSocket>(net::DatagramSocket::DEFAULT_BIND,
                                             nullptr, net::NetLogSource());
  // 组播接收惯例（跨平台含 Windows）：bind 到 0.0.0.0:<port> 再 JoinGroup，
  // 直接 bind 组播组地址会返回 ERR_ADDRESS_IN_USE。
  const net::IPEndPoint recv_endpoint(net::IPAddress::IPv4AllZeros(),
                                      group_.port());
  const int open_rv =
      socket_->Open(net::GetAddressFamily(group_.address()));
  if (open_rv != net::OK)
    return Fail("udp open failed: " + base::NumberToString(open_rv));
  socket_->SetMulticastLoopbackMode(true);
  socket_->SetMulticastTimeToLive(1);
  socket_->AllowAddressReuse();
  socket_->AllowAddressSharingForMulticast();
  const int bind_rv = socket_->Bind(recv_endpoint);
  if (bind_rv != net::OK)
    return Fail("udp bind failed: " + base::NumberToString(bind_rv));
  const int join_rv = socket_->JoinGroup(group_.address());
  if (join_rv != net::OK)
    return Fail("udp join group failed: " + base::NumberToString(join_rv));
  recv_buf_ = base::MakeRefCounted<net::IOBufferWithSize>(kMtu);
  StartRecv();
}

void LanHeartbeat::Fail(const std::string& msg) {
  if (on_error_)
    on_error_.Run(msg);
}

void LanHeartbeat::StartRecv() {
  if (!socket_ || !running_)
    return;
  int rv = socket_->RecvFrom(recv_buf_.get(), 65535, &recv_src_,
                             base::BindOnce(&LanHeartbeat::OnRecv,
                                            weak_factory_.GetWeakPtr()));
  if (rv != net::ERR_IO_PENDING)
    OnRecv(rv);
}

void LanHeartbeat::OnRecv(int result) {
  if (!running_)
    return;
  if (result > 0) {
    const std::string payload(recv_buf_->data(), static_cast<size_t>(result));
    on_peer_.Run(payload);
  }
  StartRecv();
}

void LanHeartbeat::SendHeartbeat(const net::IPEndPoint& dst) {
  if (!socket_)
    return;
  auto buf = base::MakeRefCounted<net::StringIOBuffer>(identity_payload_);
  socket_->SendTo(buf.get(), identity_payload_.size(), dst,
                  base::BindOnce(&LanHeartbeat::OnSend, weak_factory_.GetWeakPtr()));
}

void LanHeartbeat::OnSend(int result) {
  // 组播发送失败（例如未加入组）仅记录，不中断。
  if (result < 0)
    VLOG(1) << "LanHeartbeat send failed rv=" << result;
}

}  // namespace localim