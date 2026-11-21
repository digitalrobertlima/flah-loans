// ════════════════════════════════════════════════════════════════════════════
//  FLASH//ARB — interface (thread principal)
//  O scanner roda num Web Worker (js/worker.js). Aqui ficam a tela, a carteira
//  (Rabby/MetaMask) para execução manual e a comunicação com o worker.
// ════════════════════════════════════════════════════════════════════════════

import * as C from './js/config.js';
import * as F from './js/format.js';
import { loadEthers, ETHERS_VERSION } from './js/eth.js';
import { discoverWallets, connectWallet } from './js/wallet.js';
import { executeArb } from './js/engine.js';

const $ = (sel) => document.querySelector(sel);
const { el } = F;

// ─── Estado ─────────────────────────────────────────────────────────────────

const state = {
  settings: loadSettings(),
  ready: false,
  running: false,
  auto: false,
  board: [],
  lastScan: null,
  stats: null,
  paper: { totalUsd: 0, count: 0, hits: [] },
  contract: null,
  burner: null,
  wallet: null,
  walletOptions: [],
  E: null,
  logs: [],
  logFilter: 'all',
  spark: [],
  txs: [],
  flashed: new Set(),
  wakeLock: null,
};

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(C.STORAGE_KEYS.settings) || '{}');
  } catch (_) {
    saved = {};
  }
  const s = { ...C.DEFAULT_SETTINGS, ...saved, extraPairs: [] };
  const validPairs = new Set(C.PAIRS.map((p) => p.id));
  const validDex = new Set(C.DEXES.map((d) => d.id));
  s.pairIds = (Array.isArray(s.pairIds) ? s.pairIds : C.DEFAULT_SETTINGS.pairIds).filter((id) => validPairs.has(id));
  s.dexIds = (Array.isArray(s.dexIds) ? s.dexIds : C.DEFAULT_SETTINGS.dexIds).filter((id) => validDex.has(id));
  if (!Array.isArray(s.rpcUrls) || !s.rpcUrls.length) s.rpcUrls = C.DEFAULT_RPCS;
  return s;
}

function saveSettings() {
  const { extraPairs, ...rest } = state.settings;
  try {
    localStorage.setItem(C.STORAGE_KEYS.settings, JSON.stringify(rest));
  } catch (_) {
    /* modo privado */
  }
}

function updateSettings(partial) {
  state.settings = { ...state.settings, ...partial };
  saveSettings();
  if (state.ready) send('settings', partial).catch(() => {});
}

// ─── Worker ─────────────────────────────────────────────────────────────────

const worker = new Worker(new URL('./js/worker.js', import.meta.url), { type: 'module' });
let msgSeq = 0;
const pending = new Map();

function send(type, data) {
  return new Promise((resolve, reject) => {
    const id = ++msgSeq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, data, id });
  });
}

worker.onerror = (ev) => {
  addLog({ level: 'error', msg: `O worker do scanner falhou: ${ev.message || 'erro'} — seu navegador precisa suportar "module workers" (Chrome, Edge, Brave, Firefox e Safari atuais).`, time: Date.now() });
};

const handlers = {
  'worker-ready': () => {
    send('init', { settings: state.settings }).catch(() => {
      addLog({ level: 'error', msg: 'Não foi possível iniciar o motor. Verifique a internet e recarregue a página.', time: Date.now() });
    });
  },
  ready: async (d) => {
    state.ready = true;
    $('#btnScan').disabled = false;
    renderRpc(d);
    const saved = localStorage.getItem(C.STORAGE_KEYS.contract);
    if (saved) {
      $('#contractAddr').value = saved;
      await send('contract', { address: saved }).catch(() => {});
    }
    const key = sessionStorage.getItem(C.STORAGE_KEYS.burner);
    if (key) {
      $('#rememberBurner').checked = true;
      await send('burner', { privateKey: key }).catch(() => {});
    }
  },
  log: (d) => addLog(d),
  rpc: (d) => renderRpc(d),
  scan: (d) => renderScan(d),
  state: (d) => renderRunState(d),
  contract: (d) => renderContract(d),
  burner: (d) => renderBurner(d),
  auto: (d) => renderAuto(d.enabled),
  tx: (d) => addTx(d),
  stats: (d) => renderStats(d),
  ack: (d) => {
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok) p.resolve();
    else p.reject(new Error(d.error));
  },
};

worker.onmessage = (ev) => {
  const { type, data } = ev.data || {};
  const fn = handlers[type];
  if (fn) fn(data);
};

// ─── Logs ───────────────────────────────────────────────────────────────────

