// WebRTC 媒体引擎 —— 语音/视频/共享桌面/远程控制 + data channel(文件/远程输入)。
// 信令(offer/answer/ice/metadata)经本机 daemon(ws 7615) 中继，媒体与载荷走 P2P。
import { native } from './native_client';
import {
  completeReceive, failReceive, finishSend, sha256Hex, updateReceiveProgress, updateSendProgress, cancelSend, cancelReceive, pushOutgoingFile, resumeSendProgress,
} from './xfer';
import { app, toast } from '../store';
import { ChunkHeader, FileMeta, MediaMode, RemoteInput } from '../types';
// 【临时诊断】接收/发送帧日志（fmeta 时清空，仅反映当前文件；上限4500）
const __frameDbg: string[] = [];
const __frameLog = (s: string) => { if (__frameDbg.length < 4500) __frameDbg.push(s); };

const RTC_CONFIG: RTCConfiguration = { iceServers: [] }; // 纯局域网：无需 STUN/TURN
const CHUNK = 1 << 16; // 64KB：低于 Chromium 缺省 SCTP 单消息 256KB 上限

// 断点续传：接收端已收分片跨会话保留（通道中断不丢），发送端保留源文件与进度，
// 续传时经 fresume/fresume_ack 协商对端已有连续字节，仅补发缺失块。
interface RecvState { meta: FileMeta; chunks: ArrayBuffer[]; contig: number; got: number; recvBytes: number; }
const persistRecv = new Map<string, RecvState>();
// 接收已收字节的归档（重组完成后 persistRecv 被删，但保留统计供断点续传 e2e 判定）。
const recvDoneRecord = new Map<string, { got: number; recvBytes: number }>();
interface SendState { peerId: string; isRoom: boolean; meta: FileMeta; blob: Blob; chunk: number; lastGot: number; resumeFromIndex?: number; }
const sendState = new Map<string, SendState>();

class PeerSession {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null = null;
  dcLabel = 'localim';
  mode: MediaMode;
  callId: string;
  peerId: string;
  onRemoteTrack?: (stream: MediaStream) => void;
  /** 复用已建会话（文件/远程附加 data channel）时由外部调用 */
  attachChannel?: (ch: RTCDataChannel) => void;

  // 接收装配：当前活动文件 id 与落位索引（data 有序，但续传按 chunkIndex 精确落位）。
  private activeFileId: string | null = null;
  private activeChunkIndex = 0;
  // 发送侧取消/中断标志：cancel 发 fend(canceled)；interrupt 静默停止（保留 sendState 供续传）。
  private sendCanceled = false;
  private interruptSilent = false;
  // 已发连续字节（供发送端保留在 sendState 里，续传时回填进度）。
  private lastGot = 0;
  // 断点续传协商：fileId -> 收到 fresume_ack 时的回调（得到对端已收连续字节 got=0 表示从头）。
  private resumePromises = new Map<string, (got: number) => void>();
  // trickle ICE：setRemoteDescription 之前到达的候选先进队，远端描述就绪后补加。
  private iceQueue: RTCIceCandidateInit[] = [];

