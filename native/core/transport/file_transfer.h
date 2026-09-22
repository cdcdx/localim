// 文件传输元数据与分片账本：跟踪文件会话的收发状态（实际载荷走 WebRTC data channel）。
#ifndef LOCALIM_CORE_TRANSPORT_FILE_TRANSFER_H_
#define LOCALIM_CORE_TRANSPORT_FILE_TRANSFER_H_

#include <map>
#include <string>

#include "base/functional/callback.h"

namespace localim {

struct FileSession {
  std::string file_id;
  std::string to;
  std::string name;
  long long size = 0;
  std::string mime;
  size_t received = 0;
  bool done = false;
  std::string state;  // pending|sending|done|failed|canceled
};

class FileTransfer {
 public:
  using OnStatus = base::RepeatingCallback<void(const FileSession&)>;
  explicit FileTransfer(OnStatus on_status) : on_status_(std::move(on_status)) {}

  void Begin(const FileSession& s);
  void OnChunk(const std::string& file_id, size_t len);
  void Acknowledge(const std::string& file_id);
  void Cancel(const std::string& file_id);
  FileSession* Find(const std::string& file_id);

 private:
  std::map<std::string, FileSession> sessions_;
  OnStatus on_status_;
};

}  // namespace localim

#endif  // LOCALIM_CORE_TRANSPORT_FILE_TRANSFER_H_