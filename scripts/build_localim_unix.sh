#!/usr/bin/env bash
# LocalIM @ LAN — 构建脚本（macOS 与 Ubuntu 通用，条目按 TARGET_OS 区分）。
#
# 用法:
#   ./build_localim_unix.sh            # 按当前主机自动选择 mac|linux
#   TARGET_OS=mac  ./build_localim_unix.sh
#   TARGET_OS=linux ./build_localim_unix.sh
#   ./build_localim_unix.sh build static      # 静态链接(is_component_build=false)
#   ./build_localim_unix.sh build component   # 组件构建(默认，增量最快)
#   BUILD_WEBUI=1 ./build_localim_unix.sh   # 除 daemon 外一并构建前端 WebUI
#
# 依赖(三平台通用): git、python3、chromium 源码 + depot_tools(gn/ninja)
# Ubuntu 额外:     libxtst-dev(远程控制输入注入) 、pkg-config
#                  sudo apt-get install -y libxtst-dev
#
# 产物: {chromium}/src/out/localim/localim_daemon 与 localim_relay
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # <chromium>/localim/scripts
WORKSPACE="$(cd "$SCRIPT_DIR/../.." && pwd)"                 # <chromium>
CHROMIUM_SRC="$WORKSPACE/src"
LOCALIM="$WORKSPACE/localim"
OUT_DIR="$CHROMIUM_SRC/out/localim"                          # GN 需构建目录在源码根内
DEPOT_CANDIDATES=("$WORKSPACE/../depot_tools" "$HOME/depot_tools" "$CHROMIUM_SRC/../depot_tools")

log(){ printf '[localim] %s\n' "$*"; }
die(){ printf '[localim] error: %s\n' "$*" >&2; exit 1; }

# ---- 0. 参数解析：build [static|component] ----
LINK_MODE="${LINK_MODE:-component}"
for arg in "$@"; do
  case "$arg" in
    build) ;;
    static) LINK_MODE=static ;;
    component|shared) LINK_MODE=component ;;
    *) die "unknown argument: $arg (usage: $0 [build] [static|component])" ;;
  esac
done
case "$LINK_MODE" in static|component) ;; *) die "LINK_MODE only supports static|component (got $LINK_MODE)";; esac

# ---- 1. depot_tools / gn / ninja 定位 ----
DEPOT_TOOLS="${DEPOT_TOOLS:-}"
if [ -z "$DEPOT_TOOLS" ]; then
  for c in "${DEPOT_CANDIDATES[@]}"; do
    if [ -x "$c/gn" ]; then DEPOT_TOOLS="$c"; break; fi
  done
fi
if [ -z "$DEPOT_TOOLS" ] || [ ! -x "$DEPOT_TOOLS/gn" ]; then
  die "depot_tools not found (must contain gn). Set DEPOT_TOOLS=/path/to/depot_tools and retry."
fi
export PATH="$DEPOT_TOOLS:$PATH"
log "depot_tools: $DEPOT_TOOLS"
command -v gn >/dev/null || die "gn is not in PATH"

# ---- 2. 目标 OS ----
TARGET_OS="${TARGET_OS:-}"
if [ -z "$TARGET_OS" ]; then
  case "$(uname)" in
    Darwin) TARGET_OS=mac ;;
    Linux)  TARGET_OS=linux ;;
    *) die "unsupported host: $(uname), please set TARGET_OS=mac|linux explicitly" ;;
  esac
fi
case "$TARGET_OS" in mac|linux) ;; *) die "TARGET_OS only supports mac|linux (got $TARGET_OS)";; esac
log "target platform: $TARGET_OS / link mode: $LINK_MODE"

# ---- 3. 挂载 src/localim -> ../localim（首跑建立符号链接） ----
mount_point="$CHROMIUM_SRC/localim"
if [ ! -e "$mount_point" ] || [ ! -d "$mount_point" ]; then
  [ -L "$mount_point" ] && rm "$mount_point"
  log "mount $mount_point -> $LOCALIM"
  ln -s "$LOCALIM" "$mount_point"
fi

# ---- 4. Ubuntu 原生依赖校验（远程控制输入注入依赖 XTest） ----
if [ "$TARGET_OS" = "linux" ]; then
  if ! printf '#include <X11/extensions/XTest.h>\nint main(){return 0;}\n' | gcc -x c - -o /dev/null 2>/dev/null; then
    log "hint: XTest headers not found, remote control (input injection) will fail to build. Please run:"
    log "  sudo apt-get install -y libxtst-dev"
  fi
fi

# ---- 5. args.gn（UTF-8 无 BOM，覆盖非必需项则重写） ----
mkdir -p "$OUT_DIR"
write_args() {
  local flags=(is_debug=false symbol_level=0 use_siso=false)
  if [ "$LINK_MODE" = "static" ]; then
    flags+=(is_component_build=false)
  else
    flags+=(is_component_build=true)
  fi
  case "$TARGET_OS" in
    mac)
      flags+=(enable_dsyms=false)
      # 注意: enable_stripping=true 与 is_component_build=true 不可同时开启。
      # 上游 //chrome/BUILD.gn 中 enable_stripping 分支已赋值 ldflags(exported_symbols_list)，
      # is_component_build 分支再赋 ldflags(rpath) 会触发 gn 报
      # "Replacing nonempty list"，故剥离仅在静态链接时开启。
      if [ "$LINK_MODE" = "static" ]; then
        flags+=(enable_stripping=true)
      fi
      ;;
    linux)
      flags+=(enable_dsyms=false)
      ;;
  esac
  : > "$OUT_DIR/args.gn"
  for f in "${flags[@]}"; do printf '%s\n' "$f" >> "$OUT_DIR/args.gn"; done
  # 显式挂进构建图：src/localim 是源码根外的符号链接，不在 //BUILD.gn 的依赖闭包里，
  # 不登记则 autoninja 报 unknown target（与 Windows 脚本同一处理）。
  {
    printf '\n# 显式挂在构建图里，否则 standalone 图不含 localim 目标，autoninja 报 unknown target。\n'
    printf 'root_extra_deps = [\n'
    printf '  "//localim/native:localim_daemon",\n'
    printf '  "//localim/native:localim_relay",\n'
    printf ']\n'
  } >> "$OUT_DIR/args.gn"
}
write_args

# ---- 6. gn gen + 构建 ----
cd "$CHROMIUM_SRC"
log "gn gen($TARGET_OS)..."
gn gen "$OUT_DIR"
log "building localim_daemon + localim_relay ($TARGET_OS)..."
autoninja -C "$OUT_DIR" localim/native:localim_daemon localim/native:localim_relay

BIN="$OUT_DIR/localim_daemon"
[ -x "$BIN" ] || die "build produced no output at $BIN"
log "OK: $BIN"
log "run: $BIN --user-data-dir=~/.localim"

# ---- 7. 可选: 一并构建 WebUI（npm 需已安装） ----
if [ "${BUILD_WEBUI:-0}" = "1" ]; then
  command -v npm >/dev/null || die "BUILD_WEBUI=1 but npm was not found"
  log "building WebUI..."
  npm --prefix "$LOCALIM/ui" install
  npm --prefix "$LOCALIM/ui" run build
  log "OK: $LOCALIM/ui/dist"
fi