const LOG_MAX = 500;
const LEVEL_TAG = { info: 'INFO', ok: 'OK', warn: 'AVISO', error: 'ERRO', tx: 'TX', scan: 'BLOCO' };

function logVisible(entry) {
  if (entry.level === 'scan' && !$('#logScan').checked) return false;
  switch (state.logFilter) {
    case 'ok':
      return entry.level === 'ok';
    case 'tx':
      return entry.level === 'tx' || /transa|lucro/i.test(entry.msg);
    case 'error':
      return entry.level === 'error' || entry.level === 'warn';
    default:
      return true;
  }
}

function logNode(entry) {
  return el(
    'div',
    { class: `log-line ${entry.level}` },
    el('time', {}, F.clock(entry.time)),
    el('span', { class: 'lvl' }, LEVEL_TAG[entry.level] || entry.level.toUpperCase()),
    el('span', {}, entry.msg, entry.link ? el('a', { href: entry.link, target: '_blank', rel: 'noopener noreferrer' }, 'PolygonScan ↗') : null),
  );
}

function addLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > LOG_MAX) state.logs.splice(0, state.logs.length - LOG_MAX);
  if (!logVisible(entry)) return;
  const box = $('#log');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(logNode(entry));
  while (box.childElementCount > LOG_MAX) box.firstElementChild.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function rerenderLogs() {
  const box = $('#log');
  box.replaceChildren(...state.logs.filter(logVisible).map(logNode));
  box.scrollTop = box.scrollHeight;
}

const uiLog = (level, msg, extra = {}) => addLog({ level, msg, time: Date.now(), ...extra });

// ─── Renderização ───────────────────────────────────────────────────────────

function setChip(id, text, cls) {
  const chip = $(id);
  chip.querySelector('span:last-child').textContent = text;
  if (cls !== undefined) {
    chip.classList.remove('ok', 'bad');
    if (cls) chip.classList.add(cls);
  }
}

function renderRpc(d) {
  if (!d) return;
  const nodes = d.nodes || d.rpc || [];
  const current = d.current;
  const host = current ? new URL(current).host : '—';
  const alive = nodes.filter((n) => n.ok).length;
  setChip('#chipRpc', `${host}`, alive ? 'ok' : 'bad');
  $('#rpcAlive').textContent = nodes.length ? `${alive}/${nodes.length} online` : '';
  const list = $('#rpcList');
  list.replaceChildren(
    ...nodes.map((n) =>
      el(
        'li',
        { class: `${n.ok ? 'ok' : ''} ${n.url === current ? 'current' : ''}`, title: n.lastError || '' },
        el('span', { class: 'dot' }),
        el('span', {}, new URL(n.url).host),
        el('span', {}, n.ok && n.latency != null ? `${n.latency} ms` : n.ok ? 'ok' : 'off'),
      ),
    ),
  );
}

function renderRunState(d) {
  state.running = !!d.running;
  const btn = $('#btnScan');
  btn.classList.toggle('running', state.running);
  btn.querySelector('.btn-icon').textContent = state.running ? '■' : '▶';
  btn.querySelector('.btn-label').textContent = state.running ? 'Parar scanner' : 'Iniciar scanner';
  renderMode();
}

function renderMode() {
  const chip = $('#chipMode');
  chip.classList.toggle('auto', state.auto);
  chip.classList.toggle('live', state.running && !state.auto);
  setChip('#chipMode', state.auto ? 'AUTO-EXECUTE' : state.running ? 'scanner ativo' : 'observação');
}

function renderScan(s) {
  state.lastScan = s;
  state.board = s.board || [];
  state.paper = s.paper || state.paper;

  setChip('#chipBlock', F.int(s.block));
  setChip('#chipGas', `${s.gasPriceGwei.toFixed(0)} gwei`);
  setChip('#chipFee', `${(s.premiumBps / 100).toFixed(2).replace('.', ',')}%${s.premiumFromChain ? '' : '?'}`);
  if (s.rpc) setChip('#chipRpc', new URL(s.rpc).host, 'ok');

  $('#pxPOL').textContent = F.price(s.prices.WPOL);
  $('#pxETH').textContent = F.price(s.prices.WETH);
  $('#pxBTC').textContent = F.price(s.prices.WBTC);
  $('#pxLINK').textContent = F.price(s.prices.LINK);
  $('#pxAAVE').textContent = F.price(s.prices.AAVE);
  $('#scanMs').textContent = `${s.durationMs} ms`;
  $('#scanQuotes').textContent = F.int(s.quotes);
  const per = Math.max(1, state.settings.pairsPerScan || 1);
  const cycle = Math.ceil(state.settings.pairIds.length / per);
  $('#scanCycle').textContent = `${state.settings.pairIds.length} pares / ${cycle} bloco${cycle > 1 ? 's' : ''}`;

  const bestThis = state.board.find((o) => o.block === s.block);
  if (bestThis) {
    state.spark.push(bestThis.netUsd);
    if (state.spark.length > 150) state.spark.shift();
  }

  renderBoard();
  renderAave(s.aave);
  renderPaper(bestThis);
  renderStats(s.stats);
  drawSpark();
}

