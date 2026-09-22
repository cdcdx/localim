// LocalIM 守护进程编排层：在 IO 线程上接线 ws_hub + lan/relay 发现 +
// 会话/群/文件/远程，并把控制面信封派发到各业务命名空间。
#include "core/daemon.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/message_loop/message_pump_type.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "base/values.h"
#include "build/build_config.h"
#include "core/discovery/lan_heartbeat.h"
#include "core/discovery/relay_client.h"
#include "core/remote/remote_control.h"
#include "core/ws_connection.h"
#include "core/ws_hub.h"
#include "core/webserver.h"
#include "net/base/address_list.h"
#include "net/base/ip_address.h"
#include "net/base/ip_endpoint.h"
#include "net/base/network_handle.h"
#include "net/base/network_interfaces.h"
#include "net/socket/stream_socket.h"
#include "net/socket/tcp_client_socket.h"
#include "net/traffic_annotation/network_traffic_annotation.h"

namespace localim {

namespace {
constexpr uint16_t kDefaultLoopbackPort = 7615;  // WebUI 控制面
constexpr uint16_t kDefaultPeerPort = 7617;      // LAN 对端消息/文件
constexpr uint16_t kDefaultPresencePort = 7616;  // UDP 多播存在性
constexpr uint16_t kDefaultRelayPort = 7618;     // 跨网段引导中继
constexpr base::TimeDelta kPeerTimeout = base::Seconds(15);
constexpr size_t kOfflineQueueCap = 500;  // 每对端离线消息队列上限（FIFO 丢旧）
// 加密信封 HMAC 认证的事件时间窗：超出该偏斜即拒，防重放/防旧帧。
constexpr base::TimeDelta kFrameWindow = base::Minutes(2);
}  // namespace

namespace {

// 从 presence/注册载荷里抽出多网卡候选地址：既接受 ["1.2.3.4"] 也接受 [{"ip":"1.2.3.4"}]。
std::vector<std::string> ExtractAddrs(const base::DictValue& d) {
  std::vector<std::string> out;
  const base::ListValue* list = d.FindList("addrs");
  if (!list)
    return out;
  for (const auto& v : *list) {
    if (const std::string* s = v.GetIfString()) {
      out.push_back(*s);
    } else if (const base::DictValue* sub = v.GetIfDict()) {
      if (const std::string* ip = sub->FindString("ip"))
        out.push_back(*ip);
    }
  }
  return out;
}

std::string JoinAddrs(const std::vector<IfAddr>& ifaces) {
  std::string out;
  for (const auto& a : ifaces) {
    if (!out.empty())
      out += ", ";
    out += a.ip + "/" + base::NumberToString(a.prefix) + "(" + a.name + ")";
  }
  return out;
}

std::string DumpDict(const base::DictValue& d) {
  std::string out;
  base::JSONWriter::Write(d, &out);
  return out;
}

// FindString 返回裸指针，封装成带默认值的取读。
std::string GetStr(const base::DictValue& d, const char* key,
                   const std::string& fallback) {
  const std::string* v = d.FindString(key);
  return v ? *v : fallback;
}

}  // namespace

std::string Daemon::ConvKey(const base::DictValue& msg) const {
  // 单聊以"对方 deviceId"为会话键；群聊以 roomId(存于 to)为会话键。
  const std::string kind = GetStr(msg, "kind", "chat");
  if (kind == "room")
    return GetStr(msg, "to", "");
  const std::string from = GetStr(msg, "from", "");
  const std::string to = GetStr(msg, "to", "");
  return from == profile_.device_id ? to : from;
}

Daemon::Daemon(identity::Profile profile, const Ports& ports,
               base::FilePath data_dir, const DaemonOptions& options)
    : profile_(std::move(profile)),
      ports_(ports),
      data_dir_(data_dir.empty() ? identity::DefaultDataDir()
                                 : std::move(data_dir)),
      options_(options),
      peers_(base::RepeatingClosure()),
      rooms_(base::RepeatingClosure()),
      files_(base::RepeatingCallback<void(const FileSession&)>()) {
  // 命令行未显式覆盖时回落到编译期默认端口。
  if (ports_.webui == 0) ports_.webui = kDefaultLoopbackPort;
  if (ports_.peer == 0) ports_.peer = kDefaultPeerPort;
  if (ports_.presence == 0) ports_.presence = kDefaultPresencePort;
  if (ports_.relay == 0) ports_.relay = kDefaultRelayPort;
  if (ports_.web == 0 && !options_.webui_dist.empty())
    ports_.web = kDefaultLoopbackPort + 2;  // 默认 7619，可用 --web-port 覆盖
}

Daemon::~Daemon() {
  Stop();
}

void Daemon::Start() {
  if (started_)
    return;
  started_ = true;
  io_thread_ = std::make_unique<base::Thread>("localim-io");
  // 所有 net 对象都跑在这个线程上，而 net 内部会取 base::CurrentIOThread::Get()，
  // 其 DCHECK 要求 pump 为 IO 型；base::Thread 默认 DEFAULT 会直接 FATAL。
  base::Thread::Options options;
  options.message_pump_type = base::MessagePumpType::IO;
  if (!io_thread_->StartWithOptions(std::move(options))) {
    LOG(ERROR) << "Failed to start io thread";
    started_ = false;
    return;
  }
  io_task_runner_ = io_thread_->task_runner();
  io_task_runner_->PostTask(
      FROM_HERE, base::BindOnce(&Daemon::StartOnIo, weak_factory_.GetWeakPtr()));
}

void Daemon::Stop() {
  if (!started_)
    return;
  started_ = false;
  if (io_thread_) {
    io_thread_->task_runner()->PostTask(FROM_HERE, base::BindOnce([]() {}));
    io_thread_->Stop();
    io_thread_.reset();
  }
  io_task_runner_ = nullptr;
}

void Daemon::StartOnIo() {
  if (!options_.psk.empty())
    cipher_ = std::make_unique<MessageCipher>(options_.psk);
  messages_ = std::make_unique<MessageStore>(data_dir_);
  hub_ = std::make_unique<WsHub>();
  hub_->set_on_closed(base::BindRepeating(
      [](base::WeakPtr<Daemon> self, int client_id) {
        if (self)
          self->client_port_.erase(client_id);
      },
      weak_factory_.GetWeakPtr()));
  hub_->set_on_connect(base::BindRepeating(
      [](base::WeakPtr<Daemon> self, int client_id, uint16_t port) {
        // 连接建立即登记来源端口，保证静默订阅(不发任何请求)也能收到事件广播。
        if (self)
          self->client_port_[client_id] = port;
      },
      weak_factory_.GetWeakPtr()));
  hub_->Start(
      ports_.webui, ports_.peer,
      base::BindRepeating(&Daemon::OnHubMessage, weak_factory_.GetWeakPtr()));

  // 提供了 --webui-dist 时启用静态 WebUI 托管。
  if (!options_.webui_dist.empty()) {
    web_server_ = std::make_unique<WebServer>(options_.webui_dist);
    web_server_->Start(ports_.web);
  }

  locals_ = LocalIfAddrs();
  LOG(INFO) << "local interfaces (" << locals_.size() << "): " << JoinAddrs(locals_);
  // 公告/注册载荷带本机全部网卡地址（addrs），供多网段对端选路。
  const std::string self_payload = SelfPayload();

  heartbeat_ = std::make_unique<LanHeartbeat>(
      net::IPEndPoint(net::IPAddress(239, 255, 0, 16), ports_.presence),
      self_payload,
      base::BindRepeating(&Daemon::OnLanPeer, weak_factory_.GetWeakPtr()),
      base::BindRepeating(
          [](const std::string& msg) { LOG(WARNING) << "lan_heartbeat: " << msg; }));
  heartbeat_->Start();
  heartbeat_->Announce();

  const net::IPAddress relay_ip = net::IPAddress::FromIPLiteral(options_.relay_host)
                                      .value_or(net::IPAddress::IPv4Localhost());
  relay_ = std::make_unique<RelayClient>(
      net::IPEndPoint(relay_ip, ports_.relay), self_payload,
      base::BindRepeating(&Daemon::OnRelayEvent, weak_factory_.GetWeakPtr()),
      base::BindRepeating(
          [](bool connected) { LOG(INFO) << "relay connected=" << connected; }));
  relay_->Start();

  remote_ = std::make_unique<RemoteControl>();

  // 周期清退超时 peer。
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&Daemon::PruneStalePeers, weak_factory_.GetWeakPtr()),
      kPeerTimeout);
}

