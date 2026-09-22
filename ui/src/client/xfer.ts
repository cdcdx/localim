// 文件传输状态机：把 P2P data channel 上的分片进度/结果关联到消息流卡片，
// 并让文件消息记录（含 mediaRef 元数据）经 daemon message 管道落库、重启可回看。
// 卡片定位的关键是 mediaRef.fileId：它同时存在于消息记录与 RTC fileId 里。
import { app, toast } from '../store';
import type { ChatItem } from '../store';
import { native } from './native_client';
import { MsgType, MediaRef, XferState } from '../types';

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function findByFileId(fileId: string): { convKey: string; item: ChatItem } | null {
  for (const [convKey, arr] of app.state.conversations) {
    for (const it of arr) {
      if (it.mediaRef?.fileId === fileId) return { convKey, item: it };
    }
  }
  return null;
}

function patchItem(convKey: string, item: ChatItem, patch: Partial<ChatItem>): void {
  const conv = app.state.conversations.get(convKey) ?? [];
  const idx = conv.indexOf(item);
  if (idx < 0) return;
  const next = [...conv];
  next[idx] = { ...item, ...patch };
  const m = new Map(app.state.conversations);
  m.set(convKey, next);
  app.patch({ conversations: m });
}

function putAt(convKey: string, msg: ChatItem, force: boolean): void {
  const conv = app.state.conversations.get(convKey) ?? [];
  if (!force && conv.some((c) => c.nonce === msg.nonce)) return;
  const next = [...conv, { ...msg, localSeq: conv.length, status: 'sent' as const }];
  const m = new Map(app.state.conversations);
  m.set(convKey, next);
  app.patch({ conversations: m });
}

function typeOf(mime: string): MsgType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** 发送方：先本地入一条 file 卡片，再把记录经 message.send 落库并中继给对端。返回 nonce。 */
export function pushOutgoingFile(
  peerId: string, roomId: string | undefined,
  file: File, kind: MsgType, fileId: string, sha256: string,
): string {
  const self = app.state.profile?.deviceId ?? '';
  const nonce = `file-${fileId}`;
  const to = roomId ?? peerId;
  const mime = file.type || 'application/octet-stream';
  putAt(to, {
    kind: (roomId ? 'room' : 'chat') as 'room' | 'chat',
    type: kind, from: self, to, nonce, ts: Date.now(), body: file.name,
    mediaRef: { name: file.name, size: file.size, mime, fileId, sha256 },
    xfer: { phase: 'sending', got: 0, total: file.size },
  } as ChatItem, false);
  // 落库 + 中继到对端 daemon（对端同样落库并广播 message.chat 到其 WebUI）。
  native.send('message', 'send', {
    kind: (roomId ? 'room' : 'chat'), type: kind, to, nonce, ts: Date.now(), body: file.name,
    mediaRef: { name: file.name, size: file.size, mime, fileId, sha256 }, channel: roomId ? 'room' : 'chat',
  });
  return nonce;
}

export function updateSendProgress(fileId: string, got: number, total: number): void {
  update(fileId, { phase: 'sending', got, total });
}
export function finishSend(fileId: string): void {
  const hit = findByFileId(fileId);
  if (hit) patchItem(hit.convKey, hit.item, { xfer: { phase: 'done', got: hit.item.mediaRef?.size ?? 0, total: hit.item.mediaRef?.size ?? 0 } });
}
export function cancelSend(fileId: string): void {
  const hit = findByFileId(fileId);
  if (hit) patchItem(hit.convKey, hit.item, { xfer: { phase: 'canceled', got: hit.item.xfer?.got ?? 0, total: hit.item.mediaRef?.size ?? 0 } });
}

export function updateReceiveProgress(fileId: string, got: number, total: number): void {
  update(fileId, { phase: 'receiving', got, total });
}

/** 断点续传启动：发送端在续传会话发出前，把卡片从「传输中断」拉回发送中并回填已传进度。 */
export function resumeSendProgress(fileId: string, got: number, total: number): void {
  update(fileId, { phase: 'sending', got, total });
}

/** 接收端：字节重组完成后把 objectURL + SHA256 结果挂到对应消息；记录未到则补建一条本地卡片。 */
export function completeReceive(
  fileId: string, peerId: string, name: string, size: number, mime: string,
  url: string, sha256Ok?: boolean, sha256?: string,
): void {
  const hit = findByFileId(fileId);
  if (hit) {
    const cur = hit.item.mediaRef ?? ({} as MediaRef);
    const mr: MediaRef = { name: cur.name ?? name, size: cur.size ?? size, mime: cur.mime ?? mime, fileId: cur.fileId, url, sha256: cur.sha256 ?? sha256 };
    if (sha256Ok !== undefined) mr.sha256Ok = sha256Ok;
    patchItem(hit.convKey, hit.item, { mediaRef: mr, xfer: { phase: 'done', got: size, total: size } });
    toast(`收到文件 ${name}`);
    return;
  }
  const self = app.state.profile?.deviceId ?? '';
  const mediaRef: MediaRef = { name, size, mime, fileId, url };
  if (sha256) mediaRef.sha256 = sha256;
  if (sha256Ok !== undefined) mediaRef.sha256Ok = sha256Ok;
  putAt(peerId, {
    kind: 'chat', type: typeOf(mime), from: peerId, to: self, nonce: `rtc-${fileId}`,
    ts: Date.now(), body: name, mediaRef,
    xfer: { phase: 'done', got: size, total: size },
  } as ChatItem, false);
}

export function failReceive(fileId: string): void {
  const hit = findByFileId(fileId);
  if (hit) patchItem(hit.convKey, hit.item, { xfer: { phase: 'failed', got: hit.item.xfer?.got ?? 0, total: hit.item.mediaRef?.size ?? 0 } });
}
export function cancelReceive(fileId: string): void {
  const hit = findByFileId(fileId);
  if (hit) patchItem(hit.convKey, hit.item, { xfer: { phase: 'canceled', got: hit.item.xfer?.got ?? 0, total: hit.item.mediaRef?.size ?? 0 } });
}

function update(fileId: string, xfer: XferState): void {
  const hit = findByFileId(fileId);
  if (hit) patchItem(hit.convKey, hit.item, { xfer });
}