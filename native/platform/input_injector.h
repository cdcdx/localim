// 平台输入注入：远程控制被控端把收到的输入事件落到真实系统输入。
#ifndef LOCALIM_PLATFORM_INPUT_INJECTOR_H_
#define LOCALIM_PLATFORM_INPUT_INJECTOR_H_

#include <string>

namespace localim::input {

class InputInjector {
 public:
  InputInjector();
  ~InputInjector();

  bool MouseMove(int x, int y);
  bool MouseButton(int x, int y, int button, bool down);
  bool MouseWheel(int x, int y, int delta);
  // key_code 为 KeyboardEvent.code（如 "KeyA"/"Enter"）。
  bool Key(const std::string& key_code, bool down);
};

}  // namespace localim::input

#endif  // LOCALIM_PLATFORM_INPUT_INJECTOR_H_