// 身份/注册载荷：deviceId + 主地址 host + 多网卡候选 addrs（[{ip,prefix,if}]）。
std::string Daemon::SelfPayload() const {
  base::ListValue addrs;
  for (const auto& a : locals_) {
    base::DictValue e;
    e.Set("ip", a.ip);
    e.Set("prefix", static_cast<int>(a.prefix));
    e.Set("if", a.name);
    addrs.Append(std::move(e));
  }
  base::DictValue self;
  self.Set("deviceId", profile_.device_id);
  self.Set("name", profile_.name);
  self.Set("platform", profile_.platform);
  self.Set("version", profile_.version);
  self.Set("host", PrimaryLocalAddr(locals_));
  self.Set("port", static_cast<int>(ports_.peer));
  self.Set("addrs", std::move(addrs));
  return DumpDict(self);
}

// 网卡快照变化（插拔网线 / Wi-Fi 切换 / VPN 拨号）时刷新：
// 重建每网卡组播 socket，并重发 presence 与 relay 注册，让对端拿到新地址表。
void Daemon::RefreshLocalIfaces() {
  const std::vector<IfAddr> now = LocalIfAddrs();
  if (now.empty() || now == locals_)
    return;  // 枚举为空（隧道/沙箱环境）时不拆现有配置。
  locals_ = now;
  LOG(INFO) << "local interfaces changed (" << locals_.size() << "): "
            << JoinAddrs(locals_);
  if (heartbeat_) {
    heartbeat_->SetPayload(SelfPayload());
    heartbeat_->RefreshIfaces();
    heartbeat_->Announce();
  }
  if (relay_)
    relay_->SetRegisterPayload(SelfPayload());
}

void Daemon::PruneStalePeers() {
  if (!started_)
    return;
  RefreshLocalIfaces();
  peers_.PruneStale(kPeerTimeout);
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&Daemon::PruneStalePeers, weak_factory_.GetWeakPtr()),
      kPeerTimeout);
}

void Daemon::AnnounceSelf() {
  if (heartbeat_)
    heartbeat_->Announce();
}

// 就地加密 pkt 的文字 body：body -> AES-GCM 密文(base64)，另加 iv/enc 标记。
// 空 body 或已被加密（带 enc 标记）时不做，返回是否真的有去改。
bool Daemon::SealMessageBody(base::DictValue& pkt) {
  if (!EncEnabled() || pkt.FindString("enc"))
    return false;  // 明文模式，或已被上一跳加密（避免二次加密）。
  const std::string* body = pkt.FindString("body");
  if (!body || body->empty())
    return false;
  std::string ct, iv;
  if (!cipher_->EncryptBody(*body, ct, iv))
    return false;
  pkt.Set("body", ct);
  pkt.Set("iv", iv);
  pkt.Set("enc", "aesgcm");
  return true;
}

// 入向解密：仅对带 enc 标记的消息体解密 body/iv。密钥不匹配/被篡改时返回 false。
bool Daemon::DecryptMessageBody(base::DictValue& pkt) {
  if (!EncEnabled())
    return false;
  const std::string* enc = pkt.FindString("enc");
  if (!enc || *enc != "aesgcm")
    return false;  // 明文消息（加密模式下不会出现，防御性保留）。
  const std::string ct = GetStr(pkt, "body", "");
  const std::string iv = GetStr(pkt, "iv", "");
  if (ct.empty() || iv.empty())
    return false;
  std::string plain;
  if (!cipher_->DecryptBody(ct, iv, plain))
    return false;
  pkt.Set("body", plain);
  pkt.Remove("iv");
  pkt.Remove("enc");
  return true;
}

// 校验 peer 信封的 HMAC 认证：缺签名拒、超时间窗拒、重放(nonce 已见)拒、
// 签名不符拒。明文模式(未设 --psk)始终放行，保持与旧版一致。
bool Daemon::VerifyPeerFrame(const std::string& json) {
  if (!EncEnabled())
    return true;
  auto parsed = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!parsed)
    return false;
  const base::DictValue& d = *parsed;
  const std::string from = GetStr(d, "fromId", "");
  const std::string ts = GetStr(d, "ts", "");
  const std::string nonce = GetStr(d, "nonce", "");
  const std::string sig = GetStr(d, "sig", "");
  if (from.empty() || ts.empty() || nonce.empty() || sig.empty()) {
    LOG(WARNING) << "reject peer frame: missing auth field from=" << from;
    return false;
  }
  int64_t ts_ms = 0;
  if (!base::StringToInt64(ts, &ts_ms)) {
    LOG(WARNING) << "reject peer frame: invalid timestamp";
    return false;
  }
  const int64_t now_ms =
      base::Time::Now().InMillisecondsSinceUnixEpoch();
  if (now_ms < ts_ms - kFrameWindow.InMilliseconds() ||
      now_ms > ts_ms + kFrameWindow.InMilliseconds()) {
    LOG(WARNING) << "reject peer frame: outside time window from=" << from;
    return false;
  }
  // 防重放：同一 (from,nonce) 只接受一次。上限保护，防长跑进程无界增长。
  if (seen_sig_.size() > 65536)
    seen_sig_.clear();
  const std::string key = from + "|" + nonce;
  if (!seen_sig_.insert(key).second) {
    LOG(WARNING) << "reject peer frame: replay from=" << from << " nonce=" << nonce;
    return false;
  }
  // 重算签名：对去掉 ts/nonce/sig 的规范化信封计算，与出向 Sign 同构。
  base::DictValue body = d.Clone();
  body.Remove("ts");
  body.Remove("nonce");
  body.Remove("sig");
  if (!cipher_->Verify(DumpDict(body), ts, nonce, sig)) {
    LOG(WARNING) << "reject peer frame: signature/key mismatch from=" << from;
    return false;
  }
  return true;
}

