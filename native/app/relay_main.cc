// LocalIM 跨网段引导中继服务入口：独立小服务，接受 daemon 的 RelayClient 连接，
// 维护多网关注册路由表并广播 peer_online/offline，使不同网段 daemon 可经本 relay 互发现。
#include <cstdint>
#include <memory>

#include "base/at_exit.h"
#include "base/command_line.h"
#include "base/logging.h"
#include "base/logging/logging_settings.h"
#include "base/message_loop/message_pump_type.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_executor.h"
#include "base/task/thread_pool/thread_pool_instance.h"
#include "core/discovery/relay_server.h"
#include "net/base/network_change_notifier.h"

namespace {

constexpr uint16_t kDefaultRelayPort = 7618;

uint16_t ReadPortSwitch(const base::CommandLine& cmd, const char* name) {
  if (!cmd.HasSwitch(name))
    return kDefaultRelayPort;
  uint32_t v = 0;
  return base::StringToUint(cmd.GetSwitchValueASCII(name), &v) &&
                 v > 0 && v <= 65535
             ? static_cast<uint16_t>(v)
             : kDefaultRelayPort;
}

}  // namespace

int main(int argc, char* argv[]) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  logging::LoggingSettings settings;
  settings.logging_dest = logging::LOG_TO_SYSTEM_DEBUG_LOG | logging::LOG_TO_STDERR;
  settings.log_file_path.clear();
  logging::InitLogging(settings);
  logging::SetMinLogLevel(logging::LOGGING_INFO);
  LOG(INFO) << "localim_relay starting";

  base::SingleThreadTaskExecutor main_task_executor(base::MessagePumpType::UI);
  base::ThreadPoolInstance::CreateAndStartWithDefaultParams("localim_relay");

  const base::CommandLine& cmd = *base::CommandLine::ForCurrentProcess();
  const uint16_t port = ReadPortSwitch(cmd, "relay-port");

  localim::RelayServer server;
  server.Start(port);
  base::RunLoop run_loop;
  run_loop.Run();
  return 0;
}