function renderBoard() {
  const tbody = $('#oppBody');
  const curBlock = state.lastScan ? state.lastScan.block : 0;
  let rows = state.board;
  if ($('#onlyPositive').checked) rows = rows.filter((o) => o.netUsd > 0);
  const positives = state.board.filter((o) => o.netUsd > 0).length;
  const greens = state.board.filter((o) => o.executable).length;
  $('#boardInfo').textContent = `${state.board.length} rotas · ${positives} positivas · ${greens} acima do mínimo`;

  if (!rows.length) {
    tbody.replaceChildren(
      el('tr', {}, el('td', { colspan: '9', class: 'empty' }, state.board.length ? 'Nenhuma rota positiva agora — normal: os robôs profissionais fecham os spreads em milissegundos.' : 'Aguardando cotações…')),
    );
    return;
  }

  const canSim = !!(state.contract && state.contract.ok);
  const canExec = canSim && !!(state.wallet || state.burner);
  const frag = document.createDocumentFragment();
  for (const o of rows.slice(0, 60)) {
    const age = curBlock - o.block;
    const flashKey = `${o.id}@${o.block}`;
    const isNewGreen = o.executable && !state.flashed.has(flashKey);
    if (isNewGreen) state.flashed.add(flashKey);
    const cls = [o.executable ? 'green' : o.netUsd > 0 ? 'pos' : 'neg', age > 20 ? 'stale' : '', isNewGreen ? 'flash' : ''].join(' ');
    const tip = `Empréstimo ≈ ${F.usd(o.loanUsd)} · bruto ${F.usd(o.grossUsd, { sign: true })} · taxa Aave ${F.usd(o.premiumUsd)} · gás ≈ ${F.usd(o.gasUsd)} (${F.int(o.gasUnits)} un.)`;
    frag.append(
      el(
        'tr',
        { class: cls, title: tip },
        el('td', {}, o.pairLabel),
        el('td', { class: 'route' }, o.buy.label, el('i', {}, '→'), o.sell.label, o.aaveOk ? null : el('span', { class: 'warn-badge', title: o.aaveNote }, '⚠')),
        el('td', { class: 'num' }, F.pct(o.spreadPct)),
        el('td', { class: 'num hide-sm' }, F.usd(o.grossUsd, { sign: true })),
        el('td', { class: 'num hide-sm' }, F.usd(-o.premiumUsd)),
        el('td', { class: 'num hide-sm' }, F.usd(-o.gasUsd)),
        el('td', { class: `num net ${o.netUsd > 0 ? 'up' : 'down'}` }, F.usd(o.netUsd, { sign: true })),
        el('td', { class: 'hide-sm muted' }, age <= 0 ? 'agora' : `${age} bl`),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'actions' },
            el('button', { class: 'btn btn-small', 'data-act': 'sim', 'data-id': o.id, disabled: !canSim, title: canSim ? 'Simula on-chain (eth_call), sem gastar nada' : 'Conecte o contrato para simular' }, 'Simular'),
            el('button', { class: 'btn btn-small btn-go', 'data-act': 'exec', 'data-id': o.id, disabled: !(canExec && o.executable), title: o.executable ? 'Executar com 1 clique' : 'Só rotas verdes podem ser executadas' }, 'Executar'),
          ),
        ),
      ),
    );
  }
  tbody.replaceChildren(frag);
  if (state.flashed.size > 5000) state.flashed.clear();
}

function renderAave(aave) {
  if (!aave) return;
  const rows = Object.entries(aave).map(([k, a]) => {
    const tok = C.TOKENS[k];
    const status = a.canFlash ? '✓ flash' : a.paused ? 'pausado' : !a.flashEnabled ? 'sem flash' : 'inativo';
    return el(
      'tr',
      {},
      el('td', {}, tok ? tok.symbol : k),
      el('td', { class: a.canFlash ? 'txt-green' : 'txt-red' }, status),
      el('td', {}, a.availableHuman != null ? F.compact(a.availableHuman) : '—'),
    );
  });
  if (rows.length) $('#aaveTable').replaceChildren(...rows);
}

