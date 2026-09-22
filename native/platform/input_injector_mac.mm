// macOS 输入注入：CoreGraphics CGEvent。
#include "platform/input_injector.h"

#import <CoreGraphics/CoreGraphics.h>

#include <map>
#include <string>

namespace localim::input {
namespace {

// KeyboardEvent.code → CGKeyCode 的部分映射；未收录按键用虚拟键映射占位。
const std::map<std::string, CGKeyCode> kMap = {
    {"Enter", 36},     {"Space", 49},      {"Tab", 48},
    {"Escape", 53},    {"Backspace", 51},  {"ArrowUp", 126},
    {"ArrowDown", 125},{"ArrowLeft", 123}, {"ArrowRight", 124},
    {"KeyA", 0},       {"KeyS", 1},        {"KeyD", 2}, {"KeyW", 13},
    {"KeyQ", 12},      {"KeyE", 14},       {"KeyR", 15}, {"KeyT", 17},
    {"KeyY", 16},      {"KeyU", 32},       {"KeyI", 34}, {"KeyO", 31},
    {"KeyP", 35},
};

}  // namespace

InputInjector::InputInjector() = default;
InputInjector::~InputInjector() = default;

bool InputInjector::MouseMove(int x, int y) {
  CGPoint p = CGPointMake(static_cast<CGFloat>(x), static_cast<CGFloat>(y));
  CGEventRef ev = CGEventCreateMouseEvent(nullptr, kCGEventMouseMoved, p, kCGMouseButtonLeft);
  if (!ev)
    return false;
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
  return true;
}

bool InputInjector::MouseButton(int x, int y, int button, bool down) {
  const CGMouseButton cgbtn = button == 1 ? kCGMouseButtonRight : kCGMouseButtonLeft;
  const CGEventType type = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
  CGPoint p = CGPointMake(static_cast<CGFloat>(x), static_cast<CGFloat>(y));
  CGEventRef ev = CGEventCreateMouseEvent(nullptr, type, p, cgbtn);
  if (!ev)
    return false;
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
  return true;
}

bool InputInjector::MouseWheel(int x, int y, int delta) {
  CGEventRef ev = CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitLine, 1,
                                                static_cast<int32_t>(-delta));
  if (!ev)
    return false;
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
  return true;
}

bool InputInjector::Key(const std::string& key_code, bool down) {
  auto it = kMap.find(key_code);
  if (it == kMap.end())
    return false;
  CGEventRef ev = CGEventCreateKeyboardEvent(nullptr, it->second, !down);
  if (!ev)
    return false;
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
  return true;
}

}  // namespace localim::input