  constructor(callId: string, peerId: string, mode: MediaMode) {
    this.callId = callId;
    this.peerId = peerId;
    this.mode = mode;
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.attachChannel = (ch: RTCDataChannel) => this.onChannelOpen(ch);
    this.pc.onicecandidate = (e) => {
      if (e.candidate) native.send('media', 'ice', { callId, to: peerId, candidate: e.candidate.toJSON() });
    };
    this.pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.onRemoteTrack?.(stream);
      // 远端轨道即对端媒体：登记进流注册表，供媒体 UI 订阅绑定到 <video>。
      remoteStreams.set(callId, stream);
      emitStreams();
    };
    this.pc.ondatachannel = (e) => this.attachChannel?.(e.channel);
  }

  private onChannelOpen(ch: RTCDataChannel) {
    ch.binaryType = 'arraybuffer'; // 统一二进制为 ArrayBuffer，保证接收端按 instanceof 收敛
    ch.onopen = () => {
      this.dc = ch;
      toast('数据通道已建立');
    };
    ch.onclose = () => {
      // 通道中断：活动文件若未传完标记失败且保留已收分片（供断点续传）。
      const fileId = this.activeFileId;
      if (fileId) {
        const rec = persistRecv.get(fileId);
        if (rec && rec.got < rec.meta.size) failReceive(fileId);
      }
    };
    ch.onmessage = (e) => this.onChannelMessage(e.data);
  }

  private onChannelMessage(data: unknown) {
    if (typeof data === 'string') {
      let frame: { t?: string; meta?: FileMeta; head?: ChunkHeader; fileId?: string; reason?: string; got?: number; total?: number; ev?: RemoteInput };
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (__frameDbg.length < 4500) __frameDbg.push(`S:${frame.t}:${String((frame as any).head?.chunkIndex ?? (frame as any).meta?.fileId ?? frame.fileId ?? '').slice(0, 8)}:${frame.reason ?? ''}`);
      if (frame.t === 'input' && frame.ev) {
        // 被控端(宿主)收到的控制端输入事件：转发给本机 daemon，落到 input_injector 注入系统。
        native.send('media', 'remote_input', frame.ev as RemoteInput);
      } else if (frame.t === 'fmeta' && frame.meta) {
        // 声明文件开始：若已有同名(同 size)接收器则复用——即断点续传，保留已收分片继续拼。
        __frameDbg.length = 0; // 新文件开始，聚焦当前传输
        const id = frame.meta.fileId;
        this.activeFileId = id;
        let rec = persistRecv.get(id);
        if (!rec || rec.meta.size !== frame.meta.size) {
          rec = { meta: frame.meta, chunks: [], contig: 0, got: 0, recvBytes: 0 };
          persistRecv.set(id, rec);
        } else {
          rec.meta = { ...frame.meta };
        }
        updateReceiveProgress(id, rec.got, frame.meta.size);
      } else if (frame.t === 'fhead' && frame.head && this.activeFileId) {
        const rec = persistRecv.get(this.activeFileId);
        this.activeChunkIndex = frame.head.chunkIndex;
        updateReceiveProgress(frame.head.fileId, rec?.got ?? 0, rec?.meta.size ?? 0);
      } else if (frame.t === 'fend' && frame.fileId) {
        // 发送方主动终止：取消则丢弃已收分片；其余(中断/普通失败)保留供续传。
        if (frame.reason === 'canceled') { cancelReceive(frame.fileId); persistRecv.delete(frame.fileId); }
        else failReceive(frame.fileId);
        if (this.activeFileId === frame.fileId) this.activeFileId = null;
      } else if (frame.t === 'fresume' && frame.fileId) {
        // 发送方询问对端(接收方)已收进度：回已收连续字节，供其从断点续传。
        const rec = persistRecv.get(frame.fileId);
        this.dc?.send(JSON.stringify({ t: 'fresume_ack', fileId: frame.fileId, got: rec?.got ?? 0 }));
      } else if (frame.t === 'fresume_ack' && frame.fileId) {
        const r = this.resumePromises.get(frame.fileId);
        if (r) { this.resumePromises.delete(frame.fileId); r(frame.got || 0); }
      }
      return;
    }
    // 二进制分片：按最近 fhead 声明的 chunkIndex 落位，推进连续前缀进度。
    if (this.activeFileId) {
      const rec = persistRecv.get(this.activeFileId);
      if (rec) {
        let ab: ArrayBuffer;
        if (data instanceof ArrayBuffer) ab = data;
        else if (data instanceof Uint8Array) ab = data.buffer as ArrayBuffer;
        else return;
        if (__frameDbg.length < 400) __frameDbg.push(`D:${this.activeFileId.slice(0, 6)}:${this.activeChunkIndex}:${ab.byteLength}`);
        rec.chunks[this.activeChunkIndex] = ab;
        rec.recvBytes += ab.byteLength; // 收到的分片字节累计（含续传补的），用于判定是否只补缺失
        while (rec.chunks[rec.contig]) {
          rec.got += rec.chunks[rec.contig].byteLength;
          rec.contig++;
        }
        updateReceiveProgress(this.activeFileId, rec.got, rec.meta.size);
        if (rec.got >= rec.meta.size) this.finishReceive(rec.meta, rec);
      }
    }
  }

  private async finishReceive(meta: FileMeta, rec: RecvState) {
    // 按索引升序拼出原始字节序（续传可能稀疏填充，不能用简单 push）。
    const ordered: ArrayBuffer[] = [];
    for (let i = 0; i < rec.contig; i++) if (rec.chunks[i]) ordered.push(rec.chunks[i]);
    const blob = new Blob(ordered, { type: meta.mime });
    const url = URL.createObjectURL(blob);
    // SHA256 完整性校验：重组后本地算一遍，与 fmeta 声明的摘要比对。
    let sha256Ok: boolean | undefined;
    if (meta.sha256) {
      try {
        sha256Ok = (await sha256Hex(blob)) === meta.sha256;
      } catch {
        sha256Ok = undefined;
      }
    }
    completeReceive(meta.fileId, this.peerId, meta.name, meta.size, meta.mime, url, sha256Ok, meta.sha256);
    recvDoneRecord.set(meta.fileId, { got: rec.got, recvBytes: rec.recvBytes });
    persistRecv.delete(meta.fileId);
    this.activeFileId = null;
  }

  async addTrackFrom(stream: MediaStream) {
    for (const t of stream.getTracks()) this.pc.addTrack(t, stream);
  }

  async sendOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    native.send('media', 'offer', { callId: this.callId, to: this.peerId, sdp: offer });
  }

  async onSignal(kind: 'offer' | 'answer' | 'ice', data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    if (kind === 'offer' && data.sdp) {
      await this.pc.setRemoteDescription(data.sdp);
      // 补灌远端描述就绪前暂存的候选，再应答。
      await this.flushIce();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      native.send('media', 'answer', { callId: this.callId, to: this.peerId, sdp: answer });
    } else if (kind === 'answer' && data.sdp) {
      if (this.pc.signalingState !== 'stable') await this.pc.setRemoteDescription(data.sdp);
      await this.flushIce();
    } else if (kind === 'ice' && data.candidate) {
      try {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.candidate);
        else this.iceQueue.push(data.candidate); // 远端描述未就绪：暂存，防止被静默丢弃
      } catch {
        /* 竞态可忽略，加 ICE 重试即可 */
      }
    }
  }

  private async flushIce() {
    if (!this.pc.remoteDescription) return;
    const q = this.iceQueue;
    this.iceQueue = [];
    for (const c of q) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        /* 个别候选可能已失效，忽略 */
      }
    }
  }

  sendInput(ev: RemoteInput) {
    this.dc?.send(JSON.stringify({ t: 'input', ev }));
  }

  /** 请求取消正在发送的文件：停止分片循环并通知对端终止(丢弃其已收分片)。 */
  cancel() {
    this.sendCanceled = true;
  }

  /** 静默中断传输（模拟断连/被打断）：停止分片但不发 fend(canceled)，对端保留已收供续传。 */
  interrupt() {
    this.sendCanceled = true;
    this.interruptSilent = true;
  }

  /** 发送文件：fromIndex>0 时从该块开始（断点续传），跳过已由对端持有的块。收尾更新 sendState.lastGot。 */
  sendFile(meta: FileMeta, blob: Blob, chunk: number = CHUNK, fromIndex = 0) {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return;
    // 先声明元数据（含 SHA256）。若对端已有同 fileId 且 size 一致的接收器则自动复用续拼。
    dc.send(JSON.stringify({ t: 'fmeta', meta }));
    const fail = () => {
      failReceive(meta.fileId);
      sendingByFileId.delete(meta.fileId);
      const st = sendState.get(meta.fileId);
      if (st) st.lastGot = this.lastGot;
    };
    const stop = (canceled: boolean) => {
      if (this.interruptSilent) {
        // 静默中断（断点续传的前置）：不发 fend，对端保留已收分片；本地保留源与进度供续传，卡片标记中断。
        failReceive(meta.fileId);
      } else {
        // 明确取消：通知对端丢弃已收分片；清源不可续传，卡片标记取消。
        dc?.send(JSON.stringify({ t: 'fend', fileId: meta.fileId, reason: 'canceled' }));
        cancelSend(meta.fileId);
        sendState.delete(meta.fileId);
      }
      __frameLog(`STOP:${canceled}:intr=${this.interruptSilent}`);
      sendingByFileId.delete(meta.fileId);
      const st = sendState.get(meta.fileId);
      if (st) st.lastGot = this.lastGot;
    };
    const start = async (i: number) => {
      // 背压：通道积压超过阈值则等 bufferedamountlow 再发，避免洪水灌满 SCTP 缓冲；
      // 也避免 localhost 下整文件瞬间发完，保证中断/取消有可靠时机。
      // 等待途中可能收到 取消/中断/断连：周期探测，及时放行到 stop() 收尾。
      while (!this.sendCanceled && dc.bufferedAmount > CHUNK * 16) {
        dc.bufferedAmountLowThreshold = CHUNK * 4;
        await new Promise<void>((r) => {
          let finished = false;
          let iv = 0 as unknown as ReturnType<typeof setInterval>;
          const finish = () => { if (finished) return; finished = true; clearInterval(iv);
            dc.removeEventListener('bufferedamountlow', onLow); dc.removeEventListener('close', onClose); r(); };
          const onLow = () => finish();
          const onClose = () => finish();
          dc.addEventListener('bufferedamountlow', onLow);
          dc.addEventListener('close', onClose);
          iv = setInterval(() => { if (this.sendCanceled || dc.readyState !== 'open') finish(); }, 30);
          if (dc.readyState !== 'open' || this.sendCanceled) finish();
        });
      }
      const offset = i * chunk;
      if (this.sendCanceled) { stop(true); return; }
      if (!dc || dc.readyState !== 'open') { fail(); return; }
      if (offset >= meta.size) {
        native.send('file', 'transfer_ack', { fileId: meta.fileId, done: true });
        finishSend(meta.fileId);
        sendState.delete(meta.fileId);
        sendingByFileId.delete(meta.fileId);
        return;
      }
      const slice = await blob.slice(offset, Math.min(offset + chunk, meta.size)).arrayBuffer();
      const head: ChunkHeader = { fileId: meta.fileId, chunkIndex: i, total: Math.ceil(meta.size / chunk), offset, len: slice.byteLength };
      __frameLog(`T:${i}`);
      try {
        dc.send(JSON.stringify({ t: 'fhead', head }));
        dc.send(slice); // 已 await 成 ArrayBuffer：规避 Blob 异步序列化导致的帧错位/乱序
      } catch {
        fail();
        return;
      }
      this.lastGot = offset + slice.byteLength;
      updateSendProgress(meta.fileId, offset + slice.byteLength, meta.size);
      if (i % 32 === 0) native.send('file', 'transfer_status', { fileId: meta.fileId, state: 'sending', sent: offset + slice.byteLength });
      setTimeout(() => void start(i + 1), 0); // 整形，避免一次洪水灌满 data channel
    };
    void start(fromIndex);
  }

  /** 断点续传：连通后向对端询问已收连续字节，据此决定起始块，只补发缺失部分。 */
  resumeAndSend(st: SendState, timeoutMs = 5000) {
    void awaitOn(this, st.meta.fileId, timeoutMs).then((gotBytes) => {
      const fromIndex = Math.min(gotBytes, st.meta.size) > 0 ? Math.ceil(Math.min(gotBytes, st.meta.size) / st.chunk) : 0;
      st.resumeFromIndex = fromIndex; // 供 e2e 断言确实从断点续发（>0 而非全量重传）
      this.sendFile(st.meta, st.blob, st.chunk, fromIndex);
    });

    function awaitOn(s: PeerSession, fileId: string, ms: number): Promise<number> {
      return new Promise((resolve) => {
        s.resumePromises.set(fileId, resolve);
        s.dc?.send(JSON.stringify({ t: 'fresume', fileId }));
        setTimeout(() => {
          if (s.resumePromises.has(fileId)) { s.resumePromises.delete(fileId); resolve(0); }
        }, ms);
      });
    }
  }

  hangup() {
    native.send('media', 'call_hangup', { callId: this.callId, to: this.peerId });
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }
}

