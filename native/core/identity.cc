#include "core/identity.h"

#include <string>

#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/path_service.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/values.h"
#include "build/build_config.h"

namespace localim::identity {
namespace {

std::string RandomDeviceId() {
  // 16 字节随机 hex，足够在同一 LAN 内唯一。
  return base::HexEncode(base::RandBytesAsVector(16));
}

std::string CurrentPlatform() {
#if BUILDFLAG(IS_WIN)
  return "win";
#elif BUILDFLAG(IS_MAC)
  return "mac";
#else
  return "linux";
#endif
}

void EnsureDataDir(const base::FilePath& dir) {
  if (!base::PathExists(dir))
    base::CreateDirectory(dir);
}

}  // namespace

base::FilePath DefaultDataDir() {
  base::FilePath home;
  base::PathService::Get(base::DIR_HOME, &home);
  return home.Append(FILE_PATH_LITERAL(".localim"));
}

Profile LoadProfile() {
  return LoadProfile(DefaultDataDir());
}

Profile LoadProfile(const base::FilePath& data_dir) {
  EnsureDataDir(data_dir);
  Profile profile;
  const base::FilePath path = data_dir.Append(FILE_PATH_LITERAL("profile.json"));

  if (base::PathExists(path)) {
    std::string raw;
    if (base::ReadFileToString(path, &raw)) {
      auto parsed = base::JSONReader::Read(raw, base::JSON_PARSE_RFC);
      if (parsed && parsed->is_dict()) {
        const base::DictValue& d = parsed->GetDict();
        if (const std::string* s = d.FindString("deviceId"))
          profile.device_id = *s;
        if (const std::string* s = d.FindString("name"))
          profile.name = *s;
        if (const std::string* s = d.FindString("platform"))
          profile.platform = *s;
        if (const std::string* s = d.FindString("version"))
          profile.version = *s;
      }
    }
  }

  bool need_save = false;
  if (profile.device_id.empty()) {
    profile.device_id = RandomDeviceId();
    need_save = true;
  }
  if (profile.name.empty()) {
    profile.name = std::string("local-") + profile.device_id.substr(0, 6);
    need_save = true;
  }
  if (profile.platform.empty()) {
    profile.platform = CurrentPlatform();
    need_save = true;
  }
  if (need_save) {
    profile.version = "0.1.0";
    SaveProfile(data_dir, profile);
  }
  return profile;
}

void SaveProfile(const base::FilePath& data_dir, const Profile& profile) {
  EnsureDataDir(data_dir);
  base::DictValue d;
  d.Set("deviceId", profile.device_id);
  d.Set("name", profile.name);
  d.Set("platform", profile.platform);
  d.Set("version", profile.version);
  std::string raw;
  base::JSONWriter::Write(d, &raw);
  const bool ok =
      base::WriteFile(data_dir.Append(FILE_PATH_LITERAL("profile.json")), raw);
  if (!ok)
    LOG(ERROR) << "Failed to write profile.json";
}

}  // namespace localim::identity