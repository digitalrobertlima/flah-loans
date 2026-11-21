// Pool de RPCs públicos com fallback automático.
// - Ao iniciar, testa todos em paralelo (eth_chainId) e ordena pelo mais rápido.
// - Se uma chamada falha (timeout, 429, erro de rede), troca para o próximo e tenta de novo.
// - Erros de contrato (revert) NÃO trocam de RPC: a culpa não é do nó.

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function shortError(err) {
  if (!err) return 'erro desconhecido';
  const msg = err.shortMessage || err.reason || err.message || String(err);
  return String(msg).split('\n')[0].slice(0, 180);
}

export function isRevert(err) {
  if (!err) return false;
  if (err.code === 'CALL_EXCEPTION') return true;
  const info = err.info && err.info.error;
  return !!(info && typeof info.message === 'string' && /revert/i.test(info.message) && info.data);
}

/** Erro que se repetiria em qualquer RPC (revert, falta de gás no eth_call): não adianta trocar de nó. */
export function isDeterministic(err) {
  if (isRevert(err)) return true;
  const msg = `${(err && err.message) || ''} ${(err && err.info && err.info.error && err.info.error.message) || ''}`;
  return /out of gas|gas required exceeds|exceeds block gas limit|execution reverted/i.test(msg);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class RpcPool {
  constructor(E, urls, { timeoutMs = 8000, onEvent = () => {} } = {}) {
    if (!urls || !urls.length) throw new Error('Nenhum RPC configurado');
    this.E = E;
    this.timeoutMs = timeoutMs;
    this.onEvent = onEvent;
    this.network = new E.Network('polygon', 137n); // rede "limpa": sem plugins externos (gas station etc.)
    this.nodes = [...new Set(urls)].map((url) => ({
      url,
      provider: this._make(url),
      ok: true,
      latency: null,
      fails: 0,
      lastError: null,
    }));
    this.idx = 0;
    this.lastProbe = 0;
  }

  _make(url) {
    return new this.E.JsonRpcProvider(url, this.network, {
      staticNetwork: this.network,
      batchMaxCount: 1, // vários RPCs públicos recusam lotes JSON-RPC
    });
  }

  get current() {
    return this.nodes[this.idx];
  }

  get provider() {
    return this.current.provider;
  }

  get url() {
    return this.current.url;
  }

  status() {
    return this.nodes.map(({ url, ok, latency, fails, lastError }) => ({ url, ok, latency, fails, lastError }));
  }

  async probe() {
    await Promise.all(
      this.nodes.map(async (node) => {
        const t0 = now();
        try {
          const chainId = await withTimeout(node.provider.send('eth_chainId', []), this.timeoutMs, 'probe');
          if (BigInt(chainId) !== 137n) throw new Error(`chainId errado (${chainId})`);
          node.ok = true;
          node.latency = Math.round(now() - t0);
          node.fails = 0;
          node.lastError = null;
        } catch (err) {
          node.ok = false;
          node.latency = null;
          node.lastError = shortError(err);
        }
      }),
    );
    this.nodes.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return (a.latency ?? 1e9) - (b.latency ?? 1e9);
    });
    this.idx = 0;
    this.lastProbe = Date.now();
    const alive = this.nodes.filter((n) => n.ok).length;
    this.onEvent({ type: 'probe', alive, total: this.nodes.length, current: this.url, nodes: this.status() });
    if (!alive) throw new Error('Nenhum RPC respondeu. Verifique sua internet ou adicione um RPC próprio.');
    return this.status();
  }

  rotate(reason) {
    const n = this.nodes.length;
    for (let k = 1; k <= n; k++) {
      const j = (this.idx + k) % n;
      if (this.nodes[j].ok || k === n) {
        this.idx = j;
        break;
      }
    }
    this.onEvent({ type: 'switch', current: this.url, reason });
  }

  /**
   * Executa fn(provider) com timeout e fallback.
   * @param {string} label nome da operação (aparece nos logs)
   * @param {(provider) => Promise<any>} fn
   */
  async run(label, fn, { attempts } = {}) {
    // revive nós "mortos" de tempos em tempos
    if (Date.now() - this.lastProbe > 5 * 60 * 1000 && this.nodes.some((n) => !n.ok)) {
      this.lastProbe = Date.now();
      this.probe().catch(() => {});
    }
    const max = attempts ?? Math.min(this.nodes.length, 4);
    let lastErr;
    for (let i = 0; i < max; i++) {
      const node = this.current;
      const t0 = now();
      try {
        const result = await withTimeout(fn(node.provider), this.timeoutMs, label);
        const dt = Math.round(now() - t0);
        node.latency = node.latency == null ? dt : Math.round(node.latency * 0.7 + dt * 0.3);
        node.fails = 0;
        node.ok = true;
        return result;
      } catch (err) {
        if (isDeterministic(err)) throw err;
        lastErr = err;
        node.fails += 1;
        node.lastError = shortError(err);
        if (node.fails >= 3) node.ok = false;
        this.onEvent({ type: 'error', url: node.url, label, error: node.lastError });
        this.rotate(node.lastError);
      }
    }
    throw lastErr;
  }
}
