// LocalIM 设备身份：持久化 device_id / 用户名，打包进 presence 广播。
#ifndef LOCALIM_CORE_IDENTITY_H_
#define LOCALIM_CORE_IDENTITY_H_

#include <string>

#include "base/files/file_path.h"

namespace localim::identity {

struct Profile {
  std::string device_id;
  std::string name;
  std::string platform;  // "win" | "mac" | "linux"
  std::string version;
};

// 载入（不存在则生成并落盘）默认路径 ~/.localim/profile.json。
Profile LoadProfile();
// 显式指定数据目录（配合 --user-data-dir）。
Profile LoadProfile(const base::FilePath& data_dir);
void SaveProfile(const base::FilePath& data_dir, const Profile& profile);

base::FilePath DefaultDataDir();

}  // namespace localim::identity

#endif  // LOCALIM_CORE_IDENTITY_H_