const sessions = new Map<string, PeerSession>();
// 发送中文件：fileId -> 承载它的会话，供文件卡「取消」按钮按 fileId 定位并终止分片。
const sendingByFileId = new Map<string, PeerSession>();
// 会话媒体流注册表：callId -> 本地采集(摄像头/屏幕) / 远端轨道流。媒体 UI 订阅变化后绑定 <video>。
const localStreams = new Map<string, MediaStream>();
const remoteStreams = new Map<string, MediaStream>();
const streamListeners = new Set<() => void>();
function emitStreams() {
  for (const l of streamListeners) l();
}
/** 订阅任一会话的媒体流有无/内容变化（远端轨道到达、本地采集就绪）。返回取消订阅函数。 */
export function onStreamsChange(cb: () => void): () => void {
  streamListeners.add(cb);
  return () => streamListeners.delete(cb);
}
/** 取某 callId 会话当前的本地/远端流（无则为 undefined）。 */
export function sessionStreams(callId: string): { local?: MediaStream; remote?: MediaStream } {
  return { local: localStreams.get(callId), remote: remoteStreams.get(callId) };
}
function setLocalStream(callId: string, stream: MediaStream | null) {
  if (stream) localStreams.set(callId, stream);
  else localStreams.delete(callId);
  emitStreams();
}
function clearSessionStreams(callId: string) {
  if (localStreams.delete(callId) || remoteStreams.delete(callId)) emitStreams();
}

// 来电暂存：callId -> { from, mode, stream?(已采集) }，被叫接听到的 offer 处理时用它补媒体轨并应答。
const pendingCalls = new Map<string, { from: string; mode: MediaMode; stream?: MediaStream }>();

