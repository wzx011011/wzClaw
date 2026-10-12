'use strict';

// 共享 proof 推导/校验模块：relay（server.js）与 companion（companion.js）共用，
// 保证两侧 HMAC 语义只有一份实现。
//
// 协议兼容警告：Dart 侧（wzxClaw_android 的 zcode_relay_client.dart）有等价实现，
// base64url 无 padding（32 字节摘要固定 43 字符）是线上协议事实——
// 不得改动密钥取值、消息拼接格式或编码方式。

const { createHmac, timingSafeEqual } = require('node:crypto');

// 配对质询 proof：HMAC-SHA256(pass_hash 字符串作密钥, `${nonce}|${role}|${sid}`)。
// 注意 pass_hash 本身作为字符串密钥使用，不能先做 base64 解码。
function deriveProof({ passHash, nonce, role, sid }) {
  return createHmac('sha256', passHash).update(`${nonce}|${role}|${sid}`).digest('base64url');
}

// 校验配对质询 proof：严格 base64url(43) 形状检查（拒 hex 等其他编码）+
// timingSafeEqual 常量时间比较。返回布尔值，不做任何副作用。
function verifyProof({ proof, passHash, nonce, role, sid }) {
  const expected = createHmac('sha256', passHash).update(`${nonce}|${role}|${sid}`).digest();
  return verifyShapeAndCompare(proof, expected);
}

// 注册 proof：relay 设置 registrationSecret 后，device_register_init 必须携带
// HMAC-SHA256(secret, device_mid) 的 base64url（hex 不认）。用于阻止公网上
// 任何人自助注册占满 maxRooms/maxDevices 的注册 DoS。
function deriveRegisterProof({ secret, mid }) {
  return createHmac('sha256', secret).update(mid).digest('base64url');
}

// 校验注册 proof：与 verifyProof 同形的形状检查 + 常量时间比较。
function verifyRegisterProof({ proof, secret, mid }) {
  const expected = createHmac('sha256', secret).update(mid).digest();
  return verifyShapeAndCompare(proof, expected);
}

// 形状检查 + 常量时间比较：候选串必须是合法 base64url(43)（SHA-256 摘要定长），
// 先比长度与规范编码再 timingSafeEqual，杜绝编码差异导致的时序旁路。
function verifyShapeAndCompare(proof, expected) {
  const candidate = typeof proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof)
    ? Buffer.from(proof, 'base64url') : Buffer.alloc(0);
  return candidate.length === expected.length && candidate.toString('base64url') === proof
    && timingSafeEqual(candidate, expected);
}

module.exports = { deriveProof, verifyProof, deriveRegisterProof, verifyRegisterProof };