let lastPaperTotal = 0;
function renderPaper(bestThis) {
  const p = state.paper;
  const total = $('#paperTotal');
  total.textContent = F.usd(p.totalUsd);
  if (p.totalUsd > lastPaperTotal) {
    total.classList.remove('bump');
    void total.offsetWidth;
    total.classList.add('bump');
  }
  lastPaperTotal = p.totalUsd;
  $('#paperCount').textContent = F.int(p.count);
  const best = state.board[0];
  $('#bestNow').textContent = best ? `${F.usd(best.netUsd, { sign: true })} (${best.pairLabel})` : '—';
  $('#bestNow').className = best && best.netUsd > 0 ? 'txt-green' : 'txt-red';
  const hits = (p.hits || []).slice(0, 12);
  $('#paperHits').replaceChildren(
    ...(hits.length
      ? hits.map((h) => el('li', { title: `bloco ${h.block}` }, `${F.clock(h.time)} ${h.label} `, el('b', {}, F.usd(h.usd, { sign: true }))))
      : [el('li', {}, bestThis ? 'nenhuma rota passou do lucro mínimo ainda — continue observando' : 'aguardando a primeira varredura')]),
  );
}

function drawSpark() {
  const canvas = $('#spark');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const data = state.spark;
  if (data.length < 2) return;
  const min = Math.min(0, ...data);
  const max = Math.max(0, ...data);
  const span = max - min || 1;
  const x = (i) => (i / (data.length - 1)) * (w - 4) + 2;
  const y = (v) => h - 6 - ((v - min) / span) * (h - 12);
  // linha do zero
  ctx.strokeStyle = 'rgba(0,229,255,0.25)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(w, y(0));
  ctx.stroke();
  ctx.setLineDash([]);
  // área
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(61,255,138,0.35)');
  grad.addColorStop(1, 'rgba(255,77,109,0.25)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(0));
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(data.length - 1), y(0));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // linha
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = data[data.length - 1] >= 0 ? '#3dff8a' : '#ff4d6d';
  ctx.lineWidth = 1.6;
  ctx.shadowColor = ctx.strokeStyle;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(215,227,244,0.6)';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(`melhor líquido por varredura · máx ${F.usd(max, { sign: true })} · mín ${F.usd(min, { sign: true })}`, 6, 12);
}

