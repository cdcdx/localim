#include "core/discovery/relay_server.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/base64.h"
#include "base/functional/callback.h"
#include "base/hash/sha1.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/memory/ref_counted.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/values.h"
#include "core/ws_connection.h"
#include "net/base/io_buffer.h"
#include "net/base/ip_address.h"
#include "net/base/ip_endpoint.h"
#include "net/socket/tcp_server_socket.h"
#include "net/traffic_annotation/network_traffic_annotation.h"

namespace localim {

namespace {

constexpr size_t kChunk = 16 * 1024;

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("localim_relay_server",
                                        "LocalIM cross-subnet relay server traffic");

std::string GetStr(const base::DictValue& d, const char* key,
                   const std::string& fallback) {
  const std::string* v = d.FindString(key);
  return v ? *v : fallback;
}

std::string ComputeAccept(const std::string& key) {
  return base::Base64Encode(
      base::SHA1HashString(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
}

std::string ExtractKey(const std::string& headers) {
  for (const auto& line : base::SplitString(headers, "\r\n", base::TRIM_WHITESPACE,
                                            base::SPLIT_WANT_NONEMPTY)) {
    if (!base::StartsWith(line, "Sec-WebSocket-Key:", base::CompareCase::INSENSITIVE_ASCII))
      continue;
    const std::string value = line.substr(std::strlen("Sec-WebSocket-Key:"));
    return std::string(base::TrimWhitespaceASCII(value, base::TRIM_ALL));
  }
  return std::string();
}

}  // namespace

RelayServer::RelayServer() = default;
RelayServer::~RelayServer() {
  Stop();
}

std::vector<std::string> RelayServer::registered_devices() const {
  std::vector<std::string> out;
  for (const auto& [id, cid] : routes_)
    if (clients_.count(cid)) out.push_back(id);
  return out;
}

void RelayServer::Start(uint16_t port) {
  server_ = std::make_unique<net::TCPServerSocket>(nullptr, net::NetLogSource());
  // 绑定所有接口：跨网段 daemon 需能直连到本 relay(不可只绑回环)。
  const net::IPEndPoint endpoint(net::IPAddress::IPv4AllZeros(), port);
  const int rv = server_->Listen(endpoint, /*backlog=*/32, /*ipv6_only=*/std::nullopt);
  if (rv != net::OK) {
    LOG(ERROR) << "RelayServer: listen " << endpoint.ToString() << " failed rv=" << rv;
    return;
  }
  LOG(INFO) << "relay_server listening on " << endpoint.ToString();
  DoAccept();
}

void RelayServer::Stop() {
  weak_factory_.InvalidateWeakPtrs();
  server_.reset();
  pending_handshakes_.clear();
  clients_.clear();
  routes_.clear();
}

void RelayServer::DoAccept() {
  if (!server_ || accepting_)
    return;
  accepting_ = true;
  auto p = std::make_unique<PendingHandshake>();
  p->io = base::MakeRefCounted<net::IOBufferWithSize>(kChunk);
  PendingHandshake* raw = p.get();
  pending_handshakes_.push_back(std::move(p));
  auto* srv = server_.get();
  const int rv = srv->Accept(&raw->socket,
                             base::BindOnce(&RelayServer::OnAccept,
                                            weak_factory_.GetWeakPtr()));
  if (rv != net::ERR_IO_PENDING)
    OnAccept(rv);
}

void RelayServer::OnAccept(int result) {
  accepting_ = false;
  if (pending_handshakes_.empty())
    return;
  PendingHandshake* p = pending_handshakes_.back().get();
  if (result != net::OK || !p->socket) {
    pending_handshakes_.pop_back();
    DoAccept();
    return;
  }
  p->buffer.clear();
  ReadHandshake(p);
  DoAccept();  // 继续接受下一条，避免慢握手阻塞后续连接。
}

void RelayServer::ReadHandshake(PendingHandshake* p) {
  const int rv = p->socket->Read(
      p->io.get(), kChunk,
      base::BindOnce(&RelayServer::OnHandshakeRead, weak_factory_.GetWeakPtr(), p));
  if (rv != net::ERR_IO_PENDING)
    OnHandshakeRead(p, rv);
}

void RelayServer::OnHandshakeRead(PendingHandshake* p, int result) {
  if (result <= 0) {
    DropPending(p);
    return;
  }
  p->buffer.append(std::string(p->io->data(), static_cast<size_t>(result)));
  const size_t sep = p->buffer.find("\r\n\r\n");
  if (sep == std::string::npos) {
    if (p->buffer.size() > 16 * 1024) {
      DropPending(p);
      return;
    }
    ReadHandshake(p);
    return;
  }
  const std::string key = ExtractKey(p->buffer);
  if (key.empty()) {
    DropPending(p);
    return;
  }
  // 握手完成；把 \r\n\r\n 之后可能已随握手一并到达的帧字节留给已建立连接。
  p->buffer = p->buffer.substr(sep + 4);
  SendHandshake(p, key);
}

void RelayServer::SendHandshake(PendingHandshake* p, const std::string& key) {
  const std::string resp =
      "HTTP/1.1 101 Switching Protocols\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Accept: " + ComputeAccept(key) + "\r\n\r\n";
  auto buf = base::MakeRefCounted<net::StringIOBuffer>(resp);
  const int rv = p->socket->Write(
      buf.get(), resp.size(),
      base::BindOnce(&RelayServer::OnHandshakeWritten, weak_factory_.GetWeakPtr(), p),
      kTrafficAnnotation);
  if (rv != net::ERR_IO_PENDING)
    OnHandshakeWritten(p, rv);
}

void RelayServer::DropPending(PendingHandshake* p) {
  pending_handshakes_.erase(
      std::remove_if(pending_handshakes_.begin(), pending_handshakes_.end(),
                     [p](const std::unique_ptr<PendingHandshake>& x) {
                       return x.get() == p;
                     }),
      pending_handshakes_.end());
}

void RelayServer::OnHandshakeWritten(PendingHandshake* p, int result) {
  if (result < 0) {
    DropPending(p);
    return;
  }
  const int client_id = next_id_++;
  Client c;
  c.conn = std::make_unique<WsConnection>(
      std::move(p->socket),
      base::BindRepeating(&RelayServer::OnClientMessage,
                          weak_factory_.GetWeakPtr(), client_id),
      base::BindRepeating(&RelayServer::OnClientClosed,
                          weak_factory_.GetWeakPtr(), client_id),
      base::RepeatingClosure());
  // 必须先入库再启动读取：StartReadingWith 会同步解析握手同批到达的帧并触发
  // OnClientMessage，此时 clients_ 必须已含该 id，否则首帧注册会被丢弃。
  clients_[client_id] = std::move(c);
  auto* conn = clients_[client_id].conn.get();
  if (!p->buffer.empty())
    conn->StartReadingWith(p->buffer);
  else
    conn->StartReading();
  DropPending(p);
  LOG(INFO) << "relay client connected id=" << client_id;
}

void RelayServer::OnClientMessage(int client_id, const std::string& json) {
  auto it = clients_.find(client_id);
  if (it == clients_.end())
    return;
  auto d = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!d)
    return;
  const std::string device_id = GetStr(*d, "deviceId", "");
  const std::string op = GetStr(*d, "op", "");
  if (device_id.empty())
    return;  // 仅认携带身份的消息；骨架不处理匿名帧。
  // 注册（含重连/心跳重注册）。当前 RelayClient 的 register 载荷不带 op，按 deviceId 识别。
  if (op.empty() || op == "register") {
    // 多网卡候选地址：既接受 ["1.2.3.4", ...] 也接受 [{"ip":"1.2.3.4","prefix":24}]，
    // 统一归一成字符串数组后随 peer_online 透传。
    std::vector<std::string> addrs;
    if (const base::ListValue* list = d->FindList("addrs")) {
      for (const auto& v : *list) {
        if (const std::string* s = v.GetIfString()) {
          addrs.push_back(*s);
        } else if (const base::DictValue* sub = v.GetIfDict()) {
          if (const std::string* ip = sub->FindString("ip"))
            addrs.push_back(*ip);
        }
      }
    }
    Register(client_id, {
        {"deviceId", device_id},
        {"name", GetStr(*d, "name", device_id)},
        {"host", GetStr(*d, "host", "")},
        {"port", std::to_string(d->FindInt("port").value_or(0))},
    }, addrs);
  }
}

void RelayServer::Register(int client_id,
                           const std::map<std::string, std::string>& fields,
                           const std::vector<std::string>& addrs) {
  auto it = clients_.find(client_id);
  if (it == clients_.end())
    return;
  const std::string device_id = fields.at("deviceId");
  // 同一 deviceId 重连/重复注册：旧槽位让位，避免旧连接断开时误报 offline。
  const auto prior = routes_.find(device_id);
  if (prior != routes_.end() && prior->second != client_id) {
    if (auto old = clients_.find(prior->second); old != clients_.end())
      old->second.device_id.clear();
  }

  Client& c = it->second;
  c.device_id = device_id;
  c.name = fields.at("name");
  c.host = fields.at("host");
  c.addrs = addrs;
  uint32_t port = 0;
  c.port = base::StringToUint(fields.at("port"), &port) && port <= 65535
               ? static_cast<uint16_t>(port) : 0;

  // 回放既有 roster 给新客户端（每条 peer_online），使新节点发现已在线节点。
  for (const auto& [id, cid] : routes_) {
    if (id == device_id)
      continue;
    if (auto o = clients_.find(cid); o != clients_.end() && !o->second.device_id.empty())
      SendPeerOnline(client_id, id);
  }
  routes_[device_id] = client_id;
  LOG(INFO) << "relay register " << device_id << " host=" << c.host
            << " port=" << c.port << " routes=" << routes_.size();

  // 广播本节点上线给其它所有已注册客户端。
  BroadcastExcept(client_id, BuildPeerOnlineJson(c));
}

void RelayServer::SendPeerOnline(int client_id, const std::string& device_id) {
  auto it = routes_.find(device_id);
  if (it == routes_.end())
    return;
  if (auto c = clients_.find(it->second); c != clients_.end() && !c->second.device_id.empty())
    Send(client_id, BuildPeerOnlineJson(c->second));
}

std::string RelayServer::BuildPeerOnlineJson(const Client& c) {
  base::DictValue d = base::DictValue()
      .Set("op", "peer_online")
      .Set("deviceId", c.device_id)
      .Set("name", c.name)
      .Set("host", c.host)
      .Set("port", static_cast<int>(c.port))
      .Set("via", "relay");
  if (!c.addrs.empty()) {
    base::ListValue addrs;
    for (const auto& a : c.addrs)
      addrs.Append(a);
    d.Set("addrs", std::move(addrs));
  }
  std::string out;
  base::JSONWriter::Write(d, &out);
  return out;
}

std::string RelayServer::BuildPeerOfflineJson(const std::string& device_id) {
  base::DictValue d = base::DictValue()
      .Set("op", "peer_offline")
      .Set("deviceId", device_id);
  std::string out;
  base::JSONWriter::Write(d, &out);
  return out;
}

void RelayServer::Send(int client_id, const std::string& json) {
  if (auto it = clients_.find(client_id); it != clients_.end())
    it->second.conn->SendText(json);
}

void RelayServer::BroadcastExcept(int except_client_id, const std::string& json) {
  for (auto& [cid, c] : clients_)
    if (cid != except_client_id && !c.device_id.empty())
      c.conn->SendText(json);
}

void RelayServer::OnClientClosed(int client_id) {
  const auto it = clients_.find(client_id);
  if (it == clients_.end())
    return;
  const std::string device_id = it->second.device_id;
  clients_.erase(it);
  if (!device_id.empty()) {
    if (auto r = routes_.find(device_id); r != routes_.end() && r->second == client_id) {
      routes_.erase(r);
      LOG(INFO) << "relay unregister " << device_id << " routes=" << routes_.size();
      BroadcastExcept(client_id, BuildPeerOfflineJson(device_id));
    }
  }
}

}  // namespace localim