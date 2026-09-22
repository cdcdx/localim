// 自建群组：以房主为根的 mesh 成员表；本机可为任意群的成员或房主。
#ifndef LOCALIM_CORE_SESSION_ROOM_MANAGER_H_
#define LOCALIM_CORE_SESSION_ROOM_MANAGER_H_

#include <map>
#include <set>
#include <string>
#include <vector>

#include "base/functional/callback.h"

namespace localim {

// 骨架阶段：单一进程内维护（本机维度）。跨设备群（房主广播/成员订阅）
// 在 daemon 消息路由层接力，见 roadmap。
struct Room {
  std::string room_id;
  std::string name;
  std::string owner;
  std::set<std::string> members;
  long long seq = 0;
};

class RoomManager {
 public:
  using OnChange = base::RepeatingCallback<void()>;
  explicit RoomManager(OnChange on_change) : on_change_(std::move(on_change)) {}

  std::string Create(const std::string& owner, const std::string& name);
  bool Join(const std::string& room_id, const std::string& member);
  bool Leave(const std::string& room_id, const std::string& member);
  bool AddMember(const std::string& room_id, const std::string& member);
  bool RemoveMember(const std::string& room_id, const std::string& member);
  // 从房主的 invited/sync 导入完整群：不存在则创建，存在则覆盖成员表。
  bool Upsert(const std::string& room_id, const std::string& name,
              const std::string& owner, const std::vector<std::string>& members);
  std::vector<Room> List() const;
  Room* Find(const std::string& room_id);

 private:
  std::map<std::string, Room> rooms_;
  OnChange on_change_;
};

}  // namespace localim

#endif  // LOCALIM_CORE_SESSION_ROOM_MANAGER_H_