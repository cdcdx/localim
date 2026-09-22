// 消息加密(cipher)：局域网预共享口令(PSK)派生的对称加密层。
//  - 机密性：文字 body 用 AES-256-GCM 加密（crypto::Aead），附带认证标签。
//  - 认证/防伪造/防篡改/防重放：peer 信封整体经 HMAC-SHA256 签名 + 时间窗 + nonce 去重。
// PSK 仅存在于 daemon，不进 WS 物理链路；两端填同一口令才能互解互通，否则视为不可解密。
#ifndef LOCALIM_CORE_CIPHER_H_
#define LOCALIM_CORE_CIPHER_H_

#include <array>
#include <cstdint>
#include <string>

namespace localim {

// AES-256-GCM 密钥长度 32B，GCM nonce 12B。
class MessageCipher {
 public:
  // psk 为空 -> 加密关闭（明文模式，行为与旧版一致）；否则派生两组子密钥。
  explicit MessageCipher(const std::string& psk);

  bool enabled() const { return enabled_; }

  // 加密单条消息 body（文字内容）。返回 false 表示未启用。
  // ct_b64/iv_b64 为经 base64 编码的密文(含 GCM tag)与随机 nonce。
  bool EncryptBody(const std::string& plain, std::string& ct_b64,
                   std::string& iv_b64);
  // 解密 EncryptBody 的产物；密钥不匹配/被篡改时返回 false。
  bool DecryptBody(const std::string& ct_b64, const std::string& iv_b64,
                   std::string& plain);

  // 信封认证签名：对规范化 body_json(不含 ts/nonce/sig) + ts + nonce 计算 HMAC-SHA256(hex)。
  std::string Sign(const std::string& body_json, const std::string& ts,
                   const std::string& nonce) const;
  // 校验签名；constant-time 比较，拒收篡改/伪造/密钥不匹配的信封。
  bool Verify(const std::string& body_json, const std::string& ts,
              const std::string& nonce, const std::string& sig_hex) const;

 private:
  bool enabled_ = false;
  std::string psk_;
  std::array<uint8_t, 32> enc_key_;  // AES-256-GCM 加密钥
  std::array<uint8_t, 32> mac_key_;  // HMAC-SHA256 认证钥
};

}  // namespace localim

#endif  // LOCALIM_CORE_CIPHER_H_