// WebSocket(RFC6455) 连接抽象：握手 + 帧解析/封装，绑定到 net::StreamSocket。
#ifndef LOCALIM_CORE_WS_CONNECTION_H_
#define LOCALIM_CORE_WS_CONNECTION_H_

#include <cstdint>
#include <deque>
#include <memory>
#include <string>

#include "base/functional/callback_forward.h"
#include "base/memory/ref_counted.h"
#include "net/base/io_buffer.h"
#include "net/socket/stream_socket.h"

namespace localim {

// 服务于 IO 线程。收到一条完整 TEXT 消息时回调 on_text；断开时回调 on_closed。
class WsConnection {
 public:
  using OnMessage = base::RepeatingCallback<void(const std::string& json)>;
  using OnClosed = base::RepeatingCallback<void()>;
  using OnWriteDone = base::RepeatingCallback<void()>;

  WsConnection(std::unique_ptr<net::StreamSocket> socket,
               OnMessage on_message,
               OnClosed on_closed,
               base::RepeatingClosure on_drained);
  ~WsConnection();

  // 作为服务端启动：跳过握手（由 WsHub 完成），直接开始读。
  void StartReading();

  // 同 StartReading，但先把握手阶段随 GET 一并到达的帧字节注入读队列。
  void StartReadingWith(const std::string& initial);

  // 作为客户端启动：发送 RFC6455 握手（Get {path} Host:{host}）并读握手应答，
  // 确认 101 后接管为帧读取；期间 SendText 自动加掩码。
  void StartAsClient(const std::string& host, const std::string& path);

  // 发送一帧 TEXT；内部排队串行写。返回 false 表示该连接不可写。
  bool SendText(const std::string& payload);

  bool closed() const { return closed_; }

  // RFC6455 工具（供 ws_hub / relay_client 复用）。
  static std::string EncodeServerFrame(uint8_t opcode, const std::string& payload);
  static std::string EncodeClientFrame(uint8_t opcode, const std::string& payload);

 private:
  void DoRead();
  void OnRead(int result);
  void DoReadHandshake();
  void OnHandshakeRead(int result);
  void TryWriteNext();
  void OnWrite(int result);
  void Close();

  std::unique_ptr<net::StreamSocket> socket_;
  scoped_refptr<net::IOBuffer> read_buf_;
  std::string read_queue_;
  std::deque<std::string> write_queue_;
  bool writing_ = false;
  bool closed_ = false;
  bool client_mode_ = false;
  bool client_handshaken_ = false;
  std::string client_handshake_buf_;

  OnMessage on_message_;
  OnClosed on_closed_;
  base::RepeatingClosure on_drained_;
};

}  // namespace localim

#endif  // LOCALIM_CORE_WS_CONNECTION_H_