// LocalIM 消息账本：JSONL 追加写入 <data_dir>/messages.jsonl，载入内存供重启回看。
// 仅 IO 线程访问。消息 dict 需含 conv(会话键)、direction/from/to/kind/type/body/ts 等。
#ifndef LOCALIM_CORE_SESSION_MESSAGE_STORE_H_
#define LOCALIM_CORE_SESSION_MESSAGE_STORE_H_

#include <cstddef>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/values.h"

namespace localim {

class MessageStore {
 public:
  explicit MessageStore(base::FilePath data_dir);

  // 落盘并进内存；相同(conv, nonce)去重，返回是否真正新增。
  bool Append(const base::DictValue& msg);

  // 取会话 conv 的最近 limit 条（旧->新）注入 out。
  void History(const std::string& conv, size_t limit, base::ListValue* out) const;

  size_t Count() const { return items_.size(); }

 private:
  void Load();
  base::FilePath path_;
  std::vector<base::DictValue> items_;
};

}  // namespace localim

#endif  // LOCALIM_CORE_SESSION_MESSAGE_STORE_H_