function renderStats(s) {
  if (!s) return;
  state.stats = s;
  const items = [
    ['Blocos analisados', F.int(s.blocks)],
    ['Varreduras', F.int(s.scans)],
    ['Cotações on-chain', F.int(s.quotes)],
    ['Rotas avaliadas', F.int(s.routes)],
    ['Verdes vistas', F.int(s.greens)],
    ['Simulações', `${F.int(s.simulations)} (${F.int(s.simFailed)} ✗)`],
    ['Txs enviadas', F.int(s.sent)],
    ['Sucesso / revert', `${F.int(s.success)} / ${F.int(s.reverted)}`],
    ['Lucro real', F.usd(s.profitUsd)],
    ['Gás gasto', `${F.num(s.gasSpentPol, 4)} POL`],
    ['Lucro simulado', F.usd(s.paperUsd)],
    ['Tempo ligado', F.duration(s.uptimeSec)],
  ];
  $('#stats').replaceChildren(...items.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
}

function renderContract(st) {
  const box = $('#contractStatus');
  state.contract = st;
  if (!st) {
    box.className = 'status-box';
    box.textContent = 'Nenhum contrato conectado. Sem ele dá para observar e simular o mercado.';
  } else if (!st.ok) {
    box.className = 'status-box bad';
    box.textContent = st.error;
  } else {
    localStorage.setItem(C.STORAGE_KEYS.contract, st.address);
    box.className = 'status-box ok';
    const routers = C.DEXES.map((d) => `${d.short} ${st.routers[d.id] ? '✓' : '✗'}`).join(' · ');
    box.replaceChildren(
      el('div', {}, 'Contrato: ', el('a', { href: C.addressLink(st.address), target: '_blank', rel: 'noopener noreferrer' }, F.shortAddr(st.address))),
      el('div', {}, 'Dono: ', el('b', {}, F.shortAddr(st.owner))),
      el('div', {}, 'Arbitragens executadas: ', el('b', {}, String(st.totalTrades))),
      el('div', {}, 'Routers: ', routers),
    );
  }
  renderWallet();
  renderBoard();
}

function renderBurner(info) {
  state.burner = info;
  const box = $('#burnerStatus');
  if (!info) {
    box.className = 'status-box';
    box.textContent = 'Nenhuma burner carregada.';
  } else {
    const auth = info.authorized == null ? 'conecte o contrato para verificar' : info.authorized ? '✓ autorizada no contrato' : '✗ NÃO autorizada (setExecutor)';
    box.className = `status-box ${info.authorized === false ? 'bad' : 'ok'}`;
    box.replaceChildren(
      el('div', {}, 'Burner: ', el('a', { href: C.addressLink(info.address), target: '_blank', rel: 'noopener noreferrer' }, F.shortAddr(info.address))),
      el('div', {}, 'Saldo: ', el('b', {}, `${F.num(info.balancePol, 4)} POL`)),
      el('div', {}, auth),
    );
  }
  renderWallet();
  renderBoard();
}

function renderAuto(enabled) {
  state.auto = !!enabled;
  $('#autoToggle').checked = state.auto;
  renderMode();
  if (state.auto) requestWakeLock();
  else releaseWakeLock();
}

function addTx(d) {
  if (!d) return;
  if (d.hash) {
    const existing = state.txs.find((t) => t.hash === d.hash);
    if (existing) Object.assign(existing, d);
    else state.txs.unshift({ ...d, time: Date.now() });
  } else {
    state.txs.unshift({ ...d, time: Date.now() });
  }
  state.txs = state.txs.slice(0, 30);
  const list = $('#txList');
  list.replaceChildren(
    ...state.txs.map((t) => {
      const ok = ['confirmada', 'enviada', 'simulada'].includes(t.status);
      return el(
        'li',
        { title: t.reason || '' },
        el('span', {}, F.clock(t.time), ' ', t.hash ? el('a', { href: t.link || C.txLink(t.hash), target: '_blank', rel: 'noopener noreferrer' }, F.shortAddr(t.hash)) : (t.oppId || '').split('|')[0]),
        el('span', { class: ok ? `st-${t.status}` : 'st-err' }, t.status),
      );
    }),
  );
}

// ─── Carteira (Rabby / MetaMask) ────────────────────────────────────────────

function renderWalletOptions() {
  const box = $('#walletPick');
  if (state.wallet) {
    box.replaceChildren(el('button', { class: 'btn btn-small btn-ghost', onclick: disconnectWallet }, 'Desconectar'));
    return;
  }
  if (!state.walletOptions.length) {
    box.replaceChildren(el('span', { class: 'hint' }, 'Nenhuma carteira encontrada. Instale a Rabby ou a MetaMask, ou use a burner abaixo.'));
    return;
  }
  box.replaceChildren(
    ...state.walletOptions.map((w) => {
      const icon = typeof w.info.icon === 'string' && w.info.icon.startsWith('data:image/') ? el('img', { src: w.info.icon, alt: '' }) : null;
      return el('button', { class: 'btn btn-small', onclick: () => onConnectWallet(w) }, icon, `Conectar ${w.info.name}`);
    }),
  );
}

function renderWallet() {
  const box = $('#walletStatus');
  const w = state.wallet;
  const btnAuth = $('#btnAuthorize');
  if (!w) {
    box.className = 'status-box';
    box.textContent = 'Desconectada.';
    btnAuth.hidden = true;
    renderWalletOptions();
    return;
  }
  const isOwner = state.contract && state.contract.ok && state.contract.owner.toLowerCase() === w.address.toLowerCase();
  box.className = 'status-box ok';
  box.replaceChildren(
    el('div', {}, `${w.name}: `, el('b', {}, F.shortAddr(w.address))),
    el('div', {}, state.contract && state.contract.ok ? (isOwner ? '✓ é a dona do contrato' : 'não é a dona do contrato (precisa ser dona ou executora)') : 'conecte o contrato acima'),
  );
  btnAuth.hidden = !(isOwner && state.burner && state.burner.authorized === false);
  renderWalletOptions();
}

async function ensureEthers() {
  if (!state.E) {
    state.E = await loadEthers();
    $('#ethersSource').textContent = `ethers.js v${state.E.version}`;
  }
  return state.E;
}

async function onConnectWallet(option) {
  try {
    const E = await ensureEthers();
    const conn = await connectWallet(E, option.provider);
    state.wallet = { ...conn, eip1193: option.provider, name: option.info.name };
    uiLog('ok', `Carteira ${option.info.name} conectada: ${conn.address}`);
    const onChange = () => {
      uiLog('warn', 'A carteira mudou de conta ou de rede — conecte novamente.');
      disconnectWallet();
    };
    option.provider.on && option.provider.on('accountsChanged', onChange);
    option.provider.on && option.provider.on('chainChanged', onChange);
    state.wallet.cleanup = () => {
      option.provider.removeListener && option.provider.removeListener('accountsChanged', onChange);
      option.provider.removeListener && option.provider.removeListener('chainChanged', onChange);
    };
  } catch (err) {
    uiLog('error', `Carteira: ${err && (err.shortMessage || err.message) ? err.shortMessage || err.message : err}`);
  }
  renderWallet();
  renderBoard();
}

function disconnectWallet() {
  if (state.wallet && state.wallet.cleanup) state.wallet.cleanup();
  state.wallet = null;
  renderWallet();
  renderBoard();
}

async function authorizeBurner() {
  if (!state.wallet || !state.burner || !state.contract || !state.contract.ok) return;
  try {
    const E = await ensureEthers();
    const c = new E.Contract(state.contract.address, C.ABI.arb, state.wallet.signer);
    uiLog('info', `Pedindo à carteira para autorizar a burner ${state.burner.address}…`);
    const tx = await c.setExecutor(state.burner.address, true);
    uiLog('tx', `setExecutor enviado: ${tx.hash}`, { link: C.txLink(tx.hash) });
    await tx.wait(1);
    uiLog('ok', 'Burner autorizada como executora ✓');
    await send('burner-refresh');
  } catch (err) {
    uiLog('error', `Autorização falhou: ${err.shortMessage || err.message}`);
  }
}

// ─── Execução manual ────────────────────────────────────────────────────────

async function runOpportunity(id, dryRun) {
  const opp = state.board.find((o) => o.id === id);
  if (!opp) return uiLog('warn', 'Essa rota já saiu do quadro — espere a próxima varredura.');
  if (!state.contract || !state.contract.ok) return uiLog('warn', 'Conecte o contrato primeiro.');

  if (!state.wallet) {
    // burner (ou simulação "como dono") — tudo roda dentro do worker
    return send('execute', { id, dryRun }).catch(() => {});
  }

  const E = await ensureEthers();
  const contract = new E.Contract(state.contract.address, C.ABI.arb, state.wallet.signer);
  const base = C.TOKENS[opp.base];
  uiLog('info', `${dryRun ? '🔎 Simulando' : '⚡ Executando'} pela carteira: ${opp.pairLabel} ${opp.buy.label} → ${opp.sell.label} (estimado ${F.usd(opp.netUsd, { sign: true })})`);
  const r = await executeArb(E, contract, opp, {
    minProfitUsd: state.settings.minProfitUsd,
    dryRun,
    blockTs: state.lastScan ? state.lastScan.blockTs : 0,
    onSent: (hash) => {
      uiLog('tx', `Transação enviada: ${hash}`, { link: C.txLink(hash) });
      addTx({ hash, status: 'enviada', oppId: opp.id, link: C.txLink(hash) });
    },
  });
  if (!r.ok) {
    uiLog(r.stage === 'simulacao' ? 'warn' : 'error', `${r.stage}: ${r.reason}${r.stage === 'simulacao' ? ' (nada foi enviado)' : ''}`, r.hash ? { link: C.txLink(r.hash) } : {});
    addTx({ hash: r.hash || null, status: r.stage, oppId: opp.id, reason: r.reason });
  } else if (dryRun) {
    const amount = Number(E.formatUnits(r.profit, base.decimals));
    uiLog('ok', `Simulação OK: lucro on-chain agora = ${amount} ${base.symbol} (≈ ${F.usd(amount * opp.basePrice)}, antes do gás)`);
    addTx({ hash: null, status: 'simulada', oppId: opp.id });
  } else {
    const amount = Number(E.formatUnits(r.profit || 0n, base.decimals));
    uiLog('ok', `✅ LUCRO de ${amount} ${base.symbol} (≈ ${F.usd(amount * opp.basePrice)}) enviado para a carteira dona`, { link: C.txLink(r.hash) });
    addTx({ hash: r.hash, status: 'confirmada', oppId: opp.id });
  }
}

// ─── Burner wallet ──────────────────────────────────────────────────────────

async function loadBurner(key) {
  const k = (key || '').trim();
  if (!k) return uiLog('warn', 'Cole a chave privada da burner wallet.');
  try {
    await send('burner', { privateKey: k });
    if ($('#rememberBurner').checked) sessionStorage.setItem(C.STORAGE_KEYS.burner, k);
    else sessionStorage.removeItem(C.STORAGE_KEYS.burner);
    $('#burnerKey').value = '';
  } catch (_) {
    /* erro já aparece no console */
  }
}

async function newBurner() {
  const E = await ensureEthers();
  const w = E.Wallet.createRandom();
  const box = $('#newBurnerBox');
  box.hidden = false;
  box.replaceChildren(
    el('div', {}, el('b', {}, 'GUARDE ESTA CHAVE AGORA'), ' (ex.: importe na Rabby → "Importar chave privada"). Se fechar a página sem guardar, o POL enviado para ela se perde.'),
    el('div', {}, 'Endereço: ', w.address),
    el('div', {}, 'Chave privada: ', w.privateKey),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn btn-small', onclick: () => navigator.clipboard && navigator.clipboard.writeText(w.privateKey).then(() => uiLog('ok', 'Chave copiada.')) }, 'Copiar chave'),
      el('button', { class: 'btn btn-small btn-go', onclick: () => { loadBurner(w.privateKey); box.hidden = true; box.replaceChildren(); } }, 'Já guardei — usar'),
      el('button', { class: 'btn btn-small btn-ghost', onclick: () => { box.hidden = true; box.replaceChildren(); } }, 'Fechar'),
    ),
  );
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    }
  } catch (_) {
    /* sem suporte */
  }
}

