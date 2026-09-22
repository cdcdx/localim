// 轻量 DOM 构造辅助。
export type Child = Node | string | null | undefined | Element | number;

export function el(
  tag: keyof HTMLElementTagNameMap,
  attrs?: Record<string, unknown> | null,
  ...children: Child[]
): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'style' && v && typeof v === 'object') Object.assign(node.style, v as CSSStyleDeclaration);
      else if (k.startsWith('on') && typeof v === 'function') (node as any)[k] = v;
      else if (k === 'dataset') Object.assign(node.dataset, v as Record<string, string>);
      else node.setAttribute(k, String(v));
    }
  }
  append(node, ...children);
  return node;
}

export function append(target: Node, ...children: Child[]) {
  for (const c of children) {
    if (c == null) continue;
    target.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function mount(root: HTMLElement, node: Node) {
  root.replaceChildren(node);
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}