void Daemon::SendPeerMessage(const std::string& device_id, base::DictValue pkt) {
  // 启用加密时对文字 body 就地加密（媒体/文件元数据保持明文，路由字段不可加密）。
  if (EncEnabled())
    SealMessageBody(pkt);
  // 统一 relay 信封：inner ns/m 标 message/relay，收端按 HandleInboundPeerEnvelope 走。
  base::DictValue relay;
  relay.Set("ns", "message");
  relay.Set("m", "relay");
  relay.Set("fromId", profile_.device_id);
  relay.Set("pkt", pkt.Clone());
  relay.Set("innerNs", "message");
  relay.Set("innerM", "relay");
  SendPeerEnvelope(device_id, std::move(relay));
}

void Daemon::SendPeerSignal(const std::string& device_id,
                            const std::string& inner_ns,
                            const std::string& inner_m, base::DictValue pkt) {
  base::DictValue relay;
  relay.Set("ns", "media");
  relay.Set("m", "relay");
  relay.Set("fromId", profile_.device_id);
  relay.Set("pkt", std::move(pkt));
  relay.Set("innerNs", inner_ns);
  relay.Set("innerM", inner_m);
  SendPeerEnvelope(device_id, std::move(relay));
}

// 房间控制专用 peer 信封（ns=room），与 media 信令信封区分，入站走 HandleInboundRoomSignal。
void Daemon::SendPeerRoomSignal(const std::string& device_id,
                                const std::string& inner_m, base::DictValue pkt) {
  base::DictValue relay;
  relay.Set("ns", "room");
  relay.Set("m", "relay");
  relay.Set("fromId", profile_.device_id);
  relay.Set("pkt", std::move(pkt));
  relay.Set("innerNs", "room");
  relay.Set("innerM", inner_m);
  SendPeerEnvelope(device_id, std::move(relay));
}

// 序列化完整群信息（含成员表），供 invited/sync/成员事件携带。
static base::DictValue RoomPayload(Room* rm) {
  if (!rm)
    return {};
  base::DictValue out;
  out.Set("roomId", rm->room_id);
  out.Set("name", rm->name);
  out.Set("owner", rm->owner);
  base::ListValue members;
  for (const auto& m : rm->members)
    members.Append(m);
  out.Set("members", std::move(members));
  out.Set("seq", static_cast<double>(rm->seq));
  return out;
}

// 向本机 WebUI 推 room.<m> 事件（joined/sync/…），供前端刷新群列表。
void Daemon::EmitRoomEvent(const std::string& m, base::DictValue d) {
  base::DictValue ev;
  ev.Set("v", 1);
  ev.Set("dir", "ev");
  ev.Set("ns", "room");
  ev.Set("m", m);
  ev.Set("d", std::move(d));
  std::string out;
  base::JSONWriter::Write(ev, &out);
  SendToWebUi(out);
}

// 向群内(除 exclude 外)的在线成员广播 room.sync，保持各端成员表一致。
void Daemon::FanOutRoomSync(Room* rm, const std::string& exclude) {
  if (!rm)
    return;
  base::DictValue pkt = RoomPayload(rm);
  for (const auto& m : rm->members) {
    if (m == profile_.device_id || m == exclude || !peers_.Has(m))
      continue;
    SendPeerRoomSignal(m, "sync", pkt.Clone());
  }
}

void Daemon::SendPeerEnvelope(const std::string& device_id,
                              base::DictValue relay) {
  relay.Set("v", 1);
  relay.Set("dir", "req");
  // 携带发送方地址：收端据此补记 peer 记录，使回执等回复能在对端重启/新上线时立即拨号回来，
  // 不必等 presence 心跳（否则会出现"刚上线、尚未记到对端地址 → 回执发不出去"的竞态）。
  // 多网卡时选"与对端同网段"的那个源地址，对端回拨才会走本网段。
  const std::string peer_addr = PickPeerAddress(device_id);
  relay.Set("fromHost", peer_addr.empty()
                            ? PrimaryLocalAddr(locals_)
                            : PickLocalAddrFor(peer_addr, locals_));
  relay.Set("fromPort", static_cast<int>(ports_.peer));
  // 出向认证：--psk 模式下对整信封(除 ts/nonce/sig)做 HMAC-SHA256 签名，附带
  // 时间戳与随机 nonce，供收端验签、限时与防重放。明文模式不加字段，与旧版一致。
  if (EncEnabled()) {
    const std::string ts = base::NumberToString(
        base::Time::Now().InMillisecondsSinceUnixEpoch());
    const std::string nonce = base::HexEncode(base::RandBytesAsString(12));
    base::DictValue body = relay.Clone();
    body.Remove("ts");
    body.Remove("nonce");
    relay.Set("sig", cipher_->Sign(DumpDict(body), ts, nonce));
    relay.Set("ts", ts);
    relay.Set("nonce", nonce);
  }
  std::string relay_json;
  base::JSONWriter::Write(relay, &relay_json);
  // 复用已建立的对端连接。
  auto it = outgoing_.find(device_id);
  if (it != outgoing_.end() && it->second && !it->second->closed()) {
    it->second->SendText(relay_json);
    return;
  }
  // 无既有连接：按候选地址顺序拨号（失败自动换下一个）。
  DialNext(device_id, std::move(relay_json));
}

std::vector<std::string> Daemon::PeerCandidates(const PeerRecord& rec) const {
  std::vector<std::string> cands = rec.addrs;
  if (!rec.host.empty())
    cands.push_back(rec.host);
  std::vector<std::string> ranked = RankPeerAddrs(cands, locals_);
  // 上次拨通的地址优先复用，避免每次都从新候选重新试连（失败时仍会顺位降级）。
  auto r = route_.find(rec.device_id);
  if (r != route_.end()) {
    auto hit = std::find(ranked.begin(), ranked.end(), r->second);
    if (hit != ranked.end() && hit != ranked.begin())
      std::rotate(ranked.begin(), hit, hit + 1);
  }
  return ranked;
}

