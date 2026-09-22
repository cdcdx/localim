import { el, append } from './elements';
import { native } from '../client/native_client';
import { startCall, startRoomShare, sendFileTo } from '../client/webrtc';
import { toast } from '../store';

export interface ComposerCtx {
  target: string;
  kind: 'chat' | 'room';
}

/** 输入栏：文字 / 图片视频文件 / 语音 / 语音视频通话 / 共享桌面 / 远程控制。 */
export function renderComposer(ctx: ComposerCtx): Node {
  const input = el('input', { class: 'im-input grow', placeholder: ctx.kind === 'room' ? '发送到群…' : '发送消息…' }) as HTMLInputElement;
  const send = el('button', { class: 'im-btn primary sm' }, '发送');

  const sendText = () => {
    const text = input.value.trim();
    if (!text) return;
    native.send('message', 'send', {
      kind: ctx.kind, type: 'text', to: ctx.target, nonce: crypto.randomUUID(), ts: Date.now(), body: text,
    });
    input.value = '';
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && sendText());
  send.onclick = sendText;

  const fileInput = el('input', { type: 'file', style: { display: 'none' } }) as HTMLInputElement;
  const attach = el('button', { class: 'im-btn ghost sm' }, '文件');
  attach.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const kind = /^image\//.test(f.type) ? 'image' : /^video\//.test(f.type) ? 'video' : 'file';
    sendFileTo(ctx.target, f, kind, ctx.kind === 'room' ? ctx.target : undefined);
  };

  const audioBtn = el('button', { class: 'im-btn ghost sm' }, '语音');
  audioBtn.onclick = () => recordAndSend(ctx, audioBtn);

  const callVoice = el('button', { class: 'im-btn ghost sm' }, '通话');
  callVoice.onclick = () => { if (ctx.kind === 'chat') void startCall(ctx.target, 'voice').catch(() => toast('通话失败')); else inviteRoom(ctx.target, 'voice'); };
  const callVideo = el('button', { class: 'im-btn ghost sm' }, '视频');
  callVideo.onclick = () => { if (ctx.kind === 'chat') void startCall(ctx.target, 'video').catch(() => toast('通话失败')); else toast('群视频为众播模式，后续接入'); };
  const shareBtn = el('button', { class: 'im-btn ghost sm' }, '共享桌面');
  shareBtn.onclick = () => { if (ctx.kind === 'chat') void startCall(ctx.target, 'share').catch(() => toast('共享失败')); else shareToRoom(ctx.target); };
  const remoteBtn = el('button', { class: 'im-btn ghost sm' }, '远程');
  remoteBtn.onclick = () => { if (ctx.kind === 'chat') void startCall(ctx.target, 'remote').catch(() => toast('远程连接失败')); };

  const bar = el('div', { class: 'composer' });
  append(bar, attach, audioBtn, callVoice, callVideo, shareBtn, remoteBtn, input, send);
  return bar;
}

function inviteRoom(roomId: string, mode: string) {
  native.send('room', 'invite', { roomId, mediaMode: mode });
  toast('已向群成员发送通话邀请');
}
function shareToRoom(roomId: string) {
  void startRoomShare(roomId).catch(() => toast('群共享启动失败'));
}

function recordAndSend(ctx: ComposerCtx, btn: HTMLElement) {
  const original = btn.textContent;
  void navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      btn.textContent = '录音中…点击结束';
      const rec = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
        sendFileTo(ctx.target, file, 'audio', ctx.kind === 'room' ? ctx.target : undefined);
        toast('语音已发送');
        btn.textContent = original!;
      };
      btn.onclick = () => rec.stop();
      rec.start();
    })
    .catch(() => toast('无法访问麦克风'));
}