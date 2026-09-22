// Windows 输入注入：SendInput。
#include "platform/input_injector.h"

#include <Windows.h>

#include <unordered_map>

namespace localim::input {
namespace {

WORD VkFromCode(const std::string& code) {
  // 常见键映射；未收录的按键经 MapVirtualKey 取虚拟键码。
  static const std::unordered_map<std::string, WORD> kMap = {
      {"Enter", VK_RETURN},   {"Space", VK_SPACE},   {"Tab", VK_TAB},
      {"Escape", VK_ESCAPE},  {"Backspace", VK_BACK}, {"ArrowUp", VK_UP},
      {"ArrowDown", VK_DOWN}, {"ArrowLeft", VK_LEFT}, {"ArrowRight", VK_RIGHT},
      {"ShiftLeft", VK_LSHIFT}, {"ShiftRight", VK_RSHIFT},
      {"ControlLeft", VK_LCONTROL}, {"ControlRight", VK_RCONTROL},
      {"AltLeft", VK_LMENU},  {"AltRight", VK_RMENU},
  };
  auto it = kMap.find(code);
  if (it != kMap.end())
    return it->second;
  if (code.size() == 4 && code[0] == 'K' && code[2] == 'e')
    return static_cast<WORD>('A' + (code[1] - 'A'));  // "KeyX"
  return 0;
}

void SendKey(bool down, WORD vk) {
  INPUT in = {};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = vk;
  if (!down)
    in.ki.dwFlags = KEYEVENTF_KEYUP;
  SendInput(1, &in, sizeof(INPUT));
}

// SendInput 的 MOUSEEVENTF_ABSOLUTE 用 0-65535 归一化坐标而非像素；
// 将屏幕像素换算为绝对坐标（含多显示器虚拟屏幕边界）。
LONG AbsCoord(int v, int span) {
  if (span <= 1)
    return 0;
  return static_cast<LONG>(v * 65535LL / (span - 1));
}
int VirtualWidth() {
  return GetSystemMetrics(SM_CXVIRTUALSCREEN);
}
int VirtualHeight() {
  return GetSystemMetrics(SM_CYVIRTUALSCREEN);
}
int VirtualLeft() {
  return GetSystemMetrics(SM_XVIRTUALSCREEN);
}
int VirtualTop() {
  return GetSystemMetrics(SM_YVIRTUALSCREEN);
}

}  // namespace

InputInjector::InputInjector() = default;
InputInjector::~InputInjector() = default;

bool InputInjector::MouseMove(int x, int y) {
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.dx = AbsCoord(x - VirtualLeft(), VirtualWidth());
  in.mi.dy = AbsCoord(y - VirtualTop(), VirtualHeight());
  in.mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE;
  return SendInput(1, &in, sizeof(INPUT)) == 1;
}

bool InputInjector::MouseButton(int x, int y, int button, bool down) {
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.dx = AbsCoord(x - VirtualLeft(), VirtualWidth());
  in.mi.dy = AbsCoord(y - VirtualTop(), VirtualHeight());
  in.mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE;
  if (down) {
    in.mi.dwFlags |= button == 1 ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
  } else {
    in.mi.dwFlags |= button == 1 ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
  }
  return SendInput(1, &in, sizeof(INPUT)) == 1;
}

bool InputInjector::MouseWheel(int x, int y, int delta) {
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.mouseData = static_cast<DWORD>(delta);
  in.mi.dwFlags = MOUSEEVENTF_WHEEL;
  return SendInput(1, &in, sizeof(INPUT)) == 1;
}

bool InputInjector::Key(const std::string& key_code, bool down) {
  const WORD vk = VkFromCode(key_code);
  if (!vk)
    return false;
  SendKey(down, vk);
  return true;
}

}  // namespace localim::input