std::string Daemon::PickPeerAddress(const std::string& device_id) {
  const PeerRecord* rec = peers_.Find(device_id);
  if (!rec)
    return std::string();
  const std::vector<std::string> plan = PeerCandidates(*rec);
  return plan.empty() ? std::string() : plan.front();
}

// 按候选地址依次拨号：pending_json 非空时作为拨通后补发的帧（连接已存在时不会走到这里）。
void Daemon::DialNext(const std::string& device_id, std::string pending_json) {
  if (Connected(device_id))
    return;
  const PeerRecord* rec = peers_.Find(device_id);
  if (!rec) {
    LOG(WARNING) << "SendPeer: no peer record for " << device_id;
    return;
  }
  auto plan_it = dial_plan_.find(device_id);
  if (plan_it == dial_plan_.end()) {
    const std::vector<std::string> plan = PeerCandidates(*rec);
    if (plan.empty()) {
      LOG(WARNING) << "SendPeer: no peer address for " << device_id;
      return;
    }
    plan_it = dial_plan_.emplace(device_id, plan).first;
    dial_idx_[device_id] = 0;
  }
  const std::vector<std::string>& plan = plan_it->second;
  size_t& idx = dial_idx_[device_id];
  const uint16_t port = rec->port ? rec->port : ports_.peer;
  while (idx < plan.size()) {
    const std::string host = plan[idx++];
    auto parsed_ip = net::IPAddress::FromIPLiteral(host);
    if (!parsed_ip)
      continue;  // 非法候选跳过，继续下一个。
    if (!pending_json.empty())
      pending_out_[device_id] = std::move(pending_json);
    auto socket = std::make_unique<net::TCPClientSocket>(
        net::AddressList(net::IPEndPoint(*parsed_ip, port)), nullptr, nullptr,
        nullptr, net::NetLogSource(), net::handles::kInvalidNetworkHandle);
    net::StreamSocket* sock = socket.get();
    dialing_[device_id] = std::move(socket);
    const int rv = sock->Connect(
        base::BindOnce(&Daemon::OnPeerDialResult, weak_factory_.GetWeakPtr(),
                       device_id, host, port));
    LOG(INFO) << "SendPeer: dial " << device_id << " " << host << ":" << port
              << " (cand " << idx << "/" << plan.size() << ") rv=" << rv;
    if (rv != net::ERR_IO_PENDING)
      OnPeerDialResult(device_id, host, port, rv);
    return;
  }
  // 候选全部失败：丢弃待发帧，清空选路计划等下一次 presence 刷新候选表。
  LOG(WARNING) << "peer dial exhausted: " << device_id
               << " candidates=" << plan.size();
  dial_plan_.erase(device_id);
  dial_idx_.erase(device_id);
  pending_out_.erase(device_id);
}

void Daemon::OnPeerDialResult(const std::string& device_id,
                              const std::string& host, uint16_t port, int rv) {
  auto it = dialing_.find(device_id);
  if (it == dialing_.end())
    return;
  std::unique_ptr<net::StreamSocket> socket = std::move(it->second);
  dialing_.erase(it);
  if (rv != net::OK) {
    LOG(WARNING) << "peer dial failed: " << device_id << " @" << host << ":"
                 << port << " rv=" << rv;
    auto r = route_.find(device_id);
    if (r != route_.end() && r->second == host)
      route_.erase(r);  // 原优选地址不通：退回按排序重新选路。
    // 换下一个候选地址（多网卡/多网段），候选耗尽才丢弃待发帧。
    DialNext(device_id, std::string());
    return;
  }
  route_[device_id] = host;
  dial_plan_.erase(device_id);
  dial_idx_.erase(device_id);
  auto conn = std::make_unique<WsConnection>(
      std::move(socket),
      base::BindRepeating(&Daemon::OnOutgoingFrame, weak_factory_.GetWeakPtr(),
                          device_id),
      base::BindRepeating(&Daemon::OnOutgoingClosed, weak_factory_.GetWeakPtr(),
                          device_id),
      base::RepeatingClosure());
  conn->StartAsClient(host, "/peer");
  outgoing_[device_id] = std::move(conn);
  // 优先补投离线队列，再发拨号前暂存的单帧（媒体/群聊等直发路径）。
  FlushQueue(device_id);
  auto pd = pending_out_.find(device_id);
  if (pd != pending_out_.end()) {
    outgoing_[device_id]->SendText(pd->second);
    pending_out_.erase(pd);
  }
}

void Daemon::OnOutgoingFrame(const std::string& device_id,
                             const std::string& json) {
  // 本机发起的出站连接上收到的对端帧同样须通过认证，再进入消息处理。
  if (!VerifyPeerFrame(json))
    return;
  HandleInboundPeerEnvelope(json);
}

void Daemon::OnOutgoingClosed(const std::string& device_id) {
  outgoing_.erase(device_id);
  // 连接断开：若还有未投递的离线消息，下个在线事件会触发补投；这里不清理队列。
}

// 离线投递 —— 已建立的出站连接判断。
bool Daemon::Connected(const std::string& device_id) const {
  auto it = outgoing_.find(device_id);
  return it != outgoing_.end() && it->second && !it->second->closed();
}

// 入队一条离线消息（FIFO，超上限丢最旧）。
void Daemon::QueueOffline(const std::string& device_id, base::DictValue msg) {
  auto& q = offline_q_[device_id];
  q.push_back(std::move(msg));
  while (q.size() > kOfflineQueueCap)
    q.erase(q.begin());
  LOG(INFO) << "offline queued to " << device_id << " (qsz=" << q.size() << ")";
}

// 确保到对端的出站连接已建立；不携带待发帧（纯建连，成功后统一 FlushQueue）。
bool Daemon::EnsureConnection(const std::string& device_id) {
  if (Connected(device_id) || dialing_.count(device_id))
    return Connected(device_id);
  // 按候选地址顺序拨号（纯建连，成功后统一 FlushQueue 补投）。
  DialNext(device_id, std::string());
  return Connected(device_id);
}

// 对方上线/连接就绪时补投整队离线消息（按入队顺序）。
void Daemon::FlushQueue(const std::string& device_id) {
  if (!Connected(device_id))
    return;
  auto it = offline_q_.find(device_id);
  if (it == offline_q_.end())
    return;
  std::vector<base::DictValue> batch = std::move(it->second);
  offline_q_.erase(it);
  for (auto& msg : batch)
    SendPeerMessage(device_id, std::move(msg));
  LOG(INFO) << "offline flushed to " << device_id << " x" << batch.size();
}

