#include "core/remote/remote_control.h"

#include <string>

namespace localim {

RemoteControl::RemoteControl() = default;
RemoteControl::~RemoteControl() = default;

bool RemoteControl::HandleInput(const std::string& type,
                                float x,
                                float y,
                                int button,
                                const std::string& key_code,
                                int wheel_delta) {
  if (!hosting_)
    return false;
  if (type == "mousemove")
    injector_.MouseMove(static_cast<int>(x), static_cast<int>(y));
  else if (type == "mousedown")
    injector_.MouseButton(static_cast<int>(x), static_cast<int>(y), button, true);
  else if (type == "mouseup")
    injector_.MouseButton(static_cast<int>(x), static_cast<int>(y), button, false);
  else if (type == "wheel")
    injector_.MouseWheel(static_cast<int>(x), static_cast<int>(y), wheel_delta);
  else if (type == "keydown")
    injector_.Key(key_code, true);
  else if (type == "keyup")
    injector_.Key(key_code, false);
  else
    return false;
  return true;
}

}  // namespace localim