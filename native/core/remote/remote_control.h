// 远程控制：把收到的输入事件投递给平台输入注入器（远程桌面被控端）。
#ifndef LOCALIM_CORE_REMOTE_REMOTE_CONTROL_H_
#define LOCALIM_CORE_REMOTE_REMOTE_CONTROL_H_

#include <string>

#include "platform/input_injector.h"

namespace localim {

// 每帧输入事件对应 forward 到 input_injector；纯骨架：事件转发正确性在真实
// 回环/中继接入后由 input_injector 平台层逐键校验。
class RemoteControl {
 public:
  RemoteControl();
  ~RemoteControl();

  // 收到 media.remote_input 信封载荷（t/x/y/btn/code/d）时调用。
  bool HandleInput(const std::string& type,
                   float x,
                   float y,
                   int button,
                   const std::string& key_code,
                   int wheel_delta);

  bool IsHosting() const { return hosting_; }
  void SetHosting(bool v) { hosting_ = v; }

 private:
  input::InputInjector injector_;
  bool hosting_ = false;
};

}  // namespace localim

#endif  // LOCALIM_CORE_REMOTE_REMOTE_CONTROL_H_