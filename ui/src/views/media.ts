import { el, append } from './elements';
import { app, toast } from '../store';
import type { MediaSessionUi } from '../store';
import { native } from '../client/native_client';
import { acceptIncomingCall, endRoomShare, endRoomShareViewer, onStreamsChange, requestRoomShareStop, resolveRoomShareStopRequest, roomShareViewers, sendRemoteInput, sessionStreams, startCall } from '../client/webrtc';

// 直播态订阅句柄：重画/结束通话时先解绑，避免旧元素泄漏订阅。
let liveCleanup: (() => void) | null = null;

/** 通话/共享浮层：来电接听、直播音视频、远程控制输入面板。 */
export function renderMedia(box: HTMLElement) {
  box.appendChild(el('div', { class: 'call-wrap' }));
  return () => {
    const wrap = box.querySelector('.call-wrap')!;
    wrap.replaceChildren();
    liveCleanup?.();
    liveCleanup = null;
    const m = app.state.media;
    if (!m) return;

    if (m.direction === 'incoming' && m.state === 'ringing') {
      const card = el('div', { class: 'call-card' },
        el('div', { class: 'call-title' }, `${m.peer.name} 邀请你${mode(m.peer.mode)}`),
        el('div', { class: 'call-actions' },
          el('button', { class: 'im-btn danger', onclick: () => { native.send('media', 'call_reject', { callId: m.callId }); app.patch({ media: null }); } }, '拒绝'),
          el('button', { class: 'im-btn primary', onclick: () => {
            native.send('media', 'call_accept', { callId: m.callId, to: m.peer.deviceId });
            app.patch({ media: { ...m, direction: 'outgoing', state: 'connecting' } });
            void acceptIncomingCall(m.callId, m.peer.mode as 'voice' | 'video', m.peer.deviceId)
              .catch(() => toast('接听失败'));
          } }, '接听'),
        ));
      wrap.appendChild(overlay(card));
      return;
    }

    // 通话中 / 直播
    const callId = m.callId;
    const card = el('div', { class: `call-card live ${m.peer.mode}` });
    const title = el('div', { class: 'call-title' },
      m.roomShare ? `${m.peer.name}` : `${m.peer.name} · ${mode(m.peer.mode)}`);
    // 群共享房主：结束关闭整场共享；其余单会话挂断。
    const end = () => {
      if (m.roomShare) endRoomShare(callId);
      else { native.send('media', 'call_hangup', { callId }); app.patch({ media: null }); }
    };
    const actions = el('div', { class: 'call-actions' },
      el('button', { class: 'im-btn danger', onclick: end }, '结束'));
    // 观众视角的群共享：可向房主请求结束共享；房主有最终停止权。
    if (!m.roomShare && m.peer.mode === 'share') {
      actions.appendChild(el('button', {
        class: 'im-btn ghost xs',
        onclick: () => { requestRoomShareStop(callId); },
      }, '请求结束共享'));
    }

    // 语音：无视频，隐藏视频区，用状态指示占位。
    if (m.peer.mode === 'voice') {
      append(card, title, el('div', { class: 'audio-indicator' },
        el('span', { class: 'pulse-dot' }), el('span', {}, '通话中（语音）')), actions);
      wrap.appendChild(overlay(card));
      return;
    }

    // 视频/共享/远程：主画面(远端优先，共享/远程无人共享时回退本地预览) + 本地 PiP 小窗。
    const main = el('video', { class: 'vid main', autoplay: true, playsinline: true, tabindex: '0' }) as HTMLVideoElement;
    const pip = el('video', { class: 'vid local', autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement;
    const vids = el('div', { class: `vids ${m.peer.mode === 'video' ? 'video' : 'share'}` });
    append(vids, main, pip);
    const apply = () => {
      const { local: ls, remote: rs } = sessionStreams(callId);
      const isShare = m.peer.mode === 'share' || m.peer.mode === 'remote';
      const showMain = rs ?? (isShare ? ls : null);
      const showPip = rs && ls ? ls : null;
      bind(main, showMain);
      bind(pip, showPip);
      main.hidden = !showMain;
      pip.hidden = !showPip;
      // 对方未发画面时给主画面一个占位提示。
      card.classList.toggle('no-stream', !showMain);
    };
    apply();
    liveCleanup = onStreamsChange(apply);

    append(card, title, vids, actions);
    // 房主视角的群共享控制条：观众列表可逐个踢出；待办请求可同意/忽略。
    if (m.roomShare) renderRoomShareBar(card, callId, m);
    if (m.peer.mode === 'remote') renderRemotePanel(card, main);
    wrap.appendChild(overlay(card));
  };
}

/** 把流绑定/解绑到 video 元素；无变化时不触碰，避免画面闪断。 */
function bind(v: HTMLVideoElement, stream: MediaStream | undefined | null) {
  if (v.srcObject === (stream ?? null)) return;
  v.srcObject = stream ?? null;
}

/**
 * 房主视角的群共享控制条：显示观众数与成员列表（可逐个踢出），并处理观众发来的停止请求。
 * 谁可停共享：房主有最终停止权（结束按钮）；观众仅能请求，是否停止由房主决定。
 */
function renderRoomShareBar(card: HTMLElement, roomId: string, m: MediaSessionUi) {
  const bar = el('div', { class: 'share-bar' });
  const viewers = roomShareViewers(roomId);
  append(bar, el('div', { class: 'share-bar-head' },
    el('span', {}, `观众 ${viewers.length} 人`),
    el('span', { class: 'muted xs' }, '房主可结束或逐个踢出')));
  const list = el('div', { class: 'share-members' });
  for (const id of viewers) {
    append(list, el('div', { class: 'share-member' },
      el('span', {}, app.state.peers.get(id)?.name ?? id),
      el('button', { class: 'im-btn ghost xs xfer-cancel', onclick: () => void endRoomShareViewer(roomId, id) }, '踢出')));
  }
  if (list.childNodes.length) bar.appendChild(list);
  else append(bar, el('div', { class: 'muted xs' }, '暂无在线观众'));
  if (m.shareReq) {
    append(bar, el('div', { class: 'share-req' },
      el('span', {}, `${m.shareReq.name} 请求结束共享`),
      el('button', { class: 'im-btn xs', onclick: () => { resolveRoomShareStopRequest(roomId, m.shareReq!.from, true); } }, '同意停止'),
      el('button', { class: 'im-btn ghost xs xfer-cancel', onclick: () => { resolveRoomShareStopRequest(roomId, m.shareReq!.from, false); } }, '忽略')));
  }
  card.appendChild(bar);
}

/**
 * 远程控制面板：把鼠标/键盘/滚轮事件经 data channel 回传被控端 daemon 注入。
 * 坐标按主视频显示尺寸与源分辨率比例换算回被控端屏幕像素（缩放画面下点哪儿指哪儿）。
 */
function renderRemotePanel(card: HTMLElement, main: HTMLVideoElement) {
  card.appendChild(el('div', { class: 'remote-bar' },
    el('span', {}, '🖱 远程控制中'), el('span', { class: 'muted xs' }, '点击/拖动/键盘操作被控端屏幕')));

  const scale = () => (main.videoWidth && main.clientWidth ? main.videoWidth / main.clientWidth : 1);
  const pt = (e: { offsetX: number; offsetY: number }) => ({ x: Math.round(e.offsetX * scale()), y: Math.round(e.offsetY * scale()) });

  main.onpointermove = (e) => sendRemoteInput(callIdOf(main), { t: 'mousemove', ...pt(e) });
  main.onpointerdown = (e) => {
    main.focus();
    sendRemoteInput(callIdOf(main), { t: 'mousedown', ...pt(e), btn: e.button });
  };
  main.onpointerup = (e) => sendRemoteInput(callIdOf(main), { t: 'mouseup', ...pt(e), btn: e.button });
  main.onwheel = (e) => sendRemoteInput(callIdOf(main), { t: 'wheel', ...pt(e), d: Math.sign(e.deltaY) * 120 });
  main.onkeydown = (e) => {
    if (e.isComposing) return;
    sendRemoteInput(callIdOf(main), { t: 'keydown', code: e.code });
    if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };
  main.onkeyup = (e) => sendRemoteInput(callIdOf(main), { t: 'keyup', code: e.code });

  function callIdOf(v: HTMLVideoElement) {
    // callId 从当前媒体态取出（渲染时唯一）
    return app.state.media?.callId ?? '';
  }
}

function overlay(inner: Node): Node {
  return el('div', { class: 'overlay' }, inner);
}
function mode(m: string) {
  return ({ voice: '语音通话', video: '视频通话', share: '共享桌面', remote: '远程控制' } as Record<string, string>)[m] ?? m;
}