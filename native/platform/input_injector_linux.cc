// Linux Input Injector：X11/XTest。
#include "platform/input_injector.h"

#include <X11/extensions/XTest.h>
#include <X11/Xlib.h>

#include <memory>
#include <string>

#include "build/build_config.h"

namespace localim::input {
namespace {

Display* g_display = nullptr;

bool EnsureDisplay() {
  if (g_display)
    return true;
  g_display = XOpenDisplay(nullptr);
  return g_display != nullptr;
}

}  // namespace

InputInjector::InputInjector() = default;
InputInjector::~InputInjector() {
  if (g_display) {
    XCloseDisplay(g_display);
    g_display = nullptr;
  }
}

bool InputInjector::MouseMove(int x, int y) {
  if (!EnsureDisplay())
    return false;
  XTestFakeMotionEvent(g_display, -1, x, y, 0);
  XFlush(g_display);
  return true;
}

bool InputInjector::MouseButton(int x, int y, int button, bool down) {
  if (!EnsureDisplay())
    return false;
  XTestFakeMotionEvent(g_display, -1, x, y, 0);
  const unsigned int b = button == 1 ? 3 : 1;  // 右=3 左=1
  XTestFakeButtonEvent(g_display, b, down ? True : False, 0);
  XFlush(g_display);
  return true;
}

bool InputInjector::MouseWheel(int x, int y, int delta) {
  if (!EnsureDisplay())
    return false;
  XTestFakeMotionEvent(g_display, -1, x, y, 0);
  XTestFakeButtonEvent(g_display, delta > 0 ? 4 : 5, True, 0);
  XTestFakeButtonEvent(g_display, delta > 0 ? 4 : 5, False, 0);
  XFlush(g_display);
  return true;
}

bool InputInjector::Key(const std::string& key_code, bool down) {
  if (!EnsureDisplay())
    return false;
  const KeySym ks = XStringToKeysym(key_code.c_str());
  if (ks == NoSymbol)
    return false;
  const KeyCode code = XKeysymToKeycode(g_display, ks);
  XTestFakeKeyEvent(g_display, code, down ? True : False, 0);
  XFlush(g_display);
  return true;
}

}  // namespace localim::input