#include "core/session/peer_registry.h"

#include <utility>

#include "base/time/time.h"

namespace localim {

void PeerRegistry::Upsert(const PeerRecord& rec) {
  PeerRecord& slot = peers_[rec.device_id];
  slot = rec;
  slot.last_seen_ms = base::Time::Now().ToDeltaSinceWindowsEpoch().InMilliseconds();
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