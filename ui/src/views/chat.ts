import { el, append, fmtTime, fmtSize } from './elements';
import { app, ChatItem } from '../store';
import { MediaRef } from '../types';
import { cancelFileByFileId, canResumeFile, resumeFile } from '../client/webrtc';
import { renderComposer } from './composer';

/** 主面板：标题栏 + 消息流 + 输入栏。 */
export function renderChat(box: HTMLElement) {
  box.appendChild(el('main', { class: 'chat' }));
  return () => {
    const main = box.querySelector('main.chat')!;
    const r = app.state.route;
    main.replaceChildren();
    if (r.view !== 'chat') {
      main.appendChild(el('div', { class: 'empty' },
        el('h2', {}, app.state.profile ? '选择左侧设备或群开始聊天' : ''), 
        el('p', { class: 'muted' }, app.state.profile ? '支持文字 · 图片 · 视频 · 文件 · 语音 · 群聊 · 共享桌面 · 远程控制' : '请先在左下角设置昵称上线')));
      return;
    }
    const title = titleOf(r.target, r.kind);
    const header = el('div', { class: 'chat-head' }, el('span', { class: 'chat-title' }, title));
    const stream = el('div', { class: 'stream' });
    fillStream(stream, r.target, r.kind);

    const composer = renderComposer({ target: r.target, kind: r.kind });
    append(main, header, stream, composer);
  };
}

function titleOf(target: string, kind: 'chat' | 'room'): string {
  if (kind === 'room') {
    const r = app.state.rooms.get(target);
    return `群：${r?.name ?? target}（${r?.members.length ?? 0}人）`;
  }
  const p = app.state.peers.get(target);
  return p ? `${p.name} · ${p.host}` : target;
}

function fillStream(stream: HTMLElement, target: string, kind: 'chat' | 'room') {
  const items = app.state.conversations.get(target) ?? [];
  const self = app.state.profile?.deviceId;
  if (items.length === 0) {
    stream.appendChild(el('div', { class: 'muted center' }, '这里还没有消息，打个招呼吧'));
    return;
  }
  for (const it of items) renderItem(stream, it, kind, self);
  requestAnimationFrame(() => stream.scrollTop = stream.scrollHeight);
}

/** 发送态标签：送达回执后显示已送达；其余按发送状态反馈。 */
function deliveryLabel(status?: ChatItem['status']): string {
  if (status === 'delivered') return '已送达';
  if (status === 'failed') return '未送达';
  if (status === 'sending') return '发送中';
  return '';
}

function renderItem(stream: HTMLElement, it: ChatItem, _kind: 'chat' | 'room', self?: string) {
  const mine = it.from === self;
  const row = el('div', { class: `msg ${mine ? 'mine' : 'theirs'}` });
  const bubble = el('div', { class: 'bubble' });
  const meta = el('div', { class: 'msg-meta' },
    mine ? '' : el('span', { class: 'from' }, peerName(it.from)),
    el('span', { class: 'time' }, fmtTime(it.ts)),
    mine ? el('span', { class: 'status' }, deliveryLabel(it.status)) : '');
  if (it.type === 'text' || it.type === 'emoji' || it.type === 'system') {
    bubble.appendChild(el('div', { class: 'text' }, it.body));
  } else if (it.mediaRef) {
    const m = it.mediaRef;
    const hasUrl = !!m.url;
    if (it.type === 'image' && hasUrl) {
      bubble.appendChild(el('img', { class: 'media img', src: m.thumbUrl ?? m.url ?? '', alt: m.name }));
    } else if (hasUrl && (it.type === 'video' || it.type === 'audio')) {
      bubble.appendChild(el(it.type === 'video' ? 'video' : 'audio', { class: 'media', src: m.url, controls: true }));
    } else {
      bubble.appendChild(renderFileCard(m, it));
    }
  }
  append(row, meta, bubble);
  stream.appendChild(row);
}

/** 文件卡片：传输中显进度条+取消，结果态显下载/校验徽标，异常显失败/取消。 */
function renderFileCard(m: MediaRef, it: ChatItem): HTMLElement {
  const x = it.xfer;
  const card = el('div', { class: 'file-card' });
  append(card,
    el('div', { class: 'file-name' }, m.name),
    el('div', { class: 'file-size' }, fmtSize(m.size)));

  if (x) {
    if (x.phase === 'sending' || x.phase === 'receiving') {
      const pct = x.total ? Math.min(100, Math.round((x.got / x.total) * 100)) : 0;
      const track = () => el('div', { class: 'xfer-track' }, el('div', { class: 'xfer-fill', style: { width: `${pct}%` } }));
      append(card,
        el('div', { class: 'xfer-row' },
          el('span', { class: 'xfer-label' }, x.phase === 'sending' ? `发送中 ${pct}%` : `接收中 ${pct}%`),
          x.phase === 'sending' && m.fileId
            ? el('button', { class: 'im-btn ghost xs xfer-cancel', onclick: () => { cancelFileByFileId(m.fileId!); } }, '取消')
            : null),
        track());
    } else if (x.phase === 'done') {
      append(card, el('div', { class: 'xfer-row' },
        m.url ? el('a', { class: 'file-dl', href: m.url, download: m.name }, '下载') : null,
        typeof m.sha256Ok === 'boolean'
          ? el('span', { class: m.sha256Ok ? 'sha-ok' : 'sha-bad', title: m.sha256 ? `SHA256 ${m.sha256.slice(0, 16)}…` : '' },
              m.sha256Ok ? '✓ 校验通过' : '✗ 校验失败')
          : (m.sha256 ? el('span', { class: 'muted' }, '未校验') : null)));
    } else if (x.phase === 'failed') {
      // 传输中断：发送端若源仍可用可一键断点续传（只补传缺失部分）。
      const resumable = it.from === app.state.profile?.deviceId && !!m.fileId && canResumeFile(m.fileId);
      append(card, el('div', { class: 'xfer-row fail' },
        el('span', { class: 'fail' }, '传输中断'),
        resumable ? el('button', { class: 'im-btn ghost xs xfer-cancel', onclick: () => void resumeFile(m.fileId!) }, '续传') : null,
        m.url ? el('a', { class: 'file-dl', href: m.url, download: m.name }, '下载') : null));
    } else if (x.phase === 'canceled') {
      append(card, el('div', { class: 'xfer-row muted' }, '已取消'));
    }
  } else if (m.url) {
    append(card, el('a', { class: 'file-dl', href: m.url, download: m.name }, '下载'));
  }
  return card;
}

function peerName(id: string): string {
  if (id === app.state.profile?.deviceId) return '我';
  return app.state.peers.get(id)?.name ?? id;
}