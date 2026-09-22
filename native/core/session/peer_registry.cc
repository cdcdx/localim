#include "core/session/peer_registry.h"

#include <algorithm>
#include <utility>

#include "base/time/time.h"

namespace localim {

void PeerRegistry::Upsert(const PeerRecord& rec) {
  auto it = peers_.find(rec.device_id);
  if (it == peers_.end()) {
    PeerRecord& slot = peers_[rec.device_id];
    slot = rec;
    slot.last_seen_ms = base::Time::Now().ToDeltaSinceWindowsEpoch().InMilliseconds();
    if (on_change_)
      on_change_.Run();
    return;
  }
  // 已存在：候选地址与已知字段做合并，避免"只带一个地址的增量更新"
  // （例如 peer 信封回执路径）把多网卡候选表冲掉。
  PeerRecord& old = it->second;
  std::vector<std::string> merged = rec.addrs;
  for (const auto& a : old.addrs) {
    if (std::find(merged.begin(), merged.end(), a) == merged.end())
      merged.push_back(a);
  }
  PeerRecord slot = rec;
  slot.addrs = std::move(merged);
  if (slot.name.empty())
    slot.name = old.name;
  if (slot.host.empty())
    slot.host = old.host.empty() ? (slot.addrs.empty() ? std::string() : slot.addrs.front())
                                 : old.host;
  if (!slot.port)
    slot.port = old.port;
  if (slot.via.empty())
    slot.via = old.via;
  slot.last_seen_ms = base::Time::Now().ToDeltaSinceWindowsEpoch().InMilliseconds();
  old = std::move(slot);
  if (on_change_)
    on_change_.Run();
}

void PeerRegistry::Remove(const std::string& device_id) {
  if (peers_.erase(device_id) && on_change_)
    on_change_.Run();
}

void PeerRegistry::PruneStale(base::TimeDelta timeout) {
  const long long now = base::Time::Now().ToDeltaSinceWindowsEpoch().InMilliseconds();
  bool changed = false;
  for (auto it = peers_.begin(); it != peers_.end();) {
    if (now - it->second.last_seen_ms > timeout.InMilliseconds()) {
      it = peers_.erase(it);
      changed = true;
    } else {
      ++it;
    }
  }
  if (changed && on_change_)
    on_change_.Run();
}

std::vector<PeerRecord> PeerRegistry::List() const {
  std::vector<PeerRecord> out;
  out.reserve(peers_.size());
  for (const auto& [id, rec] : peers_)
    out.push_back(rec);
  return out;
}

bool PeerRegistry::Has(const std::string& device_id) const {
  return peers_.find(device_id) != peers_.end();
}

PeerRecord* PeerRegistry::Find(const std::string& device_id) {
  auto it = peers_.find(device_id);
  return it == peers_.end() ? nullptr : &it->second;
}

}  // namespace localim