function releaseWakeLock() {
  if (state.wakeLock) state.wakeLock.release().catch(() => {});
  state.wakeLock = null;
}

// ─── Controles de configuração ──────────────────────────────────────────────

function buildControls() {
  const s = state.settings;
  $('#loanUsd').value = s.loanUsd;
  $('#minProfitUsd').value = s.minProfitUsd;
  $('#intervalMs').value = s.intervalMs;
  $('#pairsPerScan').value = s.pairsPerScan;
  $('#crossFeeTiers').checked = !!s.crossFeeTiers;
  $('#gasCapPol').value = s.gasCapPol;
  $('#priorityBoostPct').value = s.priorityBoostPct;
  $('#rpcUrls').value = s.rpcUrls.join('\n');
  $('#appVersion').textContent = `v${C.APP_VERSION}`;
  $('#ethersSource').textContent = `ethers.js v${ETHERS_VERSION}`;
  markLoanPreset();

  $('#dexList').replaceChildren(
    ...C.DEXES.map((d) =>
      el(
        'label',
        { class: 'toggle', title: d.name },
        el('input', { type: 'checkbox', value: d.id, checked: s.dexIds.includes(d.id), onchange: onDexChange }),
        d.name,
      ),
    ),
  );

  $('#pairList').replaceChildren(
    ...C.PAIRS.map((p) =>
      el(
        'label',
        { class: `pair-chip ${p.core ? 'core' : ''}`, title: p.core ? 'Par da especificação original' : `${p.base} emprestado · ${p.mid} intermediário` },
        el('input', { type: 'checkbox', value: p.id, checked: s.pairIds.includes(p.id), onchange: onPairChange }),
        p.label,
      ),
    ),
  );
  updatePairCount();
}

