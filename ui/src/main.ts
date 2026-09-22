import { app } from './store';
import { initNativeHooks, native } from './client/native_client';
import { initWebrtc, sendFileTo, startCall, startRoomShare, endRoomShare, endRoomShareViewer, requestRoomShareStop, requestShareControl, resolveRoomShareStopRequest, resolveShareControlRequest, revokeShareControl, disableShareControl, roomShareViewers, roomShareControllers, acceptIncomingCall, mediaDebug, hangupDebug, debugPcs, cancelFileByFileId, sessionStreams, sendRemoteInput, roomShareViewerCount, interruptFile, resumeFile, canResumeFile, transferDebug, framesDebug } from './client/webrtc';
import { login } from './views/login';
import { renderRoster } from './views/roster';
import { renderChat } from './views/chat';
import { renderMedia } from './views/media';
import { el } from './views/elements';
import './app.css';

// 启动管道
initNativeHooks();
initWebrtc();

const root = document.getElementById('app')!;

function render() {
  // 顶层只建一次外壳；内部订阅见各 render 函数返回的 redraw。
  root.replaceChildren(buildShell());
  if (app.state.toast) document.body.appendChild(toastNode(app.state.toast));
}

function buildShell(): Node {
  const box = el('div', { class: 'app-layout' }) as HTMLElement;
  const redraws: Array<() => void> = [];
  redraws.push(renderRoster(box));
  redraws.push(renderChat(box));
  redraws.push(renderMedia(box));
  // 单次订阅：任何状态变化触发所有面板重画。
  const off = app.on(() => {
    if (!document.body.contains(box)) { off(); return; }
    for (const r of redraws) r();
  });
  return box;
}

function toastNode(text: string): Node {
  const node = el('div', { class: 'toast' }, text);
  setTimeout(() => node.remove(), 3200);
  return node;
}

render();

// 连接 daemon；失败会持续重连，dev 模式下 UI 先以回显展示。
native.connect();

// 供 dev 回显/调试 + 端到端脚本注入（login/sendFileTo/startCall/startRoomShare 供 CDP 驱动调用）
(globalThis as any).__localim = { app, native, login, sendFileTo, startCall, startRoomShare, endRoomShare, endRoomShareViewer, requestRoomShareStop, requestShareControl, resolveRoomShareStopRequest, resolveShareControlRequest, revokeShareControl, disableShareControl, roomShareViewers, roomShareControllers, acceptIncomingCall, mediaDebug, hangupDebug, debugPcs, cancelFileByFileId, sessionStreams, sendRemoteInput, roomShareViewerCount, interruptFile, resumeFile, canResumeFile, transferDebug, framesDebug };