// 有离线消息且对端（可能刚）上线：已连接则补投，否则尝试建连（拨号成功后再补投）。
void Daemon::MaybeRedeliver(const std::string& device_id) {
  if (offline_q_.find(device_id) == offline_q_.end())
    return;  // 无待投消息，无需因对方上线而建连。
  if (Connected(device_id))
    FlushQueue(device_id);
  else
    EnsureConnection(device_id);
}

// 送达回执：收到单聊消息后回给发送方，供其把待投状态更新为「已送达」。
// 复用既有出站连接，否则按地址拨号（SendPeerEnvelope 发出时携带自身地址，SendPeerMessage 的
// 收端据此补记 peer 记录，故对端刚重启/尚无 presence 条目时也能立即拨号回来）。
void Daemon::SendMessageAck(const std::string& device_id, const std::string& nonce) {
  if (device_id.empty() || nonce.empty() || device_id == profile_.device_id)
    return;
  base::DictValue relay;
  relay.Set("ns", "message");  // 走 message.relay，入站经 HandleInboundPeerEnvelope 路由到 ack 分支。
  relay.Set("m", "relay");
  relay.Set("fromId", profile_.device_id);
  relay.Set("pkt", base::DictValue().Set("ackOf", nonce));
  relay.Set("innerNs", "message");
  relay.Set("innerM", "ack");
  SendPeerEnvelope(device_id, std::move(relay));
}

void Daemon::HandleInboundPeerEnvelope(const std::string& json) {
  auto parsed = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!parsed)
    return;
  const base::DictValue& d = *parsed;
  const std::string from = GetStr(d, "fromId", "");
  if (from.empty() || from == profile_.device_id)
    return;
  const base::DictValue* pkt = d.FindDict("pkt");
  if (!pkt)
    return;
  const std::string ack_of = GetStr(*pkt, "ackOf", "");
  if (!ack_of.empty()) {
    // 送达回执：不落库，仅通知本机 WebUI 更新发送态为已送达。
    LOG(INFO) << "ack received from " << from << " nonce=" << ack_of;
    base::DictValue ev;
    ev.Set("v", 1);
    ev.Set("dir", "ev");
    ev.Set("ns", "message");
    ev.Set("m", "ack");
    ev.Set("d", base::DictValue().Set("to", from).Set("nonce", ack_of));
    std::string out;
    base::JSONWriter::Write(ev, &out);
    SendToWebUi(out);
    return;
  }
  base::DictValue chat = pkt->Clone();
  // 解密消息正文：带 enc 标记却解不开（密钥不匹配/被篡改）时整条丢弃，
  // 避免把密文当作明文广播给 WebUI。
  if (EncEnabled()) {
    const std::string* enc = chat.FindString("enc");
    if (enc && *enc == "aesgcm") {
      if (!DecryptMessageBody(chat)) {
        LOG(WARNING) << "drop undecryptable message from " << from;
        return;
      }
    }
  }
  chat.Set("fromId", from);
  chat.Set("from", from);          // 收端视角：发送方 deviceId（代替 uuid 别名，供 UI/落库用）
  chat.Set("direction", "in");
  // 收端会话键 = 对方(发送方) deviceId；群聊以 roomId(存于 to) 为键。
  chat.Set("conv", ConvKey(chat));
  if (messages_)
    messages_->Append(chat);
  const std::string kind = GetStr(chat, "kind", "chat");
  // 单聊送达回执：让发送端把该消息标记为已送达。
  if (kind == "chat" && from != profile_.device_id)
    SendMessageAck(from, GetStr(chat, "nonce", ""));
  base::DictValue ev;
  ev.Set("v", 1);
  ev.Set("dir", "ev");
  ev.Set("ns", kind == "room" ? "room" : "message");
  ev.Set("m", kind == "room" ? "room_message" : "chat");
  ev.Set("d", std::move(chat));
  std::string out;
  base::JSONWriter::Write(ev, &out);
  SendToWebUi(out);
  LOG(INFO) << "inbound peer message from " << from;
}

// media.relay：把对端 daemon 转发的 WebRTC 信令(SDP/ICE)广播给本机 WebUI。
void Daemon::HandleInboundMediaSignal(const std::string& json) {
  auto parsed = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!parsed)
    return;
  const base::DictValue& d = *parsed;
  const std::string from = GetStr(d, "fromId", "");
  if (from.empty() || from == profile_.device_id)
    return;
  const base::DictValue* pkt = d.FindDict("pkt");
  if (!pkt)
    return;
  const std::string inner_ns = GetStr(d, "innerNs", "media");
  const std::string inner_m = GetStr(d, "innerM", "");
  base::DictValue sig = pkt->Clone();
  sig.Set("fromId", from);
  sig.Set("from", from);  // 收端视角：远端 deviceId
  base::DictValue ev;
  ev.Set("v", 1);
  ev.Set("dir", "ev");
  ev.Set("ns", inner_ns);
  ev.Set("m", inner_m.empty() ? "media" : inner_m);
  ev.Set("d", std::move(sig));
  std::string out;
  base::JSONWriter::Write(ev, &out);
  SendToWebUi(out);
  LOG(INFO) << "inbound media signal from " << from << " m=" << inner_m;
}

// room.relay：跨设备房间控制。invited/sync 携带完整群信息并导入本地成员表；
// 其它(member_joined/member_left 等)转发给本机 WebUI。始终以 inner_m 回向 WebUI。
void Daemon::HandleInboundRoomSignal(const std::string& json) {
  auto parsed = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!parsed)
    return;
  const base::DictValue& d = *parsed;
  const std::string from = GetStr(d, "fromId", "");
  if (from.empty() || from == profile_.device_id)
    return;
  const base::DictValue* pkt = d.FindDict("pkt");
  if (!pkt)
    return;
  const std::string inner_m = GetStr(d, "innerM", "");
  // 被踢离群：被踢方(本端)在本地移除该群。
  if (inner_m == "member_left" && GetStr(*pkt, "member", "") == profile_.device_id)
    rooms_.Leave(GetStr(*pkt, "roomId", ""), profile_.device_id);
  // 成员加入：房主在本地登记新成员并广播 room.sync，其余成员仅转发事件。
  if (inner_m == "member_joined") {
    const std::string room_id = GetStr(*pkt, "roomId", "");
    const std::string member = GetStr(*pkt, "member", "");
    if (Room* rm = rooms_.Find(room_id)) {
      if (rm->owner == profile_.device_id) {
        bool added = rm->members.insert(member).second;
        if (added)
          ++rm->seq;
        FanOutRoomSync(rm, "");
      }
    }
  }
  // 导入完整成员表，让成员端也拥有群成员集合以便直接广播(友群 mesh)。
  if (inner_m == "invited" || inner_m == "sync" || inner_m == "room_sync") {
    std::vector<std::string> members;
    if (const base::ListValue* list = pkt->FindList("members")) {
      for (const auto& v : *list) {
        const std::string* s = v.GetIfString();
        if (s && !s->empty())
          members.push_back(*s);
      }
    }
    rooms_.Upsert(GetStr(*pkt, "roomId", ""), GetStr(*pkt, "name", ""),
                  GetStr(*pkt, "owner", ""), members);
  }
  base::DictValue sig = pkt->Clone();
  sig.Set("fromId", from);
  sig.Set("from", from);
  base::DictValue ev;
  ev.Set("v", 1);
  ev.Set("dir", "ev");
  ev.Set("ns", "room");
  ev.Set("m", inner_m.empty() ? "room_sync" : inner_m);
  ev.Set("d", std::move(sig));
  std::string out;
  base::JSONWriter::Write(ev, &out);
  SendToWebUi(out);
  LOG(INFO) << "inbound room signal from " << from << " m="
            << (inner_m.empty() ? "room_sync" : inner_m);
}

