#include "core/transport/file_transfer.h"

#include <utility>

namespace localim {

void FileTransfer::Begin(const FileSession& s) {
  sessions_[s.file_id] = s;
  if (on_status_)
    on_status_.Run(sessions_[s.file_id]);
}

void FileTransfer::OnChunk(const std::string& file_id, size_t len) {
  auto it = sessions_.find(file_id);
  if (it == sessions_.end())
    return;
  it->second.received += len;
  it->second.state = "sending";
  if (on_status_)
    on_status_.Run(it->second);
}

void FileTransfer::Acknowledge(const std::string& file_id) {
  auto it = sessions_.find(file_id);
  if (it == sessions_.end())
    return;
  it->second.done = true;
  it->second.state = "done";
  if (on_status_)
    on_status_.Run(it->second);
}

void FileTransfer::Cancel(const std::string& file_id) {
  auto it = sessions_.find(file_id);
  if (it == sessions_.end())
    return;
  it->second.state = "canceled";
  if (on_status_)
    on_status_.Run(it->second);
}

FileSession* FileTransfer::Find(const std::string& file_id) {
  auto it = sessions_.find(file_id);
  return it == sessions_.end() ? nullptr : &it->second;
}

}  // namespace localim