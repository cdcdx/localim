#include "core/session/message_store.h"

#include <algorithm>

#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/values.h"

namespace localim {
namespace {

constexpr base::FilePath::CharType kFileName[] =
    FILE_PATH_LITERAL("messages.jsonl");

std::string ConvOf(const base::DictValue& d) {
  const std::string* v = d.FindString("conv");
  return v ? *v : std::string();
}

}  // namespace

MessageStore::MessageStore(base::FilePath data_dir) {
  if (!base::PathExists(data_dir))
    base::CreateDirectory(data_dir);
  path_ = data_dir.Append(kFileName);
  // Windows 的 AppendToFile 用 OPEN_EXISTING，不自动建文件；先保证空账本存在。
  if (!base::PathExists(path_))
    base::WriteFile(path_, std::string());
  Load();
}

void MessageStore::Load() {
  if (!base::PathExists(path_))
    return;
  std::string raw;
  if (!base::ReadFileToString(path_, &raw)) {
    LOG(WARNING) << "MessageStore: failed to read history " << path_.AsUTF8Unsafe();
    return;
  }
  for (const auto& line : base::SplitString(
           raw, "\n", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    auto parsed = base::JSONReader::Read(line, base::JSON_PARSE_RFC);
    if (!parsed || !parsed->is_dict())
      continue;
    items_.push_back(parsed->GetDict().Clone());
  }
  LOG(INFO) << "MessageStore: loaded " << items_.size() << " history items @ "
            << path_.AsUTF8Unsafe();
}

bool MessageStore::Append(const base::DictValue& msg) {
  const std::string conv = ConvOf(msg);
  const std::string* nonce = msg.FindString("nonce");
  if (!conv.empty() && nonce) {
    for (const auto& existing : items_) {
      if (ConvOf(existing) == conv && existing.FindString("nonce") &&
          *existing.FindString("nonce") == *nonce) {
        return false;  // 去重：重传/回显不重复落库。
      }
    }
  }
  std::string line;
  if (!base::JSONWriter::Write(msg, &line))
    return false;
  line.push_back('\n');
  if (!base::AppendToFile(path_, line)) {
    LOG(ERROR) << "MessageStore: failed to write " << path_.AsUTF8Unsafe();
    return false;
  }
  items_.push_back(msg.Clone());
  return true;
}

void MessageStore::History(const std::string& conv, size_t limit,
                           base::ListValue* out) const {
  if (conv.empty() || !out)
    return;
  // 先收集匹配会话，再取最近的 limit 条，按旧->新返回（与聊天时间轴一致）。
  std::vector<size_t> hint;
  for (size_t i = 0; i < items_.size(); ++i) {
    if (ConvOf(items_[i]) == conv)
      hint.push_back(i);
  }
  if (hint.empty())
    return;
  const size_t begin =
      hint.size() > limit ? hint.size() - limit : 0;
  for (size_t i = begin; i < hint.size(); ++i)
    out->Append(items_[hint[i]].Clone());
}

}  // namespace localim