void Daemon::OnHubMessage(int client_id, uint16_t port,
                          const std::string& json) {
  client_port_[client_id] = port;
  if (port == ports_.webui) {
    // WebUI 控制面：走信封请求/响应。
    HandleEnvelope(client_id, json);
  } else {
    // 对端 daemon (peer-port)：先过 HMAC 认证（未设 --psk 时恒放行），才补记 peer 并路由。
      if (!VerifyPeerFrame(json))
        return;
      auto parsed = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
      if (parsed) {
      // 信封自带发送方地址时补记 peer 记录：让回执等回复能拨号回发送端（见 SendPeerEnvelope）。
      const std::string from_id = GetStr(*parsed, "fromId", "");
      const std::string* from_host = parsed->FindString("fromHost");
      if (!from_id.empty() && from_id != profile_.device_id && from_host && !from_host->empty()) {
        PeerRecord rec;
        rec.device_id = from_id;
        rec.host = *from_host;
        rec.addrs.push_back(*from_host);
        rec.port = static_cast<uint16_t>(parsed->FindInt("fromPort").value_or(0));
        rec.via = "lan";
        peers_.Upsert(rec);
      }
      const std::string ns = GetStr(*parsed, "ns", "");
      const std::string m = GetStr(*parsed, "m", "");
      if (ns == "message" && m == "relay")
        HandleInboundPeerEnvelope(DumpDict(*parsed));
      else if (ns == "media" && m == "relay")
        HandleInboundMediaSignal(DumpDict(*parsed));
      else if (ns == "room" && m == "relay")
        HandleInboundRoomSignal(DumpDict(*parsed));
      else
        OnRelayEvent(DumpDict(*parsed));
    }
  }
}

void Daemon::HandleEnvelope(int client_id, const std::string& json) {
  auto parsed = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!parsed) {
    SendError(client_id, "", -32600, "invalid envelope");
    return;
  }
  const base::DictValue& d = *parsed;
  const std::string dir = GetStr(d, "dir", "");
  const std::string ns = GetStr(d, "ns", "");
  const std::string method = GetStr(d, "m", "");
  const std::string txn = GetStr(d, "txn", "");
  const base::DictValue* payload = d.FindDict("d");

  if (dir != "req") {
    SendError(client_id, txn, -32600, "dir must be req");
    return;
  }
  base::DictValue empty_payload;
  Dispatch(client_id, ns, method, payload ? *payload : empty_payload, txn);
}

