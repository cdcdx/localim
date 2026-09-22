// LocalIM @ LAN — 协议枚举/类型（与 ../protocol/schema.json 一一对应）
// 唯一事实源是 schema.json；此处是 UI 侧编译期类型。

// 默认连 7615；本机并存多个实例测试时，页面可用 ?port=9165 指向某个实例。
const _wsPort =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('port')
    : null;

export const ENDPOINTS = {
  wsControl: `ws://127.0.0.1:${_wsPort || '7615'}/ws`,
  udpPresencePort: 7616,
  udpPresenceGroup: '239.255.0.16',
  tcpPeerPort: 7617,
  relayPort: 7618,
} as const;

// ---- 信封 ----
export type Dir = 'req' | 'res' | 'ev';

export interface Envelope {
  v: number;
  txn?: string;
  dir: Dir;
  ns: string;
  m: string;
  ok?: boolean;
  err?: { code: number; msg: string };
  d?: unknown;
}

export function req(ns: string, m: string, d?: unknown, txn = `t-${++_txnSeq}`): Envelope {
  return { v: 1, txn, dir: 'req', ns, m, d };
}
let _txnSeq = 0;

// ---- identity ----
export interface HelloPayload {
  deviceId: string;
  name: string;
  platform: 'win' | 'mac' | 'linux';
  version: string;
}

// ---- discovery / roster ----
export interface PeerInfo {
  deviceId: string;
  name: string;
  host: string;
  netmask: string;
  via: 'lan' | 'relay';
  lastSeen: number;
  caps: Caps[];
}
export type Caps = 'chat' | 'media' | 'file' | 'remote' | 'share';

// ---- message ----
export type MsgType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'emoji' | 'system';
export type MsgKind = 'chat' | 'room';

export interface MediaRef {
  name: string;
  size: number;
  mime: string;
  chunk?: number;
  sha256?: string;
  /** 数据面文件 id，用于消息记录与分片传输/P2P 接收结果之间的关联。 */
  fileId?: string;
  url?: string;
  thumbUrl?: string;
  /** SHA256 完整性校验结果：true=通过 / false=失败 / 未设置=未校验。 */
  sha256Ok?: boolean;
}

/** 文件传输阶段：发送/接收进行中 → done/failed/canceled。挂 ChatItem.xfer。 */
export type XferPhase = 'sending' | 'receiving' | 'done' | 'failed' | 'canceled';
export interface XferState {
  phase: XferPhase;
  got: number;
  total: number;
}

export interface ChatMessage {
  kind: MsgKind;
  type: MsgType;
  from: string;
  to: string;
  nonce: string;
  ts: number;
  body: string;
  mediaRef?: MediaRef;
  replyTo?: string;
}

// ---- room ----
export interface RoomInfo {
  roomId: string;
  name: string;
  owner: string;
  members: string[];
  seq: number;
  meshPort: number;
}

// ---- media / remote ----
export type MediaMode = 'voice' | 'video' | 'share' | 'remote';

export interface CallMessage {
  callId: string;
  from: string;
  to: string;
  mode: MediaMode;
  direction: string;
}

export interface SessionDescriptionLike {
  sdp: string;
  type: 'offer' | 'answer';
}
export interface IceCandidateLike {
  candidate: string;
  sdpMLineIndex: number | null;
  sdpMid: string | null;
}
export type InputType = 'mousemove' | 'mousedown' | 'mouseup' | 'wheel' | 'keydown' | 'keyup';

export interface RemoteInput {
  t: InputType;
  x?: number;
  y?: number;
  btn?: number;
  code?: string;
  d?: number;
}

// ---- file ----
export interface FileMeta {
  fileId: string;
  to: string;
  name: string;
  size: number;
  mime: string;
  sha256?: string;
}
export interface ChunkHeader {
  fileId: string;
  chunkIndex: number;
  total: number;
  offset: number;
  len: number;
}
export interface TransferStatus {
  fileId: string;
  name?: string;
  total?: number;
  sent?: number;
  state: 'pending' | 'sending' | 'done' | 'failed' | 'canceled';
}

// ---- profile ----
export interface Profile {
  deviceId: string;
  name: string;
  avatar?: string;
  joinedRooms: string[];
}