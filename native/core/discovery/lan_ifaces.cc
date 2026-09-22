#include "core/discovery/lan_ifaces.h"

#include <algorithm>
#include <string>
#include <vector>

#include "base/containers/span.h"
#include "net/base/ip_address.h"
#include "net/base/network_interfaces.h"

namespace localim {
namespace {

// "192.168.1.5" -> 主机序 32 位；非 IPv4 返回 false。
bool IPv4ToUint32(const std::string& s, uint32_t* out) {
  auto ip = net::IPAddress::FromIPLiteral(s);
  if (!ip || !ip->IsIPv4())
    return false;
  base::span<const uint8_t> b = ip->bytes().span();
  *out = (static_cast<uint32_t>(b[0]) << 24) |
         (static_cast<uint32_t>(b[1]) << 16) |
         (static_cast<uint32_t>(b[2]) << 8) | static_cast<uint32_t>(b[3]);
  return true;
}

uint32_t PrefixMask(uint32_t prefix) {
  if (prefix == 0 || prefix >= 32)
    return 0xffffffffu;
  return ~((1u << (32 - prefix)) - 1u);
}

// 越小越优先；同分保持输入顺序（外层用稳定排序）。
int AddrScore(const std::string& ip, const std::vector<IfAddr>& locals) {
  uint32_t v = 0;
  if (!IPv4ToUint32(ip, &v))
    return 6;                 // 空 / 不可解析
  if ((v >> 24) == 127)
    return 5;                 // 回环：最后兜底（单机双实例调试用得上）
  uint32_t lv = 0;
  for (const auto& l : locals) {
    if (IPv4ToUint32(l.ip, &lv) &&
        (v & PrefixMask(l.prefix)) == (lv & PrefixMask(l.prefix)))
      return 0;               // 与本网段同子网：最优（无需跨路由）
  }
  if (IsPrivateIPv4(ip))
    return 1;                 // 同一私网但不同子网（多网段场景）
  if ((v >> 16) == 0xa9fe)
    return 2;                 // 169.254/16 链路本地
  return 3;                   // 公网 / 其它
}

}  // namespace

bool IsPrivateIPv4(const std::string& ip) {
  uint32_t v = 0;
  if (!IPv4ToUint32(ip, &v))
    return false;
  if ((v >> 24) == 10)
    return true;                                        // 10/8
  if ((v >> 24) == 172 && (v >> 20) == 0xac1)
    return true;                                        // 172.16/12
  if ((v >> 16) == 0xc0a8)
    return true;                                        // 192.168/16
  if ((v >> 22) == 0x191)
    return true;                                        // 100.64/10（CGNAT）
  return false;
}

bool SameSubnetIPv4(const std::string& a, const std::string& b, uint32_t prefix) {
  uint32_t va = 0, vb = 0;
  if (!IPv4ToUint32(a, &va) || !IPv4ToUint32(b, &vb))
    return false;
  const uint32_t mask = PrefixMask(prefix);
  return (va & mask) == (vb & mask);
}

std::vector<IfAddr> LocalIfAddrs() {
  std::vector<IfAddr> out;
  net::NetworkInterfaceList list;
  if (!net::GetNetworkList(&list, net::INCLUDE_HOST_SCOPE_VIRTUAL_INTERFACES))
    return out;
  for (const auto& nic : list) {
    if (!nic.address.IsIPv4() || nic.address.IsLoopback())
      continue;
    const std::string ip = nic.address.ToString();
    if (std::any_of(out.begin(), out.end(),
                    [&](const IfAddr& a) { return a.ip == ip; }))
      continue;  // 同一地址多条记录（多播索引不同）只保留一条
    IfAddr a;
    a.ip = ip;
    a.name = nic.friendly_name.empty() ? nic.name : nic.friendly_name;
    a.prefix = nic.prefix_length;
    a.index = nic.interface_index;
    out.push_back(std::move(a));
  }
  return out;
}

std::vector<std::string> RankPeerAddrs(const std::vector<std::string>& candidates,
                                       const std::vector<IfAddr>& locals) {
  std::vector<std::string> out;
  out.reserve(candidates.size());
  for (const auto& c : candidates) {
    if (c.empty())
      continue;
    if (std::find(out.begin(), out.end(), c) != out.end())
      continue;
    out.push_back(c);
  }
  std::stable_sort(out.begin(), out.end(),
                   [&](const std::string& a, const std::string& b) {
                     return AddrScore(a, locals) < AddrScore(b, locals);
                   });
  return out;
}

std::string PickLocalAddrFor(const std::string& peer_ip,
                             const std::vector<IfAddr>& locals) {
  for (const auto& l : locals) {
    if (SameSubnetIPv4(peer_ip, l.ip, l.prefix))
      return l.ip;
  }
  return PrimaryLocalAddr(locals);
}

std::string PrimaryLocalAddr(const std::vector<IfAddr>& locals) {
  const std::string* best = nullptr;
  int best_score = 7;
  for (const auto& l : locals) {
    const int score = AddrScore(l.ip, locals);
    if (score < best_score) {
      best_score = score;
      best = &l.ip;
    }
  }
  return best ? *best : std::string("127.0.0.1");
}

}  // namespace localim
