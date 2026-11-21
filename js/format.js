// Formatação de números e textos para a interface (pt-BR)

const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf4 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const nfInt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nfCompact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 2 });

export function usd(value, { sign = false } = {}) {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const txt = abs >= 1000 ? nfInt.format(abs) : nf2.format(abs);
  const prefix = value < 0 ? '−' : sign && value > 0 ? '+' : '';
  return `${prefix}$${txt}`;
}

export function price(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1000) return `$${nfInt.format(value)}`;
  if (value >= 1) return `$${nf2.format(value)}`;
  return `$${nf4.format(value)}`;
}

export function pct(value, digits = 3) {
  if (value == null || !Number.isFinite(value)) return '—';
  const s = value.toFixed(digits).replace('.', ',');
  return `${value > 0 ? '+' : ''}${s}%`;
}

export function int(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return nfInt.format(Number(value));
}

export function compact(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return nfCompact.format(value);
}

export function num(value, digits = 4) {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits }).format(value);
}

export function shortAddr(addr) {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function clock(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour12: false });
}

export function duration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}h ${m}min` : m ? `${m}min ${r}s` : `${r}s`;
}

/** Cria um elemento com atributos e filhos (sem innerHTML com dados externos). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
