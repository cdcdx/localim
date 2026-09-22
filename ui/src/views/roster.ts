import { el, append } from './elements';
import { app, toast } from '../store';
import { native } from '../client/native_client';
import { renderProfileBar } from './login';

/** 侧边栏：在线设备列表 + 自建群列表 + 建群入口。 */
export function renderRoster(box: HTMLElement) {
  box.appendChild(el('aside', { class: 'sidebar' }));
  return () => {
    const aside = box.querySelector('aside')!;
    aside.replaceChildren();
    aside.appendChild(renderProfileBar());

    const section = (title: string, node: Node) => {
      const s = el('div', { class: 'nav-section' });
      append(s, el('div', { class: 'nav-title' }, title), node);
      return s;
    };

    // —— 设备 ——
    const peers = [...app.state.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
    const peerList = el('div', { class: 'nav-list' });
    for (const p of peers) {
      const item = el('div', {
        class: 'nav-item',
        dataset: { id: p.deviceId },
        onclick: () => { native.loadHistory(p.deviceId, 'chat'); app.patch({ route: { view: 'chat', target: p.deviceId, kind: 'chat' } }); },
      });
      const dot = el('span', { class: 'dot', dataset: { via: p.via } },
        p.via === 'relay' ? '中继' : '');
      const nm = el('span', { class: 'item-name' }, p.name);
      const meta = el('span', { class: 'item-meta' }, p.host);
      append(item, dot, nm, meta);
      peerList.appendChild(item);
    }
    if (peers.length === 0) peerList.appendChild(el('div', { class: 'muted xs' }, '未发现设备（正在扫描…）'));

    // —— 群 ——
    const roomList = el('div', { class: 'nav-list' });
    for (const r of app.state.rooms.values()) {
      roomList.appendChild(el('div', {
        class: 'nav-item',
        onclick: () => { native.loadHistory(r.roomId, 'room'); app.patch({ route: { view: 'chat', target: r.roomId, kind: 'room' } }); },
      }, el('span', { class: 'group-mark' }, '群'), el('span', { class: 'item-name' }, ` ${r.name}`), el('span', { class: 'item-meta' }, `${r.members.length}人`)));
    }
    const createRoom = el('button', { class: 'im-btn ghost xs' }, '+ 建群');
    createRoom.onclick = () => {
      const name = prompt('群名称');
      if (name && name.trim()) native.request('room', 'create', { name: name.trim() }).catch(() => toast('建群失败'));
    };

    aside.appendChild(section('设备', peerList));
    aside.appendChild(section('群组', roomList));
    aside.appendChild(el('div', { class: 'nav-foot' }, createRoom));
  };
}