function markLoanPreset() {
  document.querySelectorAll('[data-loan]').forEach((b) => b.classList.toggle('active', Number(b.dataset.loan) === Number(state.settings.loanUsd)));
}

function onDexChange() {
  const ids = [...document.querySelectorAll('#dexList input:checked')].map((i) => i.value);
  updateSettings({ dexIds: ids });
}

function onPairChange() {
  const ids = [...document.querySelectorAll('#pairList input:checked')].map((i) => i.value);
  updateSettings({ pairIds: ids });
  updatePairCount();
}

function updatePairCount() {
  $('#pairCount').textContent = `${state.settings.pairIds.length}/${C.PAIRS.length}`;
}

function setPairs(mode) {
  const pick = {
    all: () => true,
    core: (p) => p.core,
    stable: (p) => C.TOKENS[p.base].stable,
    none: () => false,
  }[mode];
  document.querySelectorAll('#pairList input').forEach((input) => {
    const p = C.PAIRS.find((x) => x.id === input.value);
    input.checked = !!pick(p);
  });
  onPairChange();
}

function numberSetting(id, key, { min = -Infinity, max = Infinity } = {}) {
  $(id).addEventListener('change', (ev) => {
    let v = Number(ev.target.value);
    if (!Number.isFinite(v)) v = C.DEFAULT_SETTINGS[key];
    v = Math.min(max, Math.max(min, v));
    ev.target.value = v;
    updateSettings({ [key]: v });
    if (key === 'loanUsd') markLoanPreset();
  });
}

