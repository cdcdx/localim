// 在线设备索引：LAN 多播 + relay 都汇入这里，供 roster 与路由使用。
#ifndef LOCALIM_CORE_SESSION_PEER_REGISTRY_H_
#define LOCALIM_CORE_SESSION_PEER_REGISTRY_H_

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/time/time.h"

namespace localim {

struct PeerRecord {
  std::string device_id;
  std::string name;
  std::string host;       // 直连 IP 或 relay 可达地址（当前选中/最近一次听到的）
  std::string netmask;
  std::string via;        // "lan" | "relay"
  uint16_t port = 0;      // 对端的 peer 监听口（公告携带；0 表示未知）
  long long last_seen_ms = 0;
  // 多网卡候选地址（对端公告的 addrs，含历史听到的源地址）。拨号时按
  // "与本网段同子网优先"排序逐个尝试；host 为其中当前最优的一个。
  std::vector<std::string> addrs;
};

class PeerRegistry {
 public:
  using OnChange = base::RepeatingCallback<void()>;
  explicit PeerRegistry(OnChange on_change) : on_change_(std::move(on_change)) {}

  void Upsert(const PeerRecord& rec);
  void Remove(const std::string& device_id);
  void PruneStale(base::TimeDelta timeout);
  std::vector<PeerRecord> List() const;
  bool Has(const std::string& device_id) const;
  PeerRecord* Find(const std::string& device_id);

 private:
  std::map<std::string, PeerRecord> peers_;
  OnChange on_change_;
};

}  // namespace localim

#endif  // LOCALIM_CORE_SESSION_PEER_REGISTRY_H_