// 极简响应式状态库 —— 不引入框架，靠订阅 + 可变引用触发重渲染。
export type Listener = () => void;

import type { ChatMessage } from './types';

export interface ChatItem extends ChatMessage {
  localSeq: number;
  status?: 'sending' | 'sent' | 'delivered' | 'failed';
  /** 文件传输阶段/进度（仅文件消息在传输期间与结果态时存在）。 */
  xfer?: import('./types').XferState;
}

export interface MediaSessionUi {
  callId: string;
  peer: { deviceId: string; name: string; mode: string };
  direction: 'incoming' | 'outgoing';
  state: 'ringing' | 'connecting' | 'live' | 'ended';
  rtc?: RTCSessionDescriptionInit | null;
  /** 群共享浮层（房主视角，callId 即 roomId）：结束按钮走 endRoomShare 而非单会话挂断。 */
  roomShare?: boolean;
  /** 群共享：有观众请求停止时的待办（房主视角，name=请求成员显示名）。 */
  shareReq?: { from: string; name: string };
}

export interface AppState {
  connected: boolean;
  profile: import('./types').Profile | null;
  peers: Map<string, import('./types').PeerInfo>;
  route: { view: 'roster' } | { view: 'chat'; target: string; kind: 'chat' | 'room' };
  conversations: Map<string, ChatItem[]>; // key=target(deviceId|roomId)
  rooms: Map<string, import('./types').RoomInfo>;
  media: MediaSessionUi | null;
  toast: string | null;
}

export const initial: AppState = {
  connected: false,
  profile: null,
  peers: new Map(),
  route: { view: 'roster' },
  conversations: new Map(),
  rooms: new Map(),
  media: null,
  toast: null,
};

export class Store<A> {
  state: A;
  private listeners = new Set<Listener>();
  constructor(initial: A) {
    this.state = initial;
  }
  /** 变更后调用；渲染层据此重挂。 */
  emit() {
    for (const l of this.listeners) l();
  }
  patch(p: Partial<A>) {
    this.state = { ...this.state, ...p } as A;
    this.emit();
  }
  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const app = new Store<AppState>(initial);

export function toast(msg: string) {
  app.patch({ toast: msg });
  setTimeout(() => app.patch({ toast: null }), 3200);
}