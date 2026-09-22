// 静态 WebUI 托管：用 net::HttpServer 把 ui/dist 目录以 HTTP 暴露给本地浏览器。
#ifndef LOCALIM_CORE_WEBSERVER_H_
#define LOCALIM_CORE_WEBSERVER_H_

#include <cstdint>
#include <memory>
#include <string>

#include "base/files/file_path.h"
#include "base/memory/weak_ptr.h"
#include "net/base/ip_endpoint.h"
#include "net/server/http_server.h"

namespace localim {

// 服务于 IO 线程；构造不做事，Start() 监听后即可处理 GET 请求。
class WebServer : public net::HttpServer::Delegate {
 public:
  explicit WebServer(base::FilePath root);
  ~WebServer() override;

  bool Start(uint16_t port);
  void Stop();

  // net::HttpServer::Delegate
  void OnConnect(int connection_id) override {}
  void OnHttpRequest(int connection_id,
                     const net::HttpServerRequestInfo& info) override;
  void OnWebSocketRequest(int connection_id,
                          const net::HttpServerRequestInfo& info) override {}
  void OnWebSocketMessage(int connection_id, std::string data) override {}
  void OnClose(int connection_id) override {}

 private:
  void Send404(int connection_id);
  void ServeFile(int connection_id, const std::string& raw_path);
  std::string MimeTypeFor(const base::FilePath& path) const;

  base::FilePath root_;
  std::unique_ptr<net::HttpServer> server_;
  base::WeakPtrFactory<WebServer> weak_factory_{this};
};

}  // namespace localim

#endif  // LOCALIM_CORE_WEBSERVER_H_