void Daemon::Dispatch(int client_id, const std::string& ns,
                      const std::string& method, const base::DictValue& d,
                      const std::string& txn) {
  if (ns == "identity") {
    if (method == "hello") {
      base::DictValue out = d.Clone();
      out.Set("deviceId", profile_.device_id);
      out.Set("name", profile_.name);
      out.Set("platform", profile_.platform);
      out.Set("version", profile_.version);
      SendResult(client_id, txn, ns, method, std::move(out));
      return;
    }
    if (method == "set_profile") {
      if (const std::string* name = d.FindString("name")) {
        profile_.name = *name;
        heartbeat_->Announce();
      }
      SendResult(client_id, txn, ns, method, {});
      return;
    }
  }

  if (ns == "discovery") {
    if (method == "scan_start") {
      is_scanning_ = true;
      heartbeat_->Announce();
      SendResult(client_id, txn, ns, method, {});
      return;
    }
    if (method == "scan_stop") {
      is_scanning_ = false;
      SendResult(client_id, txn, ns, method, {});
      return;
    }
  }

  if (ns == "roster") {
    if (method == "list") {
      base::ListValue peers;
      for (const auto& rec : peers_.List()) {
        // addrs：已知的候选地址（按当前选路排序），便于排障"从哪个地址拨通"。
        base::ListValue addrs;
        for (const auto& a : PeerCandidates(rec))
          addrs.Append(a);
        peers.Append(base::DictValue()
            .Set("deviceId", rec.device_id)
            .Set("name", rec.name)
            .Set("host", rec.host)
            .Set("netmask", rec.netmask)
            .Set("via", rec.via)
            .Set("port", static_cast<int>(rec.port))
            .Set("addrs", std::move(addrs))
            .Set("lastSeen", static_cast<double>(rec.last_seen_ms))
            .Set("caps", base::Value(base::ListValue()
                .Append("chat").Append("media")
                .Append("file").Append("remote").Append("share"))));
      }
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("peers", std::move(peers)));
      return;
    }
  }

  if (ns == "message") {
    if (method == "send") {
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("seq", 0).Set("accepted", true));
      const std::string kind = GetStr(d, "channel", GetStr(d, "kind", "chat"));
      base::DictValue chat = d.Clone();
      chat.Set("kind", kind);
      chat.Set("from", profile_.device_id);  // 补发送方，供 UI 判定左右与落库
      // 落库（含内参会话键，不出现在推送事件里）。
      if (messages_) {
        base::DictValue stored = chat.Clone();
        stored.Set("direction", "out");
        stored.Set("conv", ConvKey(stored));
        messages_->Append(stored);
      }
      // 对象事件：单聊 message.chat，群聊 room.room_message。
      base::DictValue chat_ev;
      chat_ev.Set("v", 1);
      chat_ev.Set("dir", "ev");
      chat_ev.Set("ns", kind == "room" ? "room" : "message");
      chat_ev.Set("m", kind == "room" ? "room_message" : "chat");
      chat_ev.Set("d", std::move(chat));
      std::string json;
      base::JSONWriter::Write(chat_ev, &json);
      SendToWebUi(json);

      const std::string to = GetStr(d, "to", "");
      if (kind == "room") {
        // 群聊：向在线成员直发广播（各端本地已同步成员表，mesh 众发）。
        if (Room* rm = rooms_.Find(to)) {
          for (const auto& m : rm->members) {
            if (m == profile_.device_id || !peers_.Has(m))
              continue;
            SendPeerMessage(m, d.Clone());
          }
        }
      } else if (!to.empty() && to != profile_.device_id) {
        if (Connected(to)) {
          SendPeerMessage(to, d.Clone());
        } else {
          // 对方不在线/不可达：先入队等待补投（离线投递），并尝试拨号建立连接。
          QueueOffline(to, d.Clone());
          MaybeRedeliver(to);
        }
      }
      return;
    }
    if (method == "history") {
      // d: { to: 对方deviceId|roomId, kind: chat|room, limit? }
      const std::string conv = GetStr(d, "to", "");
      const size_t limit = static_cast<size_t>(d.FindInt("limit").value_or(200));
      base::ListValue items;
      if (messages_ && !conv.empty())
        messages_->History(conv, limit, &items);
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("items", std::move(items))
                     .Set("cursor", ""));
      return;
    }
  }

  if (ns == "room") {
    if (method == "create") {
      const std::string name = GetStr(d, "name", "群聊");
      const std::string room_id = rooms_.Create(profile_.device_id, name);
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("roomId", room_id).Set("name", name));
      EmitRoomEvent("joined", RoomPayload(rooms_.Find(room_id)));
      return;
    }
    if (method == "join") {
      const std::string room_id = GetStr(d, "roomId", "");
      const bool ok = rooms_.Join(room_id, profile_.device_id);
      if (ok) {
        // 若房主是其它设备，请房主登记本成员并同步成员表（跨设备加入骨架）。
        if (Room* rm = rooms_.Find(room_id)) {
          if (rm->owner != profile_.device_id && peers_.Has(rm->owner))
            SendPeerRoomSignal(rm->owner, "member_joined",
                               base::DictValue().Set("roomId", room_id)
                                   .Set("member", profile_.device_id));
        }
        SendResult(client_id, txn, ns, method,
                   base::DictValue().Set("roomId", room_id));
        EmitRoomEvent("joined", RoomPayload(rooms_.Find(room_id)));
      } else {
        SendError(client_id, txn, -32001, "room not found");
      }
      return;
    }
    if (method == "leave") {
      const std::string room_id = GetStr(d, "roomId", "");
      const bool was_owner = rooms_.Find(room_id) &&
                             rooms_.Find(room_id)->owner == profile_.device_id;
      rooms_.Leave(room_id, profile_.device_id);
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("roomId", room_id));
      if (was_owner) {
        if (Room* rm = rooms_.Find(room_id))
          FanOutRoomSync(rm, profile_.device_id);  // 房主离群：通知剩余成员
      }
      return;
    }
    if (method == "invite") {
      // 仅房主可邀请：把成员加入群，向被邀请方发 invited，并向其余成员广播 room.sync。
      const std::string room_id = GetStr(d, "roomId", "");
      const std::string target = GetStr(d, "to", "");
      Room* rm = rooms_.Find(room_id);
      if (!rm || rm->owner != profile_.device_id) {
        SendError(client_id, txn, -32003, "not owner");
        return;
      }
      if (target.empty() || target == profile_.device_id) {
        SendError(client_id, txn, -32004, "bad member");
        return;
      }
      rm->members.insert(target);
      ++rm->seq;
      EmitRoomEvent("sync", RoomPayload(rm));  // 房主本端刷新成员表
      if (peers_.Has(target))
        SendPeerRoomSignal(target, "invited", RoomPayload(rm));
      FanOutRoomSync(rm, target);
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("roomId", room_id).Set("member", target));
      return;
    }
    if (method == "kick") {
      const std::string room_id = GetStr(d, "roomId", "");
      const std::string target = GetStr(d, "to", "");
      Room* rm = rooms_.Find(room_id);
      if (!rm || rm->owner != profile_.device_id) {
        SendError(client_id, txn, -32003, "not owner");
        return;
      }
      rm->members.erase(target);
      ++rm->seq;
      EmitRoomEvent("sync", RoomPayload(rm));  // 房主本端刷新成员表
      if (peers_.Has(target))
        SendPeerRoomSignal(target, "member_left",
                           base::DictValue().Set("roomId", room_id)
                               .Set("member", target)
                               .Set("name", rm->name));
      FanOutRoomSync(rm, target);
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("roomId", room_id).Set("member", target));
      return;
    }
    if (method == "members") {
      const std::string room_id = GetStr(d, "roomId", "");
      base::ListValue members;
      if (Room* rm = rooms_.Find(room_id)) {
        for (const auto& m : rm->members)
          members.Append(m);
      }
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("members", std::move(members))
                     .Set("owner", rooms_.Find(room_id)
                                        ? rooms_.Find(room_id)->owner : ""));
      return;
    }
  }

  if (ns == "media") {
    // 远程控制专用：本机注入（被控端 daemon 收到 -> input_injector），不做中继。
    if (method == "remote_host") {
      remote_->SetHosting(GetStr(d, "on", "true") == "true");
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("ok", true));
      return;
    }
    if (method == "remote_input") {
      const bool ok = remote_->HandleInput(
          GetStr(d, "t", ""), static_cast<float>(d.FindDouble("x").value_or(0)),
          static_cast<float>(d.FindDouble("y").value_or(0)),
          static_cast<int>(d.FindDouble("btn").value_or(0)),
          GetStr(d, "code", ""), static_cast<int>(d.FindDouble("d").value_or(0)));
      LOG(INFO) << "media.remote_input t=" << GetStr(d, "t", "")
                << " x=" << d.FindDouble("x").value_or(0)
                << " y=" << d.FindDouble("y").value_or(0)
                << " hosted=" << remote_->IsHosting() << " injected=" << ok;
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("ok", true));
      return;
    }
    // WebRTC 信令中继：offer/answer/ice/call_*/share_*/remote_* 都按 `to` 转发给对端 daemon，
    // 由对端广播给其 WebUI；数据面(P2P PeerConnection)在 WebUI 侧承载。这里本地仅回执。
    const std::string to = GetStr(d, "to", "");
    if (!to.empty() && to != profile_.device_id) {
      base::DictValue pkt = d.Clone();
      // 携带向/path 供对端 WebUI 识别意图；去掉本地回显用的 to 免除重发。
      pkt.Remove("to");
      if (peers_.Has(to))
        SendPeerSignal(to, "media", method, std::move(pkt));
      else
        LOG(WARNING) << "media." << method << ": unknown peer " << to;
    }
    SendResult(client_id, txn, ns, method,
               base::DictValue().Set("propagated", true));
    return;
  }

  if (ns == "file") {
    if (method == "transfer_begin") {
      const std::string file_id = GetStr(d, "fileId", "");
      FileSession s;
      s.file_id = file_id.empty()
                      ? base::NumberToString(base::Time::Now().ToInternalValue())
                      : file_id;
      if (const std::string* v = d.FindString("to")) s.to = *v;
      if (const std::string* v = d.FindString("name")) s.name = *v;
      if (const std::string* v = d.FindString("mime")) s.mime = *v;
      s.size = static_cast<long long>(d.FindDouble("size").value_or(0));
      s.state = "pending";
      files_.Begin(s);
      SendResult(client_id, txn, ns, method,
                 base::DictValue().Set("fileId", s.file_id));
      return;
    }
    if (method == "transfer_ack") {
      if (const std::string* id = d.FindString("fileId"))
        files_.Acknowledge(*id);
      SendResult(client_id, txn, ns, method, {});
      return;
    }
    if (method == "transfer_cancel") {
      if (const std::string* id = d.FindString("fileId"))
        files_.Cancel(*id);
      SendResult(client_id, txn, ns, method, {});
      return;
    }
  }

  if (ns == "profile") {
    if (method == "get") {
      base::ListValue rooms;
      for (const auto& rm : rooms_.List())
        rooms.Append(rm.room_id);
      SendResult(client_id, txn, ns, method,
                 base::DictValue()
                     .Set("deviceId", profile_.device_id)
                     .Set("name", profile_.name)
                     .Set("avatar", "")
                     .Set("joinedRooms", std::move(rooms)));
      return;
    }
  }

  SendError(client_id, txn, -32601, ns + "." + method + ": method not found");
}