// 群共享(群桌面)：房主一人采集屏幕，向每个在线成员各建一条 PeerSession(独立 callId)。
// viewers 按成员 deviceId 索引；roomShareByCallId 供 call_hangup 判断某会话是否属于本机群共享，
// 避免观众断开时误关房主整场共享。
interface RoomShare {
  roomId: string;
  stream: MediaStream;
  mode: MediaMode;
  viewers: Map<string, PeerSession>;
}
const roomShares = new Map<string, RoomShare>();
const roomShareByCallId = new Map<string, string>(); // callId -> roomId
// 群共享成员控制：观众请求停止的待办（roomId -> 请求成员 deviceId，房主一次只处理最新一条）。
const stopReqMembers = new Map<string, string>();
// 群共享远程控制：房主视角「正在控制本场共享屏」的成员集合（roomId -> 成员 deviceId 集合）。
// 仅房主维护；授权即入队、观众主动退出/被撤销/被踢出即出队，集合走空时解除本机注入武装。
const ctrlMembers = new Map<string, Set<string>>();

function newSession(callId: string, peerId: string, mode: MediaMode): PeerSession {
  const s = new PeerSession(callId, peerId, mode);
  sessions.set(callId, s);
  return s;
}

function routeSignal(callId: string, kind: 'offer' | 'answer' | 'ice', data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }, source: string) {
  let s = sessions.get(callId);
  if (!s) {
    // 被动侧：收到 offer 时按源设备建会话；callId 全局唯一，回拨与被控共用。
    const pc = pendingCalls.get(callId);
    s = newSession(callId, source, pc?.mode ?? guessMode(callId));
  }
  void s.onSignal(kind, data);
}
function guessMode(_callId: string): MediaMode {
  // 实际模式由 call_invite 事件携带；此处兜底。
  return 'voice';
}

// 被叫接收来电：登记会话上下文（先采集麦克风，等 offer 到达后补轨并应答）。
let pendingOffer: { callId: string; sdp: RTCSessionDescriptionInit } | null = null;
// 已「决定接听」但 offer 尚未抵达的 callId → peerId：offer 一旦到达立即自动应答，
// 避免用户/测试抢先接听时 offer 后到导致无人产生 answer（对端卡在 checking）。
const armedAnswer = new Map<string, string>();

/** 被叫接听：语音/视频补采本端媒体并应答；共享/远程的观众端无需采集，纯应答即可。 */
async function acceptIncomingCall(callId: string, mode: MediaMode, deviceId: string): Promise<void> {
  let stream: MediaStream | undefined;
  if (mode !== 'share' && mode !== 'remote') {
    stream = await navigator.mediaDevices.getUserMedia(
      mode === 'voice' ? { audio: true } : { audio: true, video: true });
  }
  if (stream) setLocalStream(callId, stream);
  const pc = pendingCalls.get(callId);
  if (stream && pc) pc.stream = stream;
  // 对端=发起方 deviceId（call_invite 里已携带）；避免 offer 未到、会话在此创建时误用本端 id。
  const peerId = pc?.from ?? deviceId;
  // 被叫一经接听即切入直播浮层（无论由按钮或外部直接调用触发）。
  app.patch({ media: {
    callId, direction: 'outgoing', state: 'connecting',
    peer: { deviceId: peerId, name: pc?.from ? (app.state.peers.get(pc.from)?.name ?? pc.from) : peerId, mode },
  } });
  let s = sessions.get(callId);
  if (!s) s = newSession(callId, peerId, mode);
  if (stream) await s.addTrackFrom(stream);
  // 若 offer 已先到（信号量当时未就绪被暂存），此刻立即应答；应答失败不影响后续 offer 重试。
  if (pendingOffer && pendingOffer.callId === callId) {
    const { sdp } = pendingOffer;
    pendingOffer = null;
    await s.onSignal('offer', { sdp }).catch(() => {});
  } else {
    // offer 未到：上弹匣，等 offer 处理器到达时自动应答。
    armedAnswer.set(callId, peerId);
  }
  native.send('media', 'call_accept', { callId, to: peerId });
}

export { acceptIncomingCall };

/** 端到端调试/校验用：导出各会话的 PeerConnection 状态与收发轨道快照。 */
export function mediaDebug() {
  const out: Array<Record<string, unknown>> = [];
  for (const [callId, s] of sessions) {
    out.push({
      callId,
      peerId: s.peerId,
      mode: s.mode,
      pcState: s.pc.connectionState,
      ice: s.pc.iceConnectionState,
      sig: s.pc.signalingState,
      gather: s.pc.iceGatheringState,
      dc: s.dc ? s.dc.readyState : 'none',
      localTracks: s.pc.getSenders().map((x) => x.track?.kind),
      remoteTracks: s.pc.getReceivers().map((x) => x.track?.kind),
    });
  }
  return out;
}

export function hangupDebug() {
  for (const [callId, s] of sessions) {
    if (s.mode === 'remote') native.send('media', 'remote_host', { on: false });
    s.hangup();
    sessions.delete(callId);
    pendingCalls.delete(callId);
    armedAnswer.delete(callId);
    clearSessionStreams(callId);
  }
  pendingOffer = null;
  app.patch({ media: null });
}

/** 端到端诊断：直接暴露各会话的 RTCPeerConnection，供测试脚本抓 getStats。 */
export function debugPcs(): RTCPeerConnection[] {
  return [...sessions.values()].map((s) => s.pc);
}

