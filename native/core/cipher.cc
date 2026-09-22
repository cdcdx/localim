#include "core/cipher.h"

#include <string_view>
#include <vector>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "crypto/aead.h"
#include "crypto/hmac.h"

namespace localim {

namespace {
constexpr size_t kNonceLen = 12;  // AES-GCM 推荐 nonce 长度（96 bit）
constexpr std::string_view kInfoEnc = "localim/aesgcm/enc";
constexpr std::string_view kInfoMac = "localim/hmac/ack";

// RFC5869 HKDF-SHA256 extract+expand，输出 32B（单块，counter=1）。
std::array<uint8_t, 32> HkdfSha256(base::span<const uint8_t> ikm,
                                   base::span<const uint8_t> info) {
  static const std::array<uint8_t, 32> kZeroSalt = {};
  // extract：PRK = HMAC-SHA256(salt, IKM)。无盐时用 32 字节零盐。
  const std::array<uint8_t, 32> prk = crypto::hmac::SignSha256(kZeroSalt, ikm);
  // expand：T(1) = HMAC-SHA256(PRK, info || 0x01)。
  std::vector<uint8_t> payload;
  payload.reserve(info.size() + 1);
  payload.insert(payload.end(), info.begin(), info.end());
  payload.push_back(0x01);
  return crypto::hmac::SignSha256(prk, payload);
}

std::string ToHex(base::span<const uint8_t> bytes) {
  return base::HexEncode(bytes);
}
}  // namespace

MessageCipher::MessageCipher(const std::string& psk) : psk_(psk) {
  if (psk.empty()) {
    enabled_ = false;
    return;
  }
  enc_key_ = HkdfSha256(base::as_byte_span(psk_), base::as_byte_span(kInfoEnc));
  mac_key_ = HkdfSha256(base::as_byte_span(psk_), base::as_byte_span(kInfoMac));
  enabled_ = true;
}

bool MessageCipher::EncryptBody(const std::string& plain, std::string& ct_b64,
                                std::string& iv_b64) {
  if (!enabled_)
    return false;
  const std::string nonce = base::RandBytesAsString(kNonceLen);
  crypto::Aead aead(crypto::Aead::AES_256_GCM, enc_key_);
  std::string ct;
  // GCM 输出在密文末尾附带认证标签（EVP_AEAD seal）。
  if (!aead.Seal(plain, nonce, /*additional_data=*/"", &ct))
    return false;
  iv_b64 = base::Base64Encode(nonce);
  ct_b64 = base::Base64Encode(ct);
  return true;
}

bool MessageCipher::DecryptBody(const std::string& ct_b64,
                                const std::string& iv_b64,
                                std::string& plain) {
  if (!enabled_)
    return false;
  std::string nonce, ct;
  if (!base::Base64Decode(iv_b64, &nonce) || !base::Base64Decode(ct_b64, &ct))
    return false;
  if (nonce.size() != kNonceLen)
    return false;
  crypto::Aead aead(crypto::Aead::AES_256_GCM, enc_key_);
  return aead.Open(ct, nonce, /*additional_data=*/"", &plain);
}

std::string MessageCipher::Sign(const std::string& body_json,
                                const std::string& ts,
                                const std::string& nonce) const {
  // 被认证的串 = 规范化 body_json(不含 ts/nonce/sig) + ts + nonce，
  // 防止攻击者篡改用于防重放/时间窗的字段而不被察觉。
  const std::string mac_input =
      body_json + "\n" + "ts=" + ts + "\n" + "nonce=" + nonce;
  return ToHex(
      crypto::hmac::SignSha256(mac_key_, base::as_byte_span(mac_input)));
}

bool MessageCipher::Verify(const std::string& body_json,
                           const std::string& ts, const std::string& nonce,
                           const std::string& sig_hex) const {
  if (!enabled_ || sig_hex.empty())
    return false;
  std::vector<uint8_t> mac;
  if (!base::HexStringToBytes(sig_hex, &mac) || mac.size() != 32)
    return false;
  const std::string mac_input =
      body_json + "\n" + "ts=" + ts + "\n" + "nonce=" + nonce;
  // Verify 内部作 constant-time 比较（mac 为动态长度，已在上方确认 size==32）。
  return crypto::hmac::Verify(crypto::hash::HashKind::kSha256, mac_key_,
                              base::as_byte_span(mac_input), mac);
}

}  // namespace localim