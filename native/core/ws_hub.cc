#include "core/ws_hub.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#include "base/base64.h"
#include "base/functional/callback.h"
#include "base/hash/sha1.h"
#include "base/logging.h"
#include "base/memory/ref_counted.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "core/ws_connection.h"
#include "net/base/ip_address.h"
#include "net/base/io_buffer.h"
#include "net/traffic_annotation/network_traffic_annotation.h"

namespace localim {

namespace {

constexpr size_t kChunk = 16 * 1024;

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("localim_ws_hub",
                                        "LocalIM WebSocket hub handshake and data traffic");

std::string ComputeAccept(const std::string& key) {
  return base::Base64Encode(
      base::SHA1HashString(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
}

// 从请求头取 Sec-WebSocket-Key；未含则返回空。
std::string ExtractKey(const std::string& headers) {
  for (const auto& line_base : base::SplitString(headers, "\r\n", base::TRIM_WHITESPACE,
                                                 base::SPLIT_WANT_NONEMPTY)) {
    if (!base::StartsWith(line_base, "Sec-WebSocket-Key:", base::CompareCase::INSENSITIVE_ASCII))
      continue;
    const std::string value = line_base.substr(std::strlen("Sec-WebSocket-Key:"));
    return std::string(base::TrimWhitespaceASCII(value, base::TRIM_ALL));
  }
  return std::string();
}

}  // namespace

WsHub::WsHub() = default;
WsHub::~WsHub() = default;

void WsHub::Start(uint16_t loopback_port, uint16_t peer_port, OnMessage on_message) {
  on_message_ = std::move(on_message);
  StartListener(loopback_port,
                net::IPEndPoint(net::IPAddress::IPv4Localhost(), loopback_port));
  StartListener(peer_port, net::IPEndPoint(net::IPAddress::IPv4AllZeros(), peer_port));
}

void WsHub::Stop() {
  listeners_.clear();
  clients_.clear();
}

void WsHub::StartListener(uint16_t port, const net::IPEndPoint& endpoint) {
  if (listeners_.count(port))
    return;
  auto server = std::make_unique<net::TCPServerSocket>(nullptr, net::NetLogSource());
  int rv = server->Listen(endpoint, /*backlog=*/32, /*ipv6_only=*/std::nullopt);
  if (rv != net::OK) {
    LOG(ERROR) << "WsHub: listen " << endpoint.ToString() << " failed rv=" << rv;
    return;
  }
  Listener l;
  l.server = std::move(server);
  listeners_[port] = std::move(l);
  DoAccept(port);
}

void WsHub::DoAccept(uint16_t port) {
  auto it = listeners_.find(port);
  if (it == listeners_.end() || it->second.accepting)
    return;
  Listener& l = it->second;
  l.accepting = true;
  auto p = std::make_unique<PendingHandshake>();
  p->io = base::MakeRefCounted<net::IOBufferWithSize>(kChunk);
  PendingHandshake* raw = p.get();
  l.pending.push_back(std::move(p));
  auto* server = l.server.get();
  int rv = server->Accept(&raw->socket,
                          base::BindOnce(&WsHub::OnAccept,
                                         weak_factory_.GetWeakPtr(), port));
  if (rv != net::ERR_IO_PENDING)
    OnAccept(port, rv);
}

void WsHub::OnAccept(uint16_t port, int result) {
  auto it = listeners_.find(port);
  if (it == listeners_.end())
    return;
  Listener& l = it->second;
  l.accepting = false;
  if (l.pending.empty())
    return;
  PendingHandshake* p = l.pending.back().get();
  if (result != net::OK || !p->socket) {
    l.pending.pop_back();
    DoAccept(port);
    return;
  }
  p->buffer.clear();
  ReadHandshake(port, p);
  // 继续接受下一个连接，避免单个慢/卡握手阻塞后续连接的建立。
  DoAccept(port);
}

void WsHub::ReadHandshake(uint16_t port, PendingHandshake* p) {
  int rv = p->socket->Read(p->io.get(), kChunk,
                           base::BindOnce(&WsHub::OnHandshakeRead,
                                          weak_factory_.GetWeakPtr(), port, p));
  if (rv != net::ERR_IO_PENDING)
    OnHandshakeRead(port, p, rv);
}

void WsHub::OnHandshakeRead(uint16_t port, PendingHandshake* p, int result) {
  if (result <= 0) {
    DropPending(port, p);
    return;
  }
  p->buffer.append(std::string(p->io->data(), static_cast<size_t>(result)));
  const size_t sep = p->buffer.find("\r\n\r\n");
  if (sep == std::string::npos) {
    if (p->buffer.size() > 16 * 1024) {
      DropPending(port, p);
      return;
    }
    ReadHandshake(port, p);
    return;
  }
  const std::string key = ExtractKey(p->buffer);
  if (key.empty()) {
    DropPending(port, p);
    return;
  }
  // 握手完成；把 \r\n\r\n 之后可能已随握手一并到达的帧字节留给新连接。
  p->buffer = p->buffer.substr(sep + 4);
  SendHandshake(port, p, key);
}

void WsHub::SendHandshake(uint16_t port, PendingHandshake* p,
                          const std::string& key) {
  std::string resp = "HTTP/1.1 101 Switching Protocols\r\n"
                     "Upgrade: websocket\r\n"
                     "Connection: Upgrade\r\n"
                     "Sec-WebSocket-Accept: " + ComputeAccept(key) + "\r\n\r\n";
  auto buf = base::MakeRefCounted<net::StringIOBuffer>(resp);
  int rv = p->socket->Write(buf.get(), resp.size(),
                            base::BindOnce(&WsHub::OnHandshakeWritten,
                                           weak_factory_.GetWeakPtr(), port, p),
                            kTrafficAnnotation);
  if (rv != net::ERR_IO_PENDING)
    OnHandshakeWritten(port, p, rv);
}

void WsHub::DropPending(uint16_t port, PendingHandshake* p) {
  auto it = listeners_.find(port);
  if (it == listeners_.end())
    return;
  auto& pending = it->second.pending;
  pending.erase(std::remove_if(pending.begin(), pending.end(),
                               [p](const std::unique_ptr<PendingHandshake>& x) {
                                 return x.get() == p;
                               }),
                pending.end());
}

void WsHub::OnHandshakeWritten(uint16_t port, PendingHandshake* p, int result) {
  if (result < 0) {
    DropPending(port, p);
    return;
  }
  const int client_id = next_id_++;
  auto conn = std::make_unique<WsConnection>(
      std::move(p->socket),
      base::BindRepeating(
          [](WsHub* hub, uint16_t p_port, int id, const std::string& json) {
            if (hub->on_message_)
              hub->on_message_.Run(id, p_port, json);
          },
          this, port, client_id),
      base::BindRepeating(&WsHub::OnClientClosed, base::Unretained(this), client_id),
      base::RepeatingClosure());
  if (!p->buffer.empty())
    conn->StartReadingWith(p->buffer);
  else
    conn->StartReading();
  clients_[client_id] = std::move(conn);
  if (on_connect_)
    on_connect_.Run(client_id, port);
  DropPending(port, p);
}

void WsHub::Send(int client_id, const std::string& json) {
  auto it = clients_.find(client_id);
  if (it != clients_.end())
    it->second->SendText(json);
}

void WsHub::Broadcast(const std::string& json) {
  for (auto& [id, conn] : clients_)
    conn->SendText(json);
}

void WsHub::OnClientClosed(int client_id) {
  clients_.erase(client_id);
  if (on_closed_)
    on_closed_.Run(client_id);
}

}  // namespace localim