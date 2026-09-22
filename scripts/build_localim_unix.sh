#!/usr/bin/env bash
# LocalIM @ LAN — 构建脚本（macOS 与 Ubuntu 通用，条目按 TARGET_OS 区分）。
#
# 用法:
#   ./build_localim_unix.sh            # 按当前主机自动选择 mac|linux
#   TARGET_OS=mac  ./build_localim_unix.sh
#   TARGET_OS=linux ./build_localim_unix.sh
#   BUILD_WEBUI=1 ./build_localim_unix.sh   # 除 daemon 外一并构建前端 WebUI
#
# 依赖(三平台通用): git、python3、chromium 源码 + depot_tools(gn/ninja)
# Ubuntu 额外:     libxtst-dev(远程控制输入注入) 、pkg-config
#                  sudo apt-get install -y libxtst-dev
#
# 产物: {chromium}/src/out/localim/localim_daemon
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # <chromium>/localim/scripts
WORKSPACE="$(cd "$SCRIPT_DIR/../.." && pwd)"                 # <chromium>
CHROMIUM_SRC="$WORKSPACE/src"
LOCALIM="$WORKSPACE/localim"
OUT_DIR="$CHROMIUM_SRC/out/localim"                          # GN 需构建目录在源码根内
DEPOT_CANDIDATES=("$WORKSPACE/../depot_tools" "$HOME/depot_tools" "$CHROMIUM_SRC/../depot_tools")

log(){ printf '[localim] %s\n' "$*"; }
die(){ printf '[localim] 错误: %s\n' "$*" >&2; exit 1; }

# ---- 1. depot_tools / gn / ninja 定位 ----
DEPOT_TOOLS="${DEPOT_TOOLS:-}"
if [ -z "$DEPOT_TOOLS" ]; then
  for c in "${DEPOT_CANDIDATES[@]}"; do
    if [ -x "$c/gn" ]; then DEPOT_TOOLS="$c"; break; fi
  done
fi
if [ -z "$DEPOT_TOOLS" ] || [ ! -x "$DEPOT_TOOLS/gn" ]; then
  die "未找到 depot_tools(需含 gn)。设置 DEPOT_TOOLS=/path/to/depot_tools 后重试。"
fi
export PATH="$DEPOT_TOOLS:$PATH"
log "depot_tools: $DEPOT_TOOLS"
command -v gn >/dev/null || die "gn 不在 PATH"

# ---- 2. 目标 OS ----
TARGET_OS="${TARGET_OS:-}"
if [ -z "$TARGET_OS" ]; then
  case "$(uname)" in
    Darwin) TARGET_OS=mac ;;
    Linux)  TARGET_OS=linux ;;
    *) die "不支持的主机: $(uname)，请用 TARGET_OS=mac|linux 显式指定" ;;
  esac
fi
case "$TARGET_OS" in mac|linux) ;; *) die "TARGET_OS 仅支持 mac|linux(收到 $TARGET_OS)";; esac
log "目标平台: $TARGET_OS"

# ---- 3. 挂载 src/localim -> ../localim（首跑建立符号链接） ----
mount_point="$CHROMIUM_SRC/localim"
if [ ! -e "$mount_point" ] || [ ! -d "$mount_point" ]; then
  [ -L "$mount_point" ] && rm "$mount_point"
  log "挂载 $mount_point -> $LOCALIM"
  ln -s "$LOCALIM" "$mount_point"
fi

# ---- 4. Ubuntu 原生依赖校验（远程控制输入注入依赖 XTest） ----
if [ "$TARGET_OS" = "linux" ]; then
  if ! printf '#include <X11/extensions/XTest.h>\nint main(){return 0;}\n' | gcc -x c - -o /dev/null 2>/dev/null; then
    log "提示: 未检测到 XTest 头文件，远程控制(输入注入)将无法编译。请先:"
    log "  sudo apt-get install -y libxtst-dev"
  fi
fi

# ---- 5. args.gn（UTF-8 无 BOM，覆盖非必需项则重写） ----
mkdir -p "$OUT_DIR"
write_args() {
  local flags=(is_debug=false is_component_build=true symbol_level=0 use_siso=false)
  case "$TARGET_OS" in
    mac)   flags+=(enable_dsyms=false enable_stripping=true) ;;
    linux) flags+=(enable_dsyms=false) ;;
  esac
  : > "$OUT_DIR/args.gn"
  for f in "${flags[@]}"; do printf '%s\n' "$f" >> "$OUT_DIR/args.gn"; done
}
write_args

# ---- 6. gn gen + 构建 ----
cd "$CHROMIUM_SRC"
log "gn gen($TARGET_OS)..."
gn gen "$OUT_DIR"
log "构建 localim_daemon($TARGET_OS)..."
autoninja -C "$OUT_DIR" localim/native:localim_daemon

BIN="$OUT_DIR/localim_daemon"
[ -x "$BIN" ] || die "构建未产出 $BIN"
log "OK: $BIN"
log "运行: $BIN --user-data-dir=~/.localim"

# ---- 7. 可选: 一并构建 WebUI（npm 需已安装） ----
if [ "${BUILD_WEBUI:-0}" = "1" ]; then
  command -v npm >/dev/null || die "BUILD_WEBUI=1 但未找到 npm"
  log "构建 WebUI..."
  npm --prefix "$LOCALIM/ui" install
  npm --prefix "$LOCALIM/ui" run build
  log "OK: $LOCALIM/ui/dist"
fi