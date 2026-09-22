// LocalIM 守护进程入口：初始化 base/net，加载身份，启动 daemon 并跑消息循环。
#include <memory>

#include "base/at_exit.h"
#include "base/functional/callback.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/logging.h"
#include "base/logging/logging_settings.h"
#include "base/message_loop/message_pump_type.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_executor.h"
#include "base/task/thread_pool/thread_pool_instance.h"
#include "build/build_config.h"
#include "core/daemon.h"
#include "core/identity.h"
#include "net/base/network_change_notifier.h"

namespace {

// BlockingScope/FieldTrials 由 NetworkChangeNotifier 内部按需处理；
// 在进程生命周期内保持一个实例即可让 net 依赖的时钟/trial 就绪。

class LocalImDaemon {
 public:
  LocalImDaemon(localim::identity::Profile profile, localim::Ports ports,
                base::FilePath data_dir, localim::DaemonOptions options)
      : profile_(std::move(profile)),
        ports_(ports),
        data_dir_(std::move(data_dir)),
        options_(std::move(options)) {}

  void StartAndRun() {
    ncn_ = net::NetworkChangeNotifier::CreateIfNeeded();
    daemon_ = std::make_unique<localim::Daemon>(std::move(profile_),
                                                std::move(ports_), data_dir_,
                                                std::move(options_));
    daemon_->Start();
    base::RunLoop run_loop;
    quit_ = run_loop.QuitClosure();
    run_loop.Run();
  }

  void Stop() {
    if (daemon_)
      daemon_->Stop();
    if (quit_)
      std::move(quit_).Run();
  }

 private:
  localim::identity::Profile profile_;
  localim::Ports ports_;
  base::FilePath data_dir_;
  localim::DaemonOptions options_;
  std::unique_ptr<net::NetworkChangeNotifier> ncn_;
  std::unique_ptr<localim::Daemon> daemon_;
  base::OnceClosure quit_;
};

// 端口开关辅助：读 --xxx-port，非法/缺失时保持 0（Daemon 回落默认值）。
uint16_t ReadPortSwitch(const base::CommandLine& cmd, const char* name) {
  if (!cmd.HasSwitch(name))
    return 0;
  uint32_t v = 0;
  return base::StringToUint(cmd.GetSwitchValueASCII(name), &v) &&
                 v > 0 && v <= 65535
             ? static_cast<uint16_t>(v)
             : 0;
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
  LOG(INFO) << "localim_daemon starting";

  base::SingleThreadTaskExecutor main_task_executor(base::MessagePumpType::UI);
  base::ThreadPoolInstance::CreateAndStartWithDefaultParams("localim_daemon");

  const base::CommandLine& cmd = *base::CommandLine::ForCurrentProcess();
  base::FilePath data_dir;
  if (cmd.HasSwitch("user-data-dir"))
    data_dir = cmd.GetSwitchValuePath("user-data-dir");

  localim::identity::Profile profile =
      data_dir.empty() ? localim::identity::LoadProfile()
                       : localim::identity::LoadProfile(data_dir);

  // 端口可配，便于本机并存多个实例做局域网互测。
  localim::Ports ports;
  ports.webui = ReadPortSwitch(cmd, "webui-port");
  ports.peer = ReadPortSwitch(cmd, "peer-port");
  ports.presence = ReadPortSwitch(cmd, "presence-port");
  ports.relay = ReadPortSwitch(cmd, "relay-port");
  ports.web = ReadPortSwitch(cmd, "web-port");

  // --webui-dist 指向 Vite 构建产物目录时启用静态 WebUI 托管。
  localim::DaemonOptions options;
  if (cmd.HasSwitch("webui-dist"))
    options.webui_dist = cmd.GetSwitchValuePath("webui-dist");
  // --relay-host 指向跨网段引导中继服务；缺省连 127.0.0.1（本机 localim_relay）。
  if (cmd.HasSwitch("relay-host"))
    options.relay_host = cmd.GetSwitchValueASCII("relay-host");
  // --psk 局域网预共享口令：非空时启用 AES-256-GCM 消息加密 + 信封 HMAC 认证。
  // 仅存于本进程，不进 WS 链路；两端需填入同一口令才能互解互通。
  if (cmd.HasSwitch("psk"))
    options.psk = cmd.GetSwitchValueASCII("psk");

  LocalImDaemon runner(std::move(profile), ports, data_dir, std::move(options));
  runner.StartAndRun();
  return 0;
}