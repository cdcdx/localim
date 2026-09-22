// 到本机 LocalIM 守护进程(127.0.0.1:7615) 的控制/信令 WebSocket。
// 单例；连接后广播 store.connected，并按 ns/m 把信封投递给注册的处理函数。
import { app, toast } from '../store';
import { ENDPOINTS, Envelope, req } from '../types';

type Handler = (m: string, d: unknown, txn?: string) => void;

class NativeClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler>(); // key = `${ns}.${m}`
  private pending = new Map<string, { resolve: (d: unknown) => void; reject: (e: Error) => void }>();
  private connectSeq = 0;
  /** 端到端调试：最近收到的原始事件信封（ns/m/d），供测试脚本核对 daemon 是否送达。 */
  evlog: Array<{ ns: string; m: string; d: unknown }> = [];

  connect(): void {
    const token = ++this.connectSeq;
    const ws = new WebSocket(ENDPOINTS.wsControl);
    this.ws = ws;
    ws.onopen = () => {
      app.patch({ connected: true });
      if (localStorage.getItem('localim.profile')) {
        const p = JSON.parse(localStorage.getItem('localim.profile')!);
        this.send('identity', 'hello', {
          deviceId: p.deviceId,
          name: p.name,
          platform: detectPlatform(),
          version: '0.1.0',
        });
        this.send('discovery', 'scan_start', { requireCross: true });
      }
    };
    ws.onclose = () => {
      if (this.connectSeq !== token) return;
      app.patch({ connected: false });
      setTimeout(() => this.connect(), 1500);
    };
    ws.onmessage = (e) => this.onMessage(String(e.data));
  }

  private onMessage(raw: string) {
    let env: Envelope;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    if (env.dir === 'res') {
      const p = this.pending.get(env.txn || '');
      if (!p) return;
      this.pending.delete(env.txn || '');
      if (env.ok) p.resolve(env.d);
      else p.reject(new Error(env.err?.msg || 'rpc error'));
      return;
    }
    if (env.dir === 'ev') {
      if (this.evlog.length > 200) this.evlog.splice(0, this.evlog.length - 200);
      this.evlog.push({ ns: env.ns, m: env.m, d: env.d });
      const h = this.handlers.get(`${env.ns}.${env.m}`);
      h?.(env.m, env.d, env.txn);
    }
  }

  on(ns: string, m: string, h: Handler) {
    this.handlers.set(`${ns}.${m}`, h);
  }

  /** 加载会话 target(单聊=对方deviceId; 群=roomId) 的历史，合并进 conversations(按 nonce 去重)。 */
  loadHistory(target: string, kind: 'chat' | 'room') {
    this.request<{ items: import('../types').ChatMessage[] }>('message', 'history', { to: target, kind })
      .then(({ items }) => {
        const self = app.state.profile?.deviceId;
        const conv = app.state.conversations.get(target) || [];
        const seen = new Set(conv.map((c) => c.nonce));
        const merged = [...conv];
        for (const it of items) {
          if (it.nonce && seen.has(it.nonce)) continue;
          const key = it.kind === 'room' ? it.to : (it.from === self ? it.to : it.from);
          if (key !== target) continue;
          merged.push({ ...it, localSeq: merged.length, status: 'sent' });
          if (it.nonce) seen.add(it.nonce);
        }
        merged.sort((a, b) => a.ts - b.ts);
        const m = new Map(app.state.conversations);
        m.set(target, merged);
        app.patch({ conversations: m });
      })
      .catch(() => {});
  }

  /** 登录/重新上线后拉取一次在线表（peer_found 只在新 peer 上线时广播，不重放既有 roster）。 */
  loadRoster() {
    this.request<{ peers: import('../types').PeerInfo[] }>('roster', 'list', {})
      .then(({ peers }) => {
        if (!Array.isArray(peers)) return;
        // 以 daemon 的 roster 为权威：整体替换（而非合并），使下线/注销的 peer 能被移除。
        const m = new Map<string, import('../types').PeerInfo>();
        for (const p of peers) m.set(p.deviceId, p);
        app.patch({ peers: m });
      })
      .catch(() => {});
  }

  send(ns: string, m: string, d?: unknown): string {
    const env = req(ns, m, d);
    this.ws?.send(JSON.stringify(env));
    return env.txn!;
  }

  request<T = unknown>(ns: string, m: string, d?: unknown): Promise<T> {
    const txn = this.send(ns, m, d);
    return new Promise<T>((res, rej) => {
      this.pending.set(txn, { resolve: (d: unknown) => res(d as T), reject: rej });
      setTimeout(() => {
        if (this.pending.has(txn)) {
          this.pending.delete(txn);
          rej(new Error('timeout'));
        }
      }, 12000);
    });
  }
}

function detectPlatform(): 'win' | 'mac' | 'linux' {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'win';
}

export const native = new NativeClient();

