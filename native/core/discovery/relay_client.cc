#include "core/discovery/relay_client.h"

#include <cstdint>
#include <string>

#include "base/base64.h"
#include "base/functional/callback.h"
#include "base/hash/sha1.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "core/ws_connection.h"
#include "net/base/io_buffer.h"
#include "net/base/network_handle.h"
#include "net/socket/tcp_client_socket.h"
#include "net/traffic_annotation/network_traffic_annotation.h"

namespace localim {

namespace {

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("localim_relay_client",
                                        "LocalIM cross-subnet relay discovery traffic");

// 解析服务端（relay 侧）未掩码帧；返回是否解析出至少一条 text 消息。两参数回调
// 形如 [](const std::string& payload){ }。
template <typename Emit>
bool TryParseServerFrames(std::string* queue, Emit emit) {
  bool parsed = false;
  while (queue->size() >= 2) {
    const uint8_t b0 = static_cast<uint8_t>((*queue)[0]);
    const uint8_t b1 = static_cast<uint8_t>((*queue)[1]);
    const uint8_t opcode = b0 & 0x0F;
    uint64_t len = b1 & 0x7F;
    size_t pos = 2;
    if (len == 126) {
      if (queue->size() < pos + 2) return parsed;
      len = (static_cast<uint8_t>((*queue)[pos]) << 8) | static_cast<uint8_t>((*queue)[pos + 1]);
      pos += 2;
    } else if (len == 127) {
      if (queue->size() < pos + 8) return parsed;
      len = 0;
      for (int i = 0; i < 8; ++i) len = (len << 8) | static_cast<uint8_t>((*queue)[pos + i]);
      pos += 8;
    }
    if (queue->size() < pos + static_cast<size_t>(len)) return parsed;
    const std::string payload = queue->substr(pos, static_cast<size_t>(len));
    queue->erase(0, pos + static_cast<size_t>(len));
    if (opcode == 0x01) {
      emit(payload);
      parsed = true;
    } else if (opcode == 0x08) {
      return parsed;
    }
  }
  return parsed;
}

std::string BuildHandshake(const std::string& host_header) {
  return "GET /ws HTTP/1.1\r\n"
         "Host: " + host_header + "\r\n"
         "Upgrade: websocket\r\n"
         "Connection: Upgrade\r\n"
         "Sec-WebSocket-Key: " + base::Base64Encode("localim-relay") + "\r\n"
         "Sec-WebSocket-Version: 13\r\n\r\n";
}

}  // namespace

RelayClient::RelayClient(const net::IPEndPoint& relay,
                         std::string register_payload,
                         OnEvent on_event,
                         OnState on_state)
    : relay_(relay),
      register_payload_(std::move(register_payload)),
      on_event_(std::move(on_event)),
      on_state_(std::move(on_state)) {}

RelayClient::~RelayClient() {
  Stop();
}

void RelayClient::Start() {
  if (running_)
    return;
  running_ = true;
  Connect();
}

void RelayClient::Stop() {
  running_ = false;
  weak_factory_.InvalidateWeakPtrs();
  socket_.reset();
}

void RelayClient::Connect() {
  socket_ = std::make_unique<net::TCPClientSocket>(
      net::AddressList(relay_), nullptr, nullptr, nullptr, net::NetLogSource(),
      net::handles::kInvalidNetworkHandle);
  const int rv = socket_->Connect(
      base::BindOnce(&RelayClient::OnConnected, weak_factory_.GetWeakPtr()));
  if (rv != net::ERR_IO_PENDING)
    OnConnected(rv);
}

void RelayClient::OnConnected(int result) {
  if (result != net::OK) {
    if (on_state_)
      on_state_.Run(false);
    if (running_) {
      base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE, base::BindOnce(&RelayClient::Connect, weak_factory_.GetWeakPtr()),
          base::Seconds(5));
    }
    return;
  }
  if (on_state_)
    on_state_.Run(true);
  SendRegistration();
  StartRecv();
}

void RelayClient::SendRegistration() {
  if (!socket_)
    return;
  const std::string handshake = BuildHandshake("relay:7618");
  // 先握手(base64 key 固定)，然后直接发一帧 register。握手应答(101)在收包路径跳过。
  auto buf = base::MakeRefCounted<net::StringIOBuffer>(handshake);
  const int rv = socket_->Write(buf.get(), handshake.size(),
                                base::BindOnce([](int) {}), kTrafficAnnotation);
  (void)rv;
  SendEnvelope(register_payload_);
}

void RelayClient::SendEnvelope(const std::string& json) {
  if (!socket_)
    return;
  auto frame = WsConnection::EncodeClientFrame(0x01, json);
  auto buf = base::MakeRefCounted<net::StringIOBuffer>(frame);
  socket_->Write(buf.get(), frame.size(), base::BindOnce([](int) {}),
                 kTrafficAnnotation);
}

void RelayClient::StartRecv() {
  if (!running_ || !socket_)
    return;
  if (!buf_)
    buf_ = base::MakeRefCounted<net::IOBufferWithSize>(65536);
  const int rv = socket_->Read(buf_.get(), 65536,
                               base::BindOnce(&RelayClient::OnRecv,
                                              weak_factory_.GetWeakPtr()));
  if (rv != net::ERR_IO_PENDING)
    OnRecv(rv);
}

void RelayClient::OnRecv(int result) {
  if (!running_)
    return;
  if (result <= 0) {
    if (on_state_)
      on_state_.Run(false);
    if (running_) {
      base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE, base::BindOnce(&RelayClient::Connect, weak_factory_.GetWeakPtr()),
          base::Seconds(5));
    }
    return;
  }
  read_queue_.append(std::string(buf_->data(), static_cast<size_t>(result)));
  // 尚未跳过 HTTP 101 握手应答时，先把应答头剥离到 \r\n\r\n，避免 `TryParseServerFrames`
  // 把 101 的字节误当 WS 帧(首字节 0x48 的 opcode=0x08 会被当作 close 帧)掐断或污染后续帧。
  if (!handshaken_) {
    const size_t sep = read_queue_.find("\r\n\r\n");
    if (sep == std::string::npos) {
      if (read_queue_.size() > 64 * 1024) {
        Stop();
        return;
      }
      StartRecv();
      return;
    }
    read_queue_.erase(0, sep + 4);
    handshaken_ = true;
  }
  TryParseServerFrames(&read_queue_, [this](const std::string& payload) {
    // 仅透传服务端下发的 JSON 事件帧(peer_online/offline)。
    if (!payload.empty() && payload[0] == '{') {
      if (on_event_)
        on_event_.Run(payload);
    }
  });
  StartRecv();
}

}  // namespace localim