export function initWebrtc() {
  // 来电登记 + 振铃：保存模式与对端，并弹出接听浮层。
  // 注意 NativeClient.handlers 按 ns.m 单一覆盖，故由本注册同时承担两者
  // （native_client 的 call_invite 处理器会被本注册覆盖而失效）。
  native.on('media', 'call_invite', (_m, d) => {
    const it = d as { callId: string; from: string; mode: MediaMode };
    pendingCalls.set(it.callId, { from: it.from, mode: it.mode });
    if (it.from === app.state.profile?.deviceId) return;
    app.patch({ media: {
      callId: it.callId, direction: 'incoming', state: 'ringing',
      peer: { deviceId: it.from, name: it.from, mode: it.mode },
    } });
  });
  native.on('media', 'offer', (_m, d, _t) => {
    const it = d as { callId: string; from: string; sdp: RTCSessionDescriptionInit; fileSignaling?: boolean };
    const pc = pendingCalls.get(it.callId);
    let s = sessions.get(it.callId);
    if (!s) s = newSession(it.callId, it.from, pc?.mode ?? 'voice');
    // 已决定接听但 offer 后到：立即自动应答（共享/远程观众无采集）。优先于常规暂存逻辑。
    if (armedAnswer.has(it.callId)) {
      armedAnswer.delete(it.callId);
      if (pc?.stream) {
        void s.addTrackFrom(pc.stream).then(() => s.onSignal('offer', { sdp: it.sdp })).catch(() => {});
      } else {
        void s.onSignal('offer', { sdp: it.sdp }).catch(() => {});
      }
      pendingOffer = null;
    } else if (it.fileSignaling || !pc) {
      void s.onSignal('offer', { sdp: it.sdp }).catch(() => {});
      pendingOffer = null;
    } else if (pc?.stream) {
      void s.addTrackFrom(pc.stream).then(() => s.onSignal('offer', { sdp: it.sdp })).catch(() => {});
      pendingOffer = null;
    } else {
      pendingOffer = { callId: it.callId, sdp: it.sdp };
    }
  });
  native.on('media', 'answer', (_m, d) => {
    const it = d as { callId: string; from: string; sdp: RTCSessionDescriptionInit };
    routeSignal(it.callId, 'answer', { sdp: it.sdp }, it.from);
  });
  native.on('media', 'ice', (_m, d) => {
    const it = d as { callId: string; from: string; candidate: RTCIceCandidateInit };
    routeSignal(it.callId, 'ice', { candidate: it.candidate }, it.from);
  });
  native.on('media', 'call_accept', (_m, d) => {
    const it = d as { callId: string };
    app.patch({ media: app.state.media ? { ...app.state.media, state: 'connecting' } : app.state.media });
    void it.callId;
  });
  native.on('media', 'call_hangup', (_m, d) => {
    const it = d as { callId: string };
    const s = sessions.get(it.callId);
    // 观众断连：只摘除对应观众会话，不影响房主整场群共享；观众全走净则结束共享。
    const rs = roomShareOfCallId(it.callId);
    if (rs) {
      const share = roomShares.get(rs);
      if (share) {
        for (const [mid, ss] of share.viewers) if (ss === s) { share.viewers.delete(mid); break; }
        if (share.viewers.size === 0) endRoomShare(rs);
      }
      sessions.delete(it.callId);
      pendingCalls.delete(it.callId);
      roomShareByCallId.delete(it.callId);
      clearSessionStreams(it.callId);
      return;
    }
    if (s?.mode === 'remote') native.send('media', 'remote_host', { on: false });
    try { s?.pc.close(); } catch {}
    sessions.delete(it.callId);
    pendingCalls.delete(it.callId);
    armedAnswer.delete(it.callId);
    clearSessionStreams(it.callId);
    app.patch({ media: null });
  });
  // 群共享成员控制：观众请求停止 → 房主浮层弹出待办；房主应答 → 观众收到结果。
  native.on('media', 'room_share_stop_request', (_m, d) => {
    const it = d as { roomId: string; from: string };
    if (!roomShares.has(it.roomId)) return; // 我非该群共享房主，忽略
    stopReqMembers.set(it.roomId, it.from);
    const name = app.state.peers.get(it.from)?.name ?? it.from;
    if (app.state.media?.roomShare && app.state.media.callId === it.roomId) {
      app.patch({ media: { ...app.state.media, shareReq: { from: it.from, name } } });
    } else {
      toast(`${name} 请求结束群共享`);
    }
  });
  native.on('media', 'room_share_stop_ack', (_m, d) => {
    const it = d as { approved: boolean };
    toast(it.approved ? '群主已同意，即将停止共享' : '群主忽略了停止请求');
  });
  // 群共享远程控制：观众请求控制 → 房主浮层弹待办；房主授权/拒绝 → 观众收到结果并开 control 通道。
  native.on('media', 'share_control_request', (_m, d) => {
    const it = d as { from: string };
    const roomId = roomShareForMember(it.from);
    if (!roomId) return; // 我非该观众所在共享的房主，忽略
    const name = app.state.peers.get(it.from)?.name ?? it.from;
    if (app.state.media?.roomShare && app.state.media.callId === roomId) {
      app.patch({ media: { ...app.state.media, ctrlReq: { from: it.from, name } } });
    } else {
      toast(`${name} 请求控制共享屏幕`);
    }
  });
  native.on('media', 'share_control_grant', (_m, d) => {
    const it = d as { approved: boolean };
    if (it.approved) {
      const m = app.state.media;
      if (m && m.peer.mode === 'share' && m.peer.deviceId) {
        void enableShareControl(m.callId, m.peer.deviceId);
      }
    } else {
      toast('房主未同意本次控制请求');
    }
  });
  // 观众主动退出控制：房主摘除其控制权；无人控制则解除本机注入武装（避免离开后仍可被注入）。
  native.on('media', 'share_control_release', (_m, d) => {
    const it = d as { from: string };
    const roomId = roomShareForMember(it.from);
    if (!roomId) return;
    ctrlMembers.get(roomId)?.delete(it.from);
    syncShareControllers(roomId, { disarm: true });
    toast(`${app.state.peers.get(it.from)?.name ?? it.from} 已结束控制`);
  });
  // 房主撤销观众控制权：观众立即退出控制模式，其输入不再回传本机。
  native.on('media', 'share_control_revoke', () => {
    const m = app.state.media;
    if (!m || m.peer.mode !== 'share') return;
    disableShareControl(m.callId);
    toast('房主已撤销你的控制权');
  });
}