export function initNativeHooks() {
  native.on('presence', 'peer_found', (_m, d) => {
    const peer = d as import('../types').PeerInfo;
    const m = new Map(app.state.peers);
    m.set(peer.deviceId, peer);
    app.patch({ peers: m });
  });
  native.on('presence', 'peer_lost', (_m, d) => {
    const { deviceId } = d as { deviceId: string };
    const m = new Map(app.state.peers);
    m.delete(deviceId);
    app.patch({ peers: m });
  });
  native.on('message', 'chat', (_m, d) => pushMessage(d as import('../types').ChatMessage));
  native.on('message', 'ack', (_m, d) => {
    // 送达回执：把对应发送消息标记为已送达（离线消息补投 / 直发成功均触发）。
    const { nonce } = d as { to: string; nonce: string };
    if (!nonce) return;
    const m = new Map(app.state.conversations);
    for (const [convKey, arr] of m) {
      const idx = arr.findIndex((c) => c.nonce === nonce);
      if (idx < 0) continue;
      const next = [...arr];
      next[idx] = { ...next[idx], status: 'delivered' };
      m.set(convKey, next);
      break;
    }
    app.patch({ conversations: m });
  });
  native.on('room', 'room_message', (_m, d) => {
    const msg = (d as { message: import('../types').ChatMessage }).message ?? (d as any);
    pushMessage(msg);
  });
  // 来电振铃/登记由 webrtc.ts 的 media.call_invite 处理器承担（NativeClient 按 ns.m 单一覆盖，
  // 此处注册会被其覆盖，故不再重复处理来电浮层）。
  native.on('media', 'media', (_m, d) => {
    const e = d as { kind: string; callId: string };
    if (e.kind === 'accepted') {
      app.patch({ media: app.state.media ? { ...app.state.media, state: 'connecting' } : app.state.media });
    } else if (e.kind === 'ended') {
      app.patch({ media: null });
    }
  });
  native.on('file', 'transfer_status', (_m, d) => {
    const st = d as import('../types').TransferStatus;
    if (st.state === 'done') toast(`文件 ${st.name ?? ''} 传输完成`);
  });
  native.on('room', 'joined', (_m, d) => {
    const room = d as import('../types').RoomInfo;
    upsertRoom(room);
    toast(`已加入群「${room.name}」`);
  });
  native.on('room', 'invited', (_m, d) => {
    const room = d as import('../types').RoomInfo;
    upsertRoom(room);
    toast(`被邀请加入群「${room.name}」，成员 ${room.members?.length ?? 0} 人`);
  });
  native.on('room', 'sync', (_m, d) => {
    const room = d as import('../types').RoomInfo;
    upsertRoom(room);
  });
  native.on('room', 'room_sync', (_m, d) => {
    const room = d as import('../types').RoomInfo;
    upsertRoom(room);
  });
  native.on('room', 'member_joined', (_m, d) => {
    const e = d as { roomId: string; member: string };
    setMembers(e.roomId, (ms) => { const s = new Set(ms); s.add(e.member); toast('成员 ' + e.member.slice(0, 6) + ' 入群'); return [...s]; });
  });
  native.on('room', 'member_left', (_m, d) => {
    const e = d as { roomId: string; member: string; name?: string };
    if (e.member === app.state.profile?.deviceId) {
      // 自己被踢出：从群列表移除
      const m = new Map(app.state.rooms);
      m.delete(e.roomId);
      app.patch({ rooms: m });
      toast(`你已被移出群「${e.name ?? ''}」`);
      return;
    }
    setMembers(e.roomId, (ms) => { const s = new Set(ms); s.delete(e.member); return [...s]; });
  });
}

function upsertRoom(room: import('../types').RoomInfo) {
  const m = new Map(app.state.rooms);
  const prev = m.get(room.roomId);
  m.set(room.roomId, { ...(prev || {}), ...room } as import('../types').RoomInfo);
  app.patch({ rooms: m });
}

function setMembers(roomId: string, updater: (ms: string[]) => string[]) {
  const prev = app.state.rooms.get(roomId);
  if (!prev) return;
  const next = { ...prev, members: updater(prev.members || []) };
  const m = new Map(app.state.rooms);
  m.set(roomId, next);
  app.patch({ rooms: m });
}

function pushMessage(msg: import('../types').ChatMessage) {
  // 单聊一律挂在"对方 deviceId"下，无论自己发出还是对方发来；群聊挂在 roomId。
  const self = app.state.profile?.deviceId;
  const key = msg.kind === 'room' ? msg.to : (msg.from === self ? msg.to : msg.from);
  const conv = app.state.conversations.get(key) || [];
  conv.push({ ...msg, localSeq: conv.length, status: 'sent' });
  const m = new Map(app.state.conversations);
  m.set(key, conv);
  app.patch({ conversations: m });
}

/** WebRTC 数据面直收的文件/媒体：构造 ChatMessage 挂进会话（不落 daemon 历史，仅本端展示）。 */
export function pushReceivedFile(
  peerId: string,
  mediaRef: import('../types').MediaRef,
  type: 'image' | 'video' | 'audio' | 'file',
) {
  const self = app.state.profile?.deviceId;
  pushMessage({
    kind: 'chat', type, from: peerId, to: self ?? '', nonce: `rtc-${mediaRef.name}-${Date.now()}`,
    ts: Date.now(), body: mediaRef.name, mediaRef,
  });
} 
function modeName(mode: string) {
  return ({ voice: '语音通话', video: '视频通话', share: '共享桌面', remote: '远程控制' } as Record<string, string>)[mode] ?? mode;
}