import { el, append } from './elements';
import { app, toast } from '../store';
import { native } from '../client/native_client';
import { HelloPayload, Profile } from '../types';

let _nameInput: HTMLInputElement | null = null;

/** 侧边栏顶部的个人栏：未登录=昵称表单；已登录=自己的名牌。 */
export function renderProfileBar(): Node {
  const box = el('div', { class: 'profile-bar' });
  const p = app.state.profile;
  if (!p) {
    const input = (_nameInput = el('input', {
      class: 'im-input',
      placeholder: '局域网昵称',
      value: localStorage.getItem('localim.last.name') ?? '',
    }) as HTMLInputElement);
    const go = el('button', { class: 'im-btn primary xs' }, '进入');
    go.onclick = () => login(input.value);
    append(box, input, go);
    return box;
  }
  const badge = el('span', { class: 'conn', dataset: { on: String(app.state.connected) } }, app.state.connected ? '在线' : '离线');
  const name = el('span', { class: 'self-name' }, p.name);
  const edit = el('button', { class: 'link-btn' }, '改');
  edit.onclick = () => {
    const v = prompt('新昵称', p.name);
    if (v && v.trim()) {
      app.patch({ profile: { ...p, name: v.trim() } });
      localStorage.setItem('localim.profile', JSON.stringify({ ...p, name: v.trim() }));
      native.send('identity', 'set_profile', { name: v.trim() });
    }
  };
  append(box, badge, name, edit);
  return box;
}

export function login(raw: string) {
  const name = raw.trim();
  if (!name) return toast('请填写昵称');
  localStorage.setItem('localim.last.name', name);
  const id = localStorage.getItem('localim.id') || crypto.randomUUID();
  localStorage.setItem('localim.id', id);
  const profile: Profile = { deviceId: id, name, joinedRooms: [] };
  localStorage.setItem('localim.profile', JSON.stringify(profile));
  app.patch({ profile });
  const hello: HelloPayload = {
    deviceId: id,
    name,
    platform: (navigator.userAgent.includes('Linux') ? 'linux' : navigator.userAgent.includes('Mac') ? 'mac' : 'win') as 'win' | 'mac' | 'linux',
    version: '0.1.0',
  };
  native.send('identity', 'hello', hello);
  native.send('discovery', 'scan_start', { requireCross: true });
  native.loadRoster();
  toast('已上线，正在扫描局域网设备…');
}