export async function startCall(peerId: string, mode: MediaMode): Promise<PeerSession> {
  const callId = crypto.randomUUID();
  const s = newSession(callId, peerId, mode);
  // 主叫立即弹出自已的直播浮层（本地预览 + 远端画面 + 结束按钮）。
  const peerInfo = app.state.peers.get(peerId);
  app.patch({ media: {
    callId, direction: 'outgoing', state: 'connecting',
    peer: { deviceId: peerId, name: peerInfo?.name ?? peerId, mode },
  } });
  native.send('media', 'call_invite', { callId, to: peerId, mode, direction: 'outgoing' });
  if (mode === 'voice' || mode === 'video') {
    const stream = await navigator.mediaDevices.getUserMedia(
      mode === 'voice' ? { audio: true } : { audio: true, video: true },
    );
    setLocalStream(callId, stream);
    await s.addTrackFrom(stream);
  } else if (mode === 'share' || mode === 'remote') {
    // 共享桌面 / 远程(被控端共享自己的屏幕)：宿主用 getDisplayMedia 采集。
    // share 同步采集系统/标签页音频；remote 是输入控制场景，仅画面。
    const stream = await (mode === 'share' ? getShareStream() : navigator.mediaDevices.getDisplayMedia({ video: true }));
    setLocalStream(callId, stream);
    await s.addTrackFrom(stream);
    if (mode === 'remote') {
      // 远程控制：offerer(被控端)开设数据通道承载输入回传，并武装本机注入器。
      const dc = s.pc.createDataChannel(s.dcLabel);
      s.attachChannel?.(dc);
      s.dc = dc;
      native.send('media', 'remote_host', { on: true });
    }
  }
  await s.sendOffer();
  return s;
}

/** 采集共享源的显示流：优先带系统/标签页音频（同步声音），音频不可用则回退纯画面。 */
async function getShareStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    return await navigator.mediaDevices.getDisplayMedia({ video: true });
  }
}

/** 群共享桌面：向群内每个在线成员广播本机屏幕(各自独立会话/独立 callId，复用单对单信令)。 */
export async function startRoomShare(roomId: string): Promise<{ count: number }> {
  const room = app.state.rooms.get(roomId);
  if (!room) throw new Error('群不存在');
  // 群成员表里是 daemon 网络 id；本机自己的 id 不在自身 peers map 中，
  // 故以 peers.has(m) 过滤即可剔除自己与离线成员，只保留在线他人。
  const members = (room.members || []).filter((m) => app.state.peers.has(m));
  const stream = await getShareStream();
  const share: RoomShare = { roomId, stream, mode: 'share', viewers: new Map() };
  roomShares.set(roomId, share);
  // 房主本端预览：以 roomId 为 callId 登记本地流，媒体浮层直接展示自己的屏幕。
  setLocalStream(roomId, stream);
  app.patch({ media: {
    callId: roomId, roomShare: true, direction: 'outgoing', state: 'live',
    peer: { deviceId: roomId, name: `群共享·${room.name}`, mode: 'share' },
  } });
  let count = 0;
  for (const m of members) {
    const callId = crypto.randomUUID();
    const s = newSession(callId, m, 'share');
    share.viewers.set(m, s);
    roomShareByCallId.set(callId, roomId);
    await s.addTrackFrom(stream);
    native.send('media', 'call_invite', { callId, to: m, mode: 'share', direction: 'outgoing', roomId });
    await s.sendOffer();
    count++;
  }
  toast(`群共享开始，${count} 位观众`);
  return { count };
}

/** 结束群共享：挂断所有观众会话、停采屏幕、拆卸控制注入、移除本端共享浮层。 */
export function endRoomShare(roomId: string) {
  const share = roomShares.get(roomId);
  if (share) {
    for (const s of share.viewers.values()) s.hangup();
    share.stream.getTracks().forEach((t) => t.stop());
  }
  native.send('media', 'remote_host', { on: 'false' }); // 观众停止注入本机
  for (const [cid, rid] of [...roomShareByCallId]) if (rid === roomId) {
    const s = sessions.get(cid);
    try { s?.pc.close(); } catch {}
    sessions.delete(cid);
    pendingCalls.delete(cid);
    roomShareByCallId.delete(cid);
  }
  roomShares.delete(roomId);
  ctrlMembers.delete(roomId);
  clearSessionStreams(roomId);
  app.patch({ media: null });
}

/** 取某 callId 所在群共享的 roomId（非群共享会话则 undefined）。 */
function roomShareOfCallId(callId: string): string | undefined {
  return roomShareByCallId.get(callId);
}

/** 取某房间群共享剩余观众数（非进行中返回 0）。 */
export function roomShareViewerCount(roomId: string): number {
  return roomShares.get(roomId)?.viewers.size ?? 0;
}

/** 取某房间群共享当前观众成员 deviceId 列表（非进行中返回空表）。 */
export function roomShareViewers(roomId: string): string[] {
  return [...(roomShares.get(roomId)?.viewers.keys() ?? [])];
}

/** 房主踢出指定观众：仅挂断该观众会话（不影响其余观众），其浮层随之关闭。 */
export function endRoomShareViewer(roomId: string, memberId: string): boolean {
  const share = roomShares.get(roomId);
  if (!share) return false;
  const s = share.viewers.get(memberId);
  if (!s) return false;
  s.hangup(); // 通知该观众会话结束（对端 call_hangup 收敛）
  share.viewers.delete(memberId);
  for (const [cid, rid] of [...roomShareByCallId]) {
    if (rid === roomId && sessions.get(cid) === s) {
      try { sessions.get(cid)?.pc.close(); } catch {}
      sessions.delete(cid);
      pendingCalls.delete(cid);
      roomShareByCallId.delete(cid);
      clearSessionStreams(cid);
    }
  }
  stopReqMembers.delete(roomId);
  ctrlMembers.get(roomId)?.delete(memberId); // 被踢出的观众一并失去控制权
  if (share.viewers.size === 0) endRoomShare(roomId); // 观众被清空则结束整场共享
  else { syncShareControllers(roomId, { disarm: true }); toast(`已踢出 1 位观众，剩余 ${share.viewers.size} 人`); }
  return true;
}

/** 观众请求房主结束共享：经 daemon 中继发往共享发起方（即浮层里的对端）。 */
export function requestRoomShareStop(roomId: string): boolean {
  const hostId = app.state.media?.peer?.deviceId;
  if (!hostId) return false;
  native.send('media', 'room_share_stop_request', { to: hostId, roomId });
  toast('已请求群主停止共享，等待确认');
  return true;
}