function wireEvents() {
  $('#btnScan').addEventListener('click', () => send(state.running ? 'stop' : 'start').catch(() => {}));

  document.querySelectorAll('[data-loan]').forEach((b) =>
    b.addEventListener('click', () => {
      $('#loanUsd').value = b.dataset.loan;
      updateSettings({ loanUsd: Number(b.dataset.loan) });
      markLoanPreset();
    }),
  );
  numberSetting('#loanUsd', 'loanUsd', { min: 10, max: 10_000_000 });
  numberSetting('#minProfitUsd', 'minProfitUsd', { min: 0, max: 100000 });
  numberSetting('#intervalMs', 'intervalMs', { min: 1000, max: 60000 });
  numberSetting('#pairsPerScan', 'pairsPerScan', { min: 1, max: C.PAIRS.length });
  numberSetting('#gasCapPol', 'gasCapPol', { min: 0, max: 1000 });
  numberSetting('#priorityBoostPct', 'priorityBoostPct', { min: 50, max: 1000 });
  $('#crossFeeTiers').addEventListener('change', (ev) => updateSettings({ crossFeeTiers: ev.target.checked }));
  document.querySelectorAll('[data-pairs]').forEach((b) => b.addEventListener('click', () => setPairs(b.dataset.pairs)));

  $('#btnRpcSave').addEventListener('click', () => {
    const urls = $('#rpcUrls')
      .value.split(/\s+/)
      .map((u) => u.trim())
      .filter((u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(u));
    if (!urls.length) return uiLog('warn', 'Informe pelo menos um RPC https://');
    $('#rpcUrls').value = urls.join('\n');
    updateSettings({ rpcUrls: urls });
  });
  $('#btnRpcReset').addEventListener('click', () => {
    $('#rpcUrls').value = C.DEFAULT_RPCS.join('\n');
    updateSettings({ rpcUrls: C.DEFAULT_RPCS });
  });

  $('#onlyPositive').addEventListener('change', renderBoard);
  $('#oppBody').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    runOpportunity(btn.dataset.id, btn.dataset.act === 'sim');
  });

  $('#btnContract').addEventListener('click', () => {
    const addr = $('#contractAddr').value.trim();
    if (!addr) {
      localStorage.removeItem(C.STORAGE_KEYS.contract);
      send('contract', { address: null }).catch(() => {});
      return;
    }
    send('contract', { address: addr }).catch(() => {});
  });

  $('#btnBurner').addEventListener('click', () => loadBurner($('#burnerKey').value));
  $('#burnerKey').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') loadBurner(ev.target.value);
  });
  $('#rememberBurner').addEventListener('change', (ev) => {
    if (!ev.target.checked) sessionStorage.removeItem(C.STORAGE_KEYS.burner);
  });
  $('#btnNewBurner').addEventListener('click', newBurner);
  $('#btnForgetBurner').addEventListener('click', () => {
    sessionStorage.removeItem(C.STORAGE_KEYS.burner);
    send('burner', { privateKey: null }).catch(() => {});
  });
  $('#btnAuthorize').addEventListener('click', authorizeBurner);

  $('#autoToggle').addEventListener('change', (ev) => {
    const want = ev.target.checked;
    ev.target.checked = state.auto; // espera a confirmação do worker
    send('auto', { enabled: want }).catch(() => {});
  });

  document.querySelectorAll('[data-log]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-log]').forEach((x) => x.classList.toggle('active', x === b));
      state.logFilter = b.dataset.log;
      rerenderLogs();
    }),
  );
  $('#logScan').addEventListener('change', rerenderLogs);
  $('#btnClearLog').addEventListener('click', () => {
    state.logs = [];
    $('#log').replaceChildren();
  });

  // aviso inicial
  if (!localStorage.getItem('flasharb.disclaimer')) $('#disclaimer').hidden = false;
  $('#btnDisclaimer').addEventListener('click', () => {
    localStorage.setItem('flasharb.disclaimer', '1');
    $('#disclaimer').hidden = true;
  });

  // aba em segundo plano
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.auto) uiLog('warn', 'Aba em segundo plano: no celular o navegador pode pausar o robô. Para rodar 24h, use o bot no VPS (README).');
    if (!document.hidden && state.auto) requestWakeLock();
  });

  window.addEventListener('resize', drawSpark);
}

// ─── PWA: instalação e atualização ──────────────────────────────────────────

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  installPrompt = ev;
  $('#btnInstall').hidden = false;
});
$('#btnInstall').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('#btnInstall').hidden = true;
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  const showUpdate = () => {
    $('#updateBanner').hidden = false;
  };
  $('#btnReload').addEventListener('click', () => location.reload());
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      setInterval(() => reg.update().catch(() => {}), 10 * 60 * 1000);
    })
    .catch((err) => uiLog('warn', `Service worker não registrado: ${err.message}`));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    // nova versão publicada: recarrega sozinho se o robô estiver parado; senão só avisa
    if (!state.running && !state.auto) {
      reloading = true;
      location.reload();
    } else {
      showUpdate();
    }
  });
}

// ─── Início ─────────────────────────────────────────────────────────────────

buildControls();
wireEvents();
renderWallet();
discoverWallets((list) => {
  state.walletOptions = list;
  renderWalletOptions();
});
registerServiceWorker();
uiLog('info', `FLASH//ARB v${C.APP_VERSION} · Polygon (chain ${C.CHAIN.id}) · ${C.PAIRS.length} pares · ${C.DEXES.length} DEXs`);
