#include "core/ws_connection.h"

#include <stdint.h>

#include "base/base64.h"
#include "base/functional/callback.h"
#include "base/hash/sha1.h"
#include "base/logging.h"
#include "base/rand_util.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "base/memory/ref_counted.h"
#include "net/base/io_buffer.h"
#include "net/traffic_annotation/network_traffic_annotation.h"

namespace localim {

namespace {

constexpr size_t kReadChunk = 16 * 1024;

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("localim_ws_conn",
                                        "LocalIM WebSocket connection data traffic");

// 从 read_queue_ 里解析一条完整消息。返回 false=数据不足（继续积累）。在解析到
// 完整 payload 时调用 emit。opcode 0x01=text，0x08=close。
bool TryParse(std::string* queue, base::RepeatingCallback<void(uint8_t, std::string*)> emit) {
  while (queue->size() >= 2) {
    const uint8_t b0 = static_cast<uint8_t>((*queue)[0]);
    const uint8_t b1 = static_cast<uint8_t>((*queue)[1]);
    const bool fin = (b0 & 0x80) != 0;
    const uint8_t opcode = b0 & 0x0F;
    const bool masked = (b1 & 0x80) != 0;
    uint64_t len = b1 & 0x7F;

    size_t pos = 2;
    if (len == 126) {
      if (queue->size() < pos + 2) return false;
      len = (static_cast<uint8_t>((*queue)[pos]) << 8) | static_cast<uint8_t>((*queue)[pos + 1]);
      pos += 2;
    } else if (len == 127) {
      if (queue->size() < pos + 8) return false;
      len = 0;
      for (int i = 0; i < 8; ++i)
        len = (len << 8) | static_cast<uint8_t>((*queue)[pos + i]);
      pos += 8;
    }
    if (len > 64 * 1024 * 1024)
      return false;  // 上限保护：单帧 64MB。

    uint8_t mask[4] = {0, 0, 0, 0};
    if (masked) {
      if (queue->size() < pos + 4) return false;
      for (int i = 0; i < 4; ++i) mask[i] = static_cast<uint8_t>((*queue)[pos + i]);
      pos += 4;
    }
    if (queue->size() < pos + static_cast<size_t>(len)) return false;  // 帧未完整

    std::string payload = queue->substr(pos, static_cast<size_t>(len));
    if (masked) {
      for (size_t i = 0; i < payload.size(); ++i)
        payload[i] = static_cast<char>(static_cast<uint8_t>(payload[i]) ^ mask[i % 4]);
    }
    queue->erase(0, pos + static_cast<size_t>(len));

    // 仅支持 text/close 单帧消息；分帧(fin=false)骨架暂以失败处理。
    if (opcode == 0x08) return true;  // close 帧：由上层断开
    if (opcode == 0x01 && fin) {
      emit.Run(opcode, &payload);
      continue;
    }
    if (opcode == 0x00) continue;  // 延续帧，骨架忽略
  }
  return false;
}

}  // namespace

WsConnection::WsConnection(std::unique_ptr<net::StreamSocket> socket,
                           OnMessage on_message,
                           OnClosed on_closed,
                           base::RepeatingClosure on_drained)
    : socket_(std::move(socket)),
      read_buf_(base::MakeRefCounted<net::IOBufferWithSize>(kReadChunk)),
      on_message_(std::move(on_message)),
      on_closed_(std::move(on_closed)),
      on_drained_(std::move(on_drained)) {}

WsConnection::~WsConnection() = default;

void WsConnection::StartReading() {
  DoRead();
}

void WsConnection::StartReadingWith(const std::string& initial) {
  if (!initial.empty()) {
    read_queue_.append(initial);
    // 握手同批到达的帧立即解析；否则要等下一次 socket 读才触发，若客户端此后
    // 不再发包(如注册帧已随握手一起发出)将永远停在队列里。
    auto emit = base::BindRepeating(
        [](WsConnection* self, uint8_t opcode, std::string* payload) {
          if (opcode == 0x08) return;
          self->on_message_.Run(*payload);
        },
        this);
    TryParse(&read_queue_, emit);
  }
  DoRead();
}

void WsConnection::StartAsClient(const std::string& host, const std::string& path) {
  client_mode_ = true;
  client_handshaken_ = false;
  // Sec-WebSocket-Key：16 字节随机 -> base64。骨架不校验 Accept 内容，仅认 101。
  std::array<uint8_t, 16> key{};
  base::RandBytes(base::span<uint8_t>(key));
  const std::string key_b64 = base::Base64Encode(base::span<const uint8_t>(key));
  const std::string hs = base::StringPrintf(
      "GET %s HTTP/1.1\r\n"
      "Host: %s\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Key: %s\r\n"
      "Sec-WebSocket-Version: 13\r\n\r\n",
      path.c_str(), host.c_str(), key_b64.c_str());
  write_queue_.push_back(hs);
  TryWriteNext();
  DoReadHandshake();
}

void WsConnection::DoReadHandshake() {
  int rv = socket_->Read(
      read_buf_.get(), kReadChunk,
      base::BindOnce(&WsConnection::OnHandshakeRead, base::Unretained(this)));
  if (rv != net::ERR_IO_PENDING)
    OnHandshakeRead(rv);
}

void WsConnection::OnHandshakeRead(int result) {
  if (result <= 0) {
    Close();
    return;
  }
  client_handshake_buf_.append(read_buf_->data(), static_cast<size_t>(result));
  const size_t sep = client_handshake_buf_.find("\r\n\r\n");
  if (sep == std::string::npos) {
    DoReadHandshake();
    return;
  }
  // 101 之后的服务端立即帧字节(skeleton 下一般没有)预置进帧队列继续解析。
  if (client_handshake_buf_.rfind(" 101 ", 0) == std::string::npos &&
      client_handshake_buf_.rfind("HTTP/1.1 101", 0) == std::string::npos) {
    LOG(ERROR) << "parse_handshake: 非 101 应答, 忽略";
    Close();
    return;
  }
  client_handshaken_ = true;
  read_queue_.append(client_handshake_buf_, sep + 4);
  client_handshake_buf_.clear();
  DoRead();
}

bool WsConnection::SendText(const std::string& payload) {
  if (closed_) return false;
  std::string frame = client_mode_ ? EncodeClientFrame(0x01, payload)
                                   : EncodeServerFrame(0x01, payload);
  write_queue_.push_back(std::move(frame));
  TryWriteNext();
  return true;
}

void WsConnection::DoRead() {
  if (closed_) return;
  int rv = socket_->Read(read_buf_.get(), kReadChunk,
                         base::BindOnce(&WsConnection::OnRead, base::Unretained(this)));
  if (rv != net::ERR_IO_PENDING)
    OnRead(rv);
}

void WsConnection::OnRead(int result) {
  if (result <= 0) {
    Close();
    return;
  }
  read_queue_.append(std::string(read_buf_->data(), static_cast<size_t>(result)));
  auto emit = base::BindRepeating(
      [](WsConnection* self, uint8_t opcode, std::string* payload) {
        if (opcode == 0x08) return;
        self->on_message_.Run(*payload);
      },
      this);
  (void)TryParse(&read_queue_, emit);
  DoRead();
}

void WsConnection::TryWriteNext() {
  if (closed_ || writing_ || write_queue_.empty()) {
    if (write_queue_.empty() && on_drained_)
      on_drained_.Run();
    return;
  }
  const std::string& frame = write_queue_.front();
  writing_ = true;
  auto buf = base::MakeRefCounted<net::StringIOBuffer>(frame);
  int rv = socket_->Write(buf.get(), frame.size(),
                          base::BindOnce(&WsConnection::OnWrite, base::Unretained(this)),
                          kTrafficAnnotation);
  if (rv != net::ERR_IO_PENDING)
    OnWrite(rv);
}

void WsConnection::OnWrite(int result) {
  writing_ = false;
  if (result < 0) {
    Close();
    return;
  }
  if (!write_queue_.empty()) write_queue_.pop_front();
  TryWriteNext();
}

void WsConnection::Close() {
  if (closed_) return;
  closed_ = true;
  socket_.reset();
  if (on_closed_)
    on_closed_.Run();
}

std::string WsConnection::EncodeServerFrame(uint8_t opcode, const std::string& payload) {
  std::string out;
  out.push_back(static_cast<char>(0x80 | opcode));  // fin + opcode，服务端帧不掩码
  const size_t len = payload.size();
  if (len < 126) {
    out.push_back(static_cast<char>(len));
  } else if (len < 65536) {
    out.push_back(126);
    out.push_back(static_cast<char>((len >> 8) & 0xFF));
    out.push_back(static_cast<char>(len & 0xFF));
  } else {
    out.push_back(127);
    uint64_t big = static_cast<uint64_t>(len);
    for (int i = 7; i >= 0; --i) out.push_back(static_cast<char>((big >> (i * 8)) & 0xFF));
  }
  out += payload;
  return out;
}

std::string WsConnection::EncodeClientFrame(uint8_t opcode, const std::string& payload) {
  std::string out;
  out.push_back(static_cast<char>(0x80 | opcode));  // fin + opcode
  const size_t len = payload.size();
  if (len < 126) {
    out.push_back(static_cast<char>(0x80 | len));
  } else if (len < 65536) {
    out.push_back(static_cast<char>(0x80 | 126));
    out.push_back(static_cast<char>((len >> 8) & 0xFF));
    out.push_back(static_cast<char>(len & 0xFF));
  } else {
    out.push_back(static_cast<char>(0x80 | 127));
    uint64_t big = static_cast<uint64_t>(len);
    for (int i = 7; i >= 0; --i) out.push_back(static_cast<char>((big >> (i * 8)) & 0xFF));
  }
  // 客户端帧必须掩码：4 字节随机 mask key
  const uint32_t mask_key = static_cast<uint32_t>(base::RandGenerator(1ULL << 32));
  for (int i = 0; i < 4; ++i)
    out.push_back(static_cast<char>((mask_key >> (i * 8)) & 0xFF));
  for (size_t i = 0; i < payload.size(); ++i)
    out.push_back(static_cast<char>(static_cast<uint8_t>(payload[i]) ^ ((mask_key >> ((i % 4) * 8)) & 0xFF)));
  return out;
}

}  // namespace localim