/** 房主处理观众的停止请求：approve 则整场停止；否则仅通知该观众忽略。 */
export function resolveRoomShareStopRequest(roomId: string, memberId: string, approve: boolean): boolean {
  if (!roomShares.has(roomId)) return false;
  stopReqMembers.delete(roomId);
  if (approve) {
    native.send('media', 'room_share_stop_ack', { to: memberId, roomId, approved: true });
    endRoomShare(roomId);
  } else {
    native.send('media', 'room_share_stop_ack', { to: memberId, roomId, approved: false });
    app.patch({ media: app.state.media ? { ...app.state.media, shareReq: undefined } : null });
  }
  return true;
}

/** 取某个共享观众成员所在的群共享 roomId（本机须为其房主；非该共享成员反查不到）。 */
function roomShareForMember(memberId: string): string | undefined {
  for (const [rid, share] of roomShares) if (share.viewers.has(memberId)) return rid;
  return undefined;
}

/** 观众请求控制共享屏幕：向房主(id=媒体浮层对端)发控制请求，等房主授权。 */
export function requestShareControl(callId: string): boolean {
  const hostId = app.state.media?.peer?.deviceId;
  if (!hostId) return false;
  native.send('media', 'share_control_request', { to: hostId, roomId: callId });
  toast('已请求控制共享屏幕，等待房主授权');
  return true;
}

/** 观众获授权后进入控制模式：在本端共享会话上补开 data channel 回传输入，并切到控制浮层。 */
export async function enableShareControl(callId: string, hostId: string): Promise<string> {
  try {
    const { session, created } = await attachRemoteDatachannel(callId, hostId);
    // 新增 data channel 需重新协商（新增 SCTP m-line）才能真正建立：操作端重新发 offer，
    // 被控端 onSignal('offer') 已通用支持 renegotiation 并回 answer；复用既有通道则无需再协商。
    if (created) await session.sendOffer();
    app.patch({ media: app.state.media ? { ...app.state.media, ctrl: true } : app.state.media });
    return 'ok';
  } catch (e) {
    const msg = (e && (e as Error).message) || String(e);
    toast('控制通道建立失败: ' + msg);
    return 'err:' + msg;
  }
}

/** 观众退出控制模式（保留观看）：通知房主释放控制权（房主据此解除注入武装），通道留住待复用。 */
export function disableShareControl(callId?: string): void {
  const m = app.state.media;
  const hostId = m?.peer?.deviceId;
  const cid = callId ?? m?.callId;
  if (hostId && cid) native.send('media', 'share_control_release', { to: hostId, roomId: cid });
  app.patch({ media: app.state.media ? { ...app.state.media, ctrl: false } : app.state.media });
}

/** 房主处理观众的控制请求：approve 则授权并武装本机注入器（观众随即开通道），否则仅通知拒绝。 */
export function resolveShareControlRequest(memberId: string, approve: boolean, roomId?: string): boolean {
  const rid = roomId ?? roomShareForMember(memberId);
  if (!rid) return false;
  if (approve) {
    let set = ctrlMembers.get(rid);
    if (!set) { set = new Set(); ctrlMembers.set(rid, set); }
    set.add(memberId);
    native.send('media', 'remote_host', { on: 'true' }); // 被控端(房主)armed：观众输入可注入本机系统
  }
  native.send('media', 'share_control_grant', { to: memberId, roomId: rid, approved: approve });
  syncShareControllers(rid, { clearReq: true });
  return true;
}

/** 房主撤销某观众的控制权：通知其退出控制模式，控制者走空则解除本机注入武装。 */
export function revokeShareControl(roomId: string, memberId: string): boolean {
  if (!roomShares.has(roomId)) return false;
  const set = ctrlMembers.get(roomId);
  if (!set || !set.delete(memberId)) return false;
  native.send('media', 'share_control_revoke', { to: memberId, roomId });
  syncShareControllers(roomId, { disarm: true });
  toast(`已撤销 ${app.state.peers.get(memberId)?.name ?? memberId} 的控制权`);
  return true;
}

/** 房主视角：当前正控制本场共享屏的成员列表（非房主或无人控制返回空表）。 */
export function roomShareControllers(roomId: string): string[] {
  return [...(ctrlMembers.get(roomId) ?? [])];
}

/** 控制者集合变化后同步浮层（触发重绘）；opts.disarm 且已无控制者时解除本机注入武装。
 *  仅「回收控制权」的路径才传 disarm，避免拒绝请求等无关操作误关本机注入。 */
function syncShareControllers(roomId: string, opts?: { clearReq?: boolean; disarm?: boolean }) {
  const list = roomShareControllers(roomId);
  const m = app.state.media;
  if (m?.roomShare && m.callId === roomId) {
    app.patch({ media: { ...m, controllers: list, ...(opts?.clearReq ? { ctrlReq: undefined } : {}) } });
  }
  if (opts?.disarm && list.length === 0) native.send('media', 'remote_host', { on: 'false' });
}

/** 远程/共享桌面里，主动建 data channel 用于回传输入（本端是观看者/操控者）。
 *  已有未关闭通道则直接复用（created=false），避免重复授权叠加多条 SCTP 通道。 */
export async function attachRemoteDatachannel(
  callId: string, peerId: string,
): Promise<{ session: PeerSession; created: boolean }> {
  const s = sessions.get(callId) ?? newSession(callId, peerId, 'remote');
  if (s.dc && s.dc.readyState !== 'closed') return { session: s, created: false };
  const dc = s.pc.createDataChannel(s.dcLabel);
  s.attachChannel?.(dc);
  s.dc = dc;
  return { session: s, created: true };
}

/** 操控端(观看者)把输入事件经 data channel 回传被控端（被控端转发给本机 daemon 注入）。 */
export function sendRemoteInput(callId: string, ev: RemoteInput) {
  const s = sessions.get(callId);
  if (!s || !s.dc || s.dc.readyState !== 'open') return; // 通道未就绪先丢弃，待 open 后再响应
  void s.sendInput(ev);
}

