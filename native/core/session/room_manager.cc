#include "core/session/room_manager.h"

#include <utility>

#include "base/hash/hash.h"
#include "base/strings/string_number_conversions.h"
#include "base/time/time.h"

namespace localim {

std::string RoomManager::Create(const std::string& owner, const std::string& name) {
  Room room;
  room.room_id = "room-" + base::NumberToString(base::PersistentHash(
      owner + name + base::NumberToString(base::Time::Now().ToInternalValue())));
  room.name = name;
  room.owner = owner;
  room.members.insert(owner);
  room.seq = 1;
  rooms_[room.room_id] = room;
  if (on_change_)
    on_change_.Run();
  return room.room_id;
}

bool RoomManager::Join(const std::string& room_id, const std::string& member) {
  return AddMember(room_id, member);
}

bool RoomManager::Leave(const std::string& room_id, const std::string& member) {
  auto it = rooms_.find(room_id);
  if (it == rooms_.end())
    return false;
  it->second.members.erase(member);
  if (it->second.members.empty())
    rooms_.erase(it);
  if (on_change_)
    on_change_.Run();
  return true;
}

bool RoomManager::AddMember(const std::string& room_id, const std::string& member) {
  auto it = rooms_.find(room_id);
  if (it == rooms_.end())
    return false;
  it->second.members.insert(member);
  ++it->second.seq;
  if (on_change_)
    on_change_.Run();
  return true;
}

bool RoomManager::RemoveMember(const std::string& room_id,
                               const std::string& member) {
  return Leave(room_id, member);
}

bool RoomManager::Upsert(const std::string& room_id, const std::string& name,
                         const std::string& owner,
                         const std::vector<std::string>& members) {
  auto [it, inserted] = rooms_.try_emplace(room_id);
  it->second.room_id = room_id;
  if (!name.empty())
    it->second.name = name;
  if (!owner.empty())
    it->second.owner = owner;
  it->second.members.clear();
  for (const auto& m : members)
    it->second.members.insert(m);
  ++it->second.seq;
  if (on_change_)
    on_change_.Run();
  return true;
}

std::vector<Room> RoomManager::List() const {
  std::vector<Room> out;
  out.reserve(rooms_.size());
  for (const auto& [id, room] : rooms_)
    out.push_back(room);
  return out;
}

Room* RoomManager::Find(const std::string& room_id) {
  auto it = rooms_.find(room_id);
  return it == rooms_.end() ? nullptr : &it->second;
}

}  // namespace localim