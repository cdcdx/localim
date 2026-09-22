#include "core/webserver.h"

#include <string>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "base/strings/escape.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "net/base/io_buffer.h"
#include "net/base/net_errors.h"
#include "net/server/http_server_request_info.h"
#include "net/server/http_server_response_info.h"
#include "net/socket/tcp_server_socket.h"
#include "net/traffic_annotation/network_traffic_annotation.h"

namespace localim {

namespace {

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("localim_webserver",
                                        "LocalIM static WebUI hosting");

std::string LowerExt(const base::FilePath& path) {
  // FinalExtension() 返回 FilePath::StringType：Windows 是 std::wstring，
  // POSIX 是 std::string；而 base::WideToASCII() 只在 WCHAR_T_IS_16_BIT
  // （即 Windows）下声明，macOS/Linux 直接用它会编译失败。
  // 扩展名只需 ASCII，统一经 FilePath::MaybeAsASCII()（非 ASCII 返回空）取回。
  std::string ext = base::ToLowerASCII(
      base::FilePath(path.FinalExtension()).MaybeAsASCII());
  if (!ext.empty() && ext.front() == '.')
    ext.erase(ext.begin());
  return ext;
}

}  // namespace

WebServer::WebServer(base::FilePath root) : root_(std::move(root)) {}

WebServer::~WebServer() = default;

bool WebServer::Start(uint16_t port) {
  if (server_)
    return true;
  auto socket = std::make_unique<net::TCPServerSocket>(nullptr, net::NetLogSource());
  int rv = socket->Listen(
      net::IPEndPoint(net::IPAddress::IPv4Localhost(), port), /*backlog=*/16,
      /*ipv6_only=*/std::nullopt);
  if (rv != net::OK) {
    LOG(ERROR) << "WebServer: listen " << port << " failed rv=" << rv;
    return false;
  }
  server_ = std::make_unique<net::HttpServer>(std::move(socket), this);
  LOG(INFO) << "WebServer: serving " << root_.AsUTF8Unsafe()
            << " over http://127.0.0.1:" << port;
  return true;
}

void WebServer::Stop() {
  server_.reset();
}

void WebServer::OnHttpRequest(int connection_id,
                              const net::HttpServerRequestInfo& info) {
  // 只支持 GET/HEAD；其余返回 404。
  if (!base::EqualsCaseInsensitiveASCII(info.method, "GET") &&
      !base::EqualsCaseInsensitiveASCII(info.method, "HEAD")) {
    Send404(connection_id);
    return;
  }
  ServeFile(connection_id, info.path);
}

void WebServer::ServeFile(int connection_id, const std::string& raw_path) {
  std::string url =
      base::UnescapeBinaryURLComponent(raw_path, base::UnescapeRule::NORMAL);
  const size_t q = url.find('?');
  if (q != std::string::npos)
    url.erase(q);
  const size_t h = url.find('#');
  if (h != std::string::npos)
    url.erase(h);

  if (url.empty() || url.front() != '/') {
    Send404(connection_id);
    return;
  }

  // 归一化段：拒绝 ".."，空段/"." 跳过，末尾空则补 index.html。
  std::vector<std::string> segs = base::SplitString(
      url.substr(1), "/", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
  base::FilePath rel;
  for (const auto& seg : segs) {
    if (seg == "..") {
      Send404(connection_id);
      return;
    }
    rel = rel.Append(base::FilePath::FromUTF8Unsafe(seg));
  }
  if (rel.empty())
    rel = base::FilePath(FILE_PATH_LITERAL("index.html"));

  base::FilePath full = root_.Append(rel);
  if (base::DirectoryExists(full)) {
    if (rel.FinalExtension().empty())
      full = full.Append(FILE_PATH_LITERAL("index.html"));
    else {
      Send404(connection_id);
      return;
    }
  }

  std::string body;
  if (!base::ReadFileToString(full, &body)) {
    Send404(connection_id);
    return;
  }
  server_->Send(connection_id, net::HTTP_OK, body, MimeTypeFor(full),
                kTrafficAnnotation);
}

void WebServer::Send404(int connection_id) {
  server_->Send404(connection_id, kTrafficAnnotation);
}

std::string WebServer::MimeTypeFor(const base::FilePath& path) const {
  const std::string ext = LowerExt(path);
  // 常见静态资源；默认 application/octet-stream。
  if (ext == "html")
    return "text/html; charset=utf-8";
  if (ext == "js" || ext == "mjs")
    return "text/javascript";
  if (ext == "css")
    return "text/css";
  if (ext == "json")
    return "application/json";
  if (ext == "svg")
    return "image/svg+xml";
  if (ext == "png")
    return "image/png";
  if (ext == "jpg" || ext == "jpeg")
    return "image/jpeg";
  if (ext == "gif")
    return "image/gif";
  if (ext == "webp")
    return "image/webp";
  if (ext == "ico")
    return "image/x-icon";
  if (ext == "map")
    return "application/json";
  if (ext == "woff")
    return "font/woff";
  if (ext == "woff2")
    return "font/woff2";
  if (ext == "ttf")
    return "font/ttf";
  if (ext == "otf")
    return "font/otf";
  if (ext == "mp4")
    return "video/mp4";
  if (ext == "webm")
    return "video/webm";
  if (ext == "mp3")
    return "audio/mpeg";
  if (ext == "ogg")
    return "audio/ogg";
  if (ext == "wasm")
    return "application/wasm";
  return "application/octet-stream";
}

}  // namespace localim