/** 发起文件/图片/视频传输到指定对端（单聊直连；群聊由房主中转，见 daemon）。
 *  记录经 message.send 落库并中继给对端；数据面走 P2P data channel，含 SHA256 校验与进度。
 *  发送源(blob+meta)保留在 sendState，中断后可对同一 fileId 断点续传。 */
export async function sendFileTo(
  peerId: string, file: File, kind: 'file' | 'image' | 'video' | 'audio' = 'file', roomId?: string,
): Promise<{ fileId: string; sha256?: string } | { err: string }> {
  const fileId = crypto.randomUUID();
  const sh = await sha256Hex(file).catch(() => undefined);
  // 入本地 file 卡片 + 经 daemon 落库并中继给对端（消息记录里去重/回显）。
  if (!roomId) pushOutgoingFile(peerId, undefined, file, kind, fileId, sh ?? '');

  const callId = crypto.randomUUID();
  let s = sessions.get(callId);
  if (!s) s = newSession(callId, peerId, 'voice');
  const dc = s.pc.createDataChannel(s.dcLabel);
  s.attachChannel?.(dc);
  s.dc = dc;
  void s.pc.createOffer().then(async (o) => {
    await s.pc.setLocalDescription(o);
    native.send('media', 'offer', { callId, to: roomId ?? peerId, sdp: o, fileSignaling: true });
  });
  const meta: FileMeta = { fileId, to: roomId ?? peerId, name: file.name, size: file.size, mime: file.type, sha256: sh };
  native.send('file', 'transfer_begin', meta);
  sendState.set(fileId, { peerId: roomId ?? peerId, isRoom: !!roomId, meta, blob: file, chunk: CHUNK, lastGot: 0 });
  dc.onopen = () => s.sendFile(meta, file);
  sendingByFileId.set(fileId, s);
  return { fileId, sha256: sh };
}

/** 发送源是否仍可续传（源文件本页内保留且传输被中断而非取消/完成）。 */
export function canResumeFile(fileId: string): boolean {
  const st = sendState.get(fileId);
  return !!st && !st.isRoom;
}

/** 静默中断正在发送的文件（模拟断连/被打断）：保留源与已传进度，供断点续传。 */
export function interruptFile(fileId: string): boolean {
  const s = sendingByFileId.get(fileId);
  if (!s) return false;
  s.interrupt();
  sendingByFileId.delete(fileId);
  // 稍后关掉本会话 data channel/底层，使对端 onclose 走失败并保留其已收分片。
  const ssh = s;
  setTimeout(() => ssh.hangup(), 120);
  return true;
}

/** 断点续传：对已中断的 fileId 重开会话，经 fresume 协商对端已收字节，从断点只补发缺失块。 */
export async function resumeFile(fileId: string): Promise<{ ok: boolean; err?: string }> {
  const st = sendState.get(fileId);
  if (!st) return { ok: false, err: '源文件已不可用（取消或完成后不可续传）' };
  if (st.isRoom) return { ok: false, err: '群文件暂不支持续传' };
  const callId = crypto.randomUUID();
  let s = sessions.get(callId) ?? newSession(callId, st.peerId, 'voice');
  const dc = s.pc.createDataChannel(s.dcLabel);
  s.attachChannel?.(dc);
  s.dc = dc;
  void s.pc.createOffer().then(async (o) => {
    await s.pc.setLocalDescription(o);
    native.send('media', 'offer', { callId, to: st.peerId, sdp: o, fileSignaling: true });
  });
  sendingByFileId.set(fileId, s);
  resumeSendProgress(fileId, st.lastGot, st.meta.size); // 卡片回发送中并回填已传进度
  // 数据通道未就绪前不能发 fresume（connecting 状态 send 抛异常致协商 Promise 直接 reject）。
  try {
    await waitDcOpen(dc, 8000);
  } catch {
    return { ok: false, err: '数据通道建立超时，无法续传' };
  }
  s.resumeAndSend(st);
  return { ok: true };
}

/** 等待数据通道进入 open 状态（超时抛错）。 */
function waitDcOpen(dc: RTCDataChannel, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (dc.readyState === 'open') return resolve();
    const done = () => { dc.removeEventListener('open', done); dc.removeEventListener('close', done); resolve(); };
    const to = setTimeout(() => reject(new Error('dc open timeout')), ms);
    dc.addEventListener('open', done);
    dc.addEventListener('close', () => { clearTimeout(to); reject(new Error('channel closed before open')); });
  });
}

/** 端到端调试：暴露发送/接收两端的已收连续字节与恢复起点，供断点续传 e2e 断言。 */
export function transferDebug(): {
  recvGot: Record<string, number>;
  recvBytes: Record<string, number>;
  recvChunks: Record<string, number[]>;
  sndGot: Record<string, number>;
  sndFrom: Record<string, number>;
} {
  const recvGot: Record<string, number> = {};
  const recvBytes: Record<string, number> = {};
  const recvChunks: Record<string, number[]> = {};
  for (const [id, r] of persistRecv) {
    recvGot[id] = r.got;
    recvBytes[id] = r.recvBytes;
    const keys: number[] = [];
    for (let i = 0; i < Math.min(r.chunks.length, 64); i++) if (r.chunks[i]) keys.push(i);
    recvChunks[id] = keys;
  }
  for (const [id, v] of recvDoneRecord) { recvGot[id] = v.got; recvBytes[id] = v.recvBytes; }
  const sndGot: Record<string, number> = {};
  const sndFrom: Record<string, number> = {};
 for (const [id, s] of sendState) { sndGot[id] = s.lastGot; sndFrom[id] = s.resumeFromIndex ?? 0; }
  return { recvGot, recvBytes, recvChunks, sndGot, sndFrom };
}

/** 【临时诊断】接收帧日志 */
export function framesDebug(): string[] {
  return __frameDbg.slice();
}

/** 取消正在发送的文件（由 fileId 定位会话，供文件卡「取消」按钮调用）。 */
export function cancelFileByFileId(fileId: string): boolean {
  const s = sendingByFileId.get(fileId);
  if (!s) return false;
  s.cancel();
  return true;
}

export type { PeerSession };