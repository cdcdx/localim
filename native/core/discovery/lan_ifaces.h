// 本机网卡枚举 + 对端候选地址排序：多网卡 / 多网段智能选路的公共基础。
//
// 多网卡机器（有线 + 无线 + VPN + 虚拟网卡）上，一台设备同时属于多个网段：
//  · 广播侧：presence 需要"每个网卡各发一份"，否则只有缺省路由所在网段能听见本机；
//  · 拨号侧：对端身份里带多个候选地址，本机应优先拨"与自己同子网"的那个。
// 本文件只做纯函数式计算（枚举 / 排序 / 选源址），不持有状态，便于单测与复用。
#ifndef LOCALIM_CORE_DISCOVERY_LAN_IFACES_H_
#define LOCALIM_CORE_DISCOVERY_LAN_IFACES_H_

#include <cstdint>
#include <string>
#include <vector>

namespace localim {

// 一个参与局域网发现的 IPv4 接口地址。
struct IfAddr {
  std::string ip;
  std::string name;     // 接口名（mac: en0 / linux: eth0 / win: 友好名）
  uint32_t prefix = 0;  // 子网前缀长度（IPv4 掩码位数）
  uint32_t index = 0;   // 系统接口索引（组播按接口收发用；0=缺省接口）

  bool operator==(const IfAddr& other) const = default;
};

// 枚举本机非回环 IPv4 接口（多网卡机器返回多条）；枚举失败时为空。
// 只能在允许 IO 的线程调用（net::GetNetworkList 约束）。
std::vector<IfAddr> LocalIfAddrs();

// 对端候选地址排序：与本网段同子网 > 私网其它段 > 链路本地 > 公网/其它 > 回环。
// 去重且保持同分内的原有顺序（稳定排序），空串丢弃。
std::vector<std::string> RankPeerAddrs(const std::vector<std::string>& candidates,
                                       const std::vector<IfAddr>& locals);

// 与 peer_ip 同子网时返回该本机地址（选源址：从哪个网段出去就用哪个源 IP）；
// 无同子网网卡时回落主地址。
std::string PickLocalAddrFor(const std::string& peer_ip,
                             const std::vector<IfAddr>& locals);

// 主地址：locals 里最"像局域网"的那个；无网卡时回落 127.0.0.1。
std::string PrimaryLocalAddr(const std::vector<IfAddr>& locals);

// a/b 是否同处 prefix 前缀的子网（任一侧不可解析即 false）。
bool SameSubnetIPv4(const std::string& a, const std::string& b, uint32_t prefix);

// 是否私网地址（10/8、172.16/12、192.168/16、100.64/10 运营商级 NAT）。
bool IsPrivateIPv4(const std::string& ip);

}  // namespace localim

#endif  // LOCALIM_CORE_DISCOVERY_LAN_IFACES_H_