void Daemon::SendResult(int client_id, const std::string& txn,
                        const std::string& ns, const std::string& method,
                        base::DictValue result) {
  base::DictValue res;
  res.Set("v", 1);
  res.Set("txn", txn);
  res.Set("dir", "res");
  res.Set("ns", ns);
  res.Set("m", method);
  res.Set("ok", true);
  res.Set("d", std::move(result));
  std::string json;
  base::JSONWriter::Write(res, &json);
  if (hub_)
    hub_->Send(client_id, json);
}

void Daemon::SendError(int client_id, const std::string& txn, int code,
                       const std::string& msg) {
  base::DictValue err;
  err.Set("code", code);
  err.Set("msg", msg);
  base::DictValue res;
  res.Set("v", 1);
  res.Set("txn", txn);
  res.Set("dir", "res");
  res.Set("ns", "");
  res.Set("m", "error");
  res.Set("ok", false);
  res.Set("d", std::move(err));
  std::string json;
  base::JSONWriter::Write(res, &json);
  if (hub_)
    hub_->Send(client_id, json);
}

void Daemon::SendToWebUi(const std::string& json) {
  if (!hub_)
    return;
  // 控制面事件只推给 localhost:{webui_port} 上的 WebUI 连接。
  for (const auto& [cid, port] : client_port_) {
    if (port == ports_.webui)
      hub_->Send(cid, json);
  }
}

void Daemon::OnLanPeer(const std::string& peer_json, const std::string& src_ip) {
  auto d = base::JSONReader::ReadDict(peer_json, base::JSON_PARSE_RFC);
  if (!d)
    return;
  const std::string id = GetStr(*d, "deviceId", "");
  if (id.empty() || id == profile_.device_id)
    return;

  PeerRecord rec;
  rec.device_id = id;
  rec.name = GetStr(*d, "name", id);
  rec.port = static_cast<uint16_t>(d->FindInt("port").value_or(0));
  rec.via = "lan";
  // 候选地址：组播源地址（本网段一定可达）优先，其次对端公告的多网卡地址，最后宿主 host。
  // 排序由 RankPeerAddrs 完成（同子网 > 私网 > 链路本地 > 公网 > 回环）。
  std::vector<std::string> cands;
  if (!src_ip.empty())
    cands.push_back(src_ip);
  for (const auto& a : ExtractAddrs(*d))
    cands.push_back(a);
  rec.addrs = cands;
  const std::vector<std::string> ranked = RankPeerAddrs(cands, locals_);
  rec.host = ranked.empty() ? GetStr(*d, "host", "") : ranked.front();
  peers_.Upsert(rec);
  MaybeRedeliver(id);  // 对方（重新）上线：补投离线队列

  base::ListValue addrs;
  for (const auto& a : ranked)
    addrs.Append(a);
  base::DictValue peer = base::DictValue()
      .Set("deviceId", id)
      .Set("name", rec.name)
      .Set("host", rec.host)
      .Set("netmask", "")
      .Set("via", "lan")
      .Set("port", static_cast<int>(rec.port))
      .Set("addrs", std::move(addrs))
      .Set("lastSeen", static_cast<double>(rec.last_seen_ms))
      .Set("caps", base::Value(base::ListValue()
              .Append("chat").Append("media").Append("file")
              .Append("remote").Append("share")));
  base::DictValue online_ev;
  online_ev.Set("v", 1);
  online_ev.Set("dir", "ev");
  online_ev.Set("ns", "discovery");
  online_ev.Set("m", "peer_found");
  online_ev.Set("d", std::move(peer));
  std::string json;
  base::JSONWriter::Write(online_ev, &json);
  SendToWebUi(json);
}

void Daemon::OnRelayEvent(const std::string& json) {
  auto d = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!d)
    return;
  const std::string op = GetStr(*d, "op", GetStr(*d, "event", ""));

  if (op == "peer_online" || op == "peer_found") {
    if (const std::string* id = d->FindString("deviceId")) {
      if (*id == profile_.device_id)
        return;
      PeerRecord rec;
      rec.device_id = *id;
      rec.name = GetStr(*d, "name", *id);
      rec.port = static_cast<uint16_t>(d->FindInt("port").value_or(0));
      rec.via = "relay";
      // 跨网段：relay 透传对端全部候选地址，按"是否与我同子网/私网"排序后择优拨号。
      rec.addrs = ExtractAddrs(*d);
      const std::vector<std::string> ranked = RankPeerAddrs(rec.addrs, locals_);
      rec.host = ranked.empty() ? GetStr(*d, "host", "") : ranked.front();
      peers_.Upsert(rec);
      MaybeRedeliver(*id);  // 对方（重新）上线：补投离线队列
    }
  } else if (op == "peer_offline" || op == "peer_lost") {
    if (const std::string* id = d->FindString("deviceId"))
      peers_.Remove(*id);
  }
}

}  // namespace localim