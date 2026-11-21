// ════════════════════════════════════════════════════════════════════════════
//  ArbRunner — o "piloto": laço de varredura por bloco, rodízio de pares,
//  placar de simulação (paper trading) e execução automática com a burner wallet.
//  Usado pelo Web Worker (PWA) e pelo robô Node (bot/run.mjs) — mesmo código nos dois.
// ════════════════════════════════════════════════════════════════════════════

import { Engine, executeArb } from './engine.js';
import { shortError } from './rpc.js';
import * as C from './config.js';

const STAGE_LABEL = {
  simulacao: 'Simulação reprovada',
  estimativa: 'Estimativa de gás falhou',
  envio: 'Envio recusado',
  revertida: 'Transação revertida on-chain',
  confirmacao: 'Sem confirmação a tempo',
};

export class ArbRunner {
  constructor({ settings = {}, emit = () => {} } = {}) {
    this.settings = { ...C.DEFAULT_SETTINGS, ...settings };
    this.emit = emit;
    this.engine = null;
    this.running = false;
    this.timer = null;
    this.cursor = 0;
    this.lastBlock = 0;
    this.backoffMs = 0;
    this.contractAddress = null;
    this.contractInfo = null;
    this.wallet = null;
    this.burnerAuthorized = null;
    this.auto = false;
    this.busy = false;
    this.cooldown = new Map(); // id da rota -> bloco até o qual ela fica de "castigo"
    this.board = new Map(); // id da rota -> última cotação (todas as rotas de todos os pares)
    this.lastResult = null;
    this.paper = { totalUsd: 0, count: 0, hits: [], seen: new Map() };
    this.stats = {
      blocks: 0,
      scans: 0,
      quotes: 0,
      routes: 0,
      greens: 0,
      simulations: 0,
      simFailed: 0,
      sent: 0,
      success: 0,
      reverted: 0,
      profitUsd: 0,
      gasSpentWei: 0n,
      startedAt: Date.now(),
    };
  }

  log(level, msg, extra = {}) {
    this.emit('log', { level, msg, time: Date.now(), ...extra });
  }

  async init() {
    this.log('info', 'Carregando ethers.js e testando os RPCs públicos…');
    this.engine = await Engine.create({
      rpcUrls: this.settings.rpcUrls,
      onRpcEvent: (ev) => this._onRpc(ev),
      log: (level, msg) => this.log(level, msg),
    });
    this.log('ok', `ethers ${this.engine.E.version} pronto · RPC ativo: ${this.engine.rpc.url}`);
    this.emit('ready', { rpc: this.engine.rpc.status(), current: this.engine.rpc.url });
    return this;
  }

  _onRpc(ev) {
    if (ev.type === 'probe') {
      const cur = ev.nodes.find((n) => n.url === ev.current);
      this.log(ev.alive ? 'ok' : 'error', `RPCs online: ${ev.alive}/${ev.total} · usando ${ev.current}${cur && cur.latency != null ? ` (${cur.latency} ms)` : ''}`);
    } else if (ev.type === 'switch') {
      this.log('warn', `Trocando de RPC → ${ev.current} (${ev.reason || 'falha'})`);
    }
    this.emit('rpc', { current: this.engine ? this.engine.rpc.url : ev.current, nodes: this.engine ? this.engine.rpc.status() : ev.nodes || [] });
  }

  publicStats() {
    const E = this.engine && this.engine.E;
    return {
      ...this.stats,
      gasSpentWei: undefined,
      gasSpentPol: E ? Number(E.formatEther(this.stats.gasSpentWei)) : 0,
      uptimeSec: Math.round((Date.now() - this.stats.startedAt) / 1000),
      paperUsd: this.paper.totalUsd,
      paperCount: this.paper.count,
      auto: this.auto,
      running: this.running,
    };
  }

  publicState() {
    return {
      running: this.running,
      auto: this.auto,
      contract: this.contractAddress,
      burner: this.wallet ? this.wallet.address : null,
      settings: { ...this.settings },
    };
  }

  async setSettings(partial = {}) {
    const rpcChanged = partial.rpcUrls && JSON.stringify(partial.rpcUrls) !== JSON.stringify(this.settings.rpcUrls);
    this.settings = { ...this.settings, ...partial };
    if (partial.pairIds) this.cursor = 0;
    if (rpcChanged && this.engine) {
      this.log('info', 'Lista de RPCs alterada — testando de novo…');
      await this.engine.setRpcs(this.settings.rpcUrls, (ev) => this._onRpc(ev));
    }
    if (partial.minProfitUsd != null) {
      // reavalia o que é "verde" no quadro com o novo lucro mínimo
      for (const o of this.board.values()) o.executable = o.aaveOk && o.netToken > 0n && o.netUsd >= this.settings.minProfitUsd;
    }
    this.emit('state', this.publicState());
  }

  start() {
    if (this.running) return;
    if (!this.engine) throw new Error('Motor ainda não inicializado');
    this.running = true;
    this.log('info', `▶ Scanner iniciado · ${this.settings.pairIds.length} pares · ${this.settings.dexIds.length} DEXs · empréstimo simulado $${this.settings.loanUsd.toLocaleString('pt-BR')}`);
    this.emit('state', this.publicState());
    this._loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.log('info', '■ Scanner parado');
    this.emit('state', this.publicState());
  }

  async _loop() {
    if (!this.running) return;
    const t0 = Date.now();
    try {
      await this.tick();
      this.backoffMs = Math.max(0, this.backoffMs - 1000);
    } catch (err) {
      this.backoffMs = Math.min(15000, this.backoffMs ? this.backoffMs * 2 : 1000);
      this.log('error', `Falha no ciclo: ${shortError(err)} · nova tentativa em ${((this.settings.intervalMs + this.backoffMs) / 1000).toFixed(1)} s`);
    }
    if (!this.running) return;
    const wait = Math.max(250, this.settings.intervalMs - (Date.now() - t0)) + this.backoffMs;
    this.timer = setTimeout(() => this._loop(), wait);
  }

  /** Só varre quando aparece bloco novo. */
  async tick() {
    const bn = await this.engine.rpc.run('blockNumber', (p) => p.getBlockNumber());
    if (bn <= this.lastBlock) return null;
    this.stats.blocks += this.lastBlock ? bn - this.lastBlock : 1;
    this.lastBlock = bn;
    return this.scanOnce();
  }

  _nextSubset() {
    const ids = this.settings.pairIds;
    const n = Math.max(1, Math.min(this.settings.pairsPerScan || ids.length, ids.length));
    if (ids.length <= n) return ids.slice();
    const out = [];
    for (let i = 0; i < n; i++) out.push(ids[(this.cursor + i) % ids.length]);
    this.cursor = (this.cursor + n) % ids.length;
    return out;
  }

  /** Uma varredura (usada pelo laço e pelos testes). */
  async scanOnce(subset = null) {
    const ids = subset || this._nextSubset();
    const res = await this.engine.scan(this.settings, ids);
    this.lastResult = res;
    this.stats.scans += 1;
    this.stats.quotes += res.quotes;
    this.stats.routes += res.routes;

    // atualiza o quadro geral: troca as rotas dos pares que acabaram de ser cotados
    const scanned = new Set(res.pairIds);
    for (const [id, o] of this.board) if (scanned.has(o.pairId)) this.board.delete(id);
    for (const o of res.opportunities) this.board.set(o.id, o);

    const greens = res.opportunities.filter((o) => o.executable);
    this.stats.greens += greens.length;
    this._paper(res, greens);

    const best = res.opportunities[0];
    const bestTxt = best ? `melhor ${best.pairLabel} ${best.buy.label}→${best.sell.label}: ${best.netUsd >= 0 ? '+' : ''}$${best.netUsd.toFixed(2)} (${best.spreadPct.toFixed(3)}%)` : 'sem cotações';
    this.log('scan', `Bloco ${res.block.toLocaleString('pt-BR')} · ${res.pairIds.length} pares · ${res.quotes} cotações · ${res.durationMs} ms · ${bestTxt}`);
    if (greens.length) {
      const g = greens[0];
      this.log('ok', `🟢 ${greens.length} oportunidade(s) ≥ $${this.settings.minProfitUsd} · ${g.pairLabel} ${g.buy.label} → ${g.sell.label} ≈ +$${g.netUsd.toFixed(2)}`);
    }

    const board = [...this.board.values()].sort((a, b) => b.netUsd - a.netUsd).slice(0, 80);
    this.emit('scan', { ...res, opportunities: undefined, board, stats: this.publicStats(), paper: this._paperPublic() });

    if (this.auto) {
      this._maybeAuto(res).catch((err) => this.log('error', `Piloto automático: ${shortError(err)}`));
    }
    return res;
  }

  _paper(res, greens) {
    for (const g of greens) {
      const last = this.paper.seen.get(g.id);
      if (last && res.block - last < 10) continue; // mesma oportunidade só conta de novo depois de 10 blocos
      this.paper.seen.set(g.id, res.block);
      this.paper.totalUsd += g.netUsd;
      this.paper.count += 1;
      this.paper.hits.unshift({ time: Date.now(), block: res.block, label: `${g.pairLabel} ${g.buy.label} → ${g.sell.label}`, usd: g.netUsd });
      this.paper.hits = this.paper.hits.slice(0, 25);
    }
  }

  _paperPublic() {
    return { totalUsd: this.paper.totalUsd, count: this.paper.count, hits: this.paper.hits };
  }

  findOpportunity(id) {
    return this.board.get(id) || null;
  }

  async setContract(address) {
    if (!address) {
      this.contractAddress = null;
      this.contractInfo = null;
      this.emit('contract', null);
      return null;
    }
    const st = await this.engine.contractStatus(address, this.wallet ? this.wallet.address : null);
    if (st.ok) {
      this.contractAddress = st.address;
      this.contractInfo = st;
      if (this.wallet) this.burnerAuthorized = st.authorized;
      this.log('ok', `Contrato conectado: ${st.address} · dono ${st.owner} · ${st.totalTrades} arbitragens feitas`, { link: C.addressLink(st.address) });
    } else {
      this.contractAddress = null;
      this.contractInfo = null;
      this.log('error', `Contrato: ${st.error}`);
    }
    this.emit('contract', serializable(st));
    if (this.wallet) await this.burnerStatus();
    return st;
  }

  async setBurner(privateKey) {
    if (!privateKey) {
      this.wallet = null;
      this.burnerAuthorized = null;
      if (this.auto) this.setAuto(false);
      this.emit('burner', null);
      this.log('info', 'Burner wallet removida da memória');
      return null;
    }
    let wallet;
    try {
      const key = privateKey.trim().startsWith('0x') ? privateKey.trim() : `0x${privateKey.trim()}`;
      wallet = new this.engine.E.Wallet(key);
    } catch (_) {
      throw new Error('Chave privada inválida (precisa ter 64 caracteres hexadecimais).');
    }
    this.wallet = wallet;
    this.log('ok', `Burner wallet carregada (só na memória): ${wallet.address}`, { link: C.addressLink(wallet.address) });
    return this.burnerStatus();
  }

  async burnerStatus() {
    if (!this.wallet) return null;
    const E = this.engine.E;
    const bal = await this.engine.rpc.run('getBalance', (p) => p.getBalance(this.wallet.address));
    if (this.contractAddress) {
      const st = await this.engine.contractStatus(this.contractAddress, this.wallet.address);
      this.burnerAuthorized = st.ok ? st.authorized : null;
    }
    const info = {
      address: this.wallet.address,
      balancePol: Number(E.formatEther(bal)),
      authorized: this.burnerAuthorized,
    };
    if (this.contractAddress && this.burnerAuthorized === false) {
      this.log('warn', `A burner ${info.address} ainda NÃO é executora do contrato. Na carteira dona, chame setExecutor(${info.address}, true).`);
    }
    if (info.balancePol < 0.5) this.log('warn', `Burner com pouco POL para gás (${info.balancePol.toFixed(3)} POL).`);
    this.emit('burner', info);
    return info;
  }

  setAuto(enabled) {
    let on = !!enabled;
    if (on && (!this.wallet || !this.contractAddress)) {
      this.log('warn', 'Para ligar o piloto automático: carregue a burner wallet e conecte o contrato.');
      on = false;
    }
    if (on && this.burnerAuthorized === false) {
      this.log('warn', 'A burner não está autorizada no contrato (setExecutor). Piloto automático continua desligado.');
      on = false;
    }
    this.auto = on;
    this.emit('auto', { enabled: on });
    this.log(on ? 'ok' : 'info', on ? `🤖 Piloto automático LIGADO · dispara quando o lucro líquido ≥ $${this.settings.minProfitUsd} · teto de gás ${this.settings.gasCapPol} POL` : 'Piloto automático desligado');
    if (on && !this.running) this.start();
    return on;
  }

  async _maybeAuto(res) {
    if (this.busy || !this.wallet || !this.contractAddress) return;
    const capWei = this.engine.E.parseEther(String(this.settings.gasCapPol || 0));
    if (capWei > 0n && this.stats.gasSpentWei >= capWei) {
      this.log('warn', `Teto de gás da sessão atingido (${this.settings.gasCapPol} POL). Piloto automático desligado por segurança.`);
      this.setAuto(false);
      return;
    }
    const best = res.opportunities.find((o) => o.executable && !((this.cooldown.get(o.id) || 0) >= res.block));
    if (!best) return;
    await this.executeOpportunity(best, { source: 'auto' });
  }

  /** Executa (ou só simula) uma oportunidade com a burner wallet. */
  async executeOpportunity(opp, { dryRun = false, source = 'manual' } = {}) {
    if (!this.contractAddress) throw new Error('Informe o endereço do contrato primeiro.');
    if (!this.wallet && !(dryRun && this.contractInfo)) throw new Error('Carregue a burner wallet primeiro.');
    if (this.busy) {
      this.log('warn', 'Já existe uma operação em andamento — aguarde.');
      return { ok: false, stage: 'ocupado', reason: 'ocupado' };
    }
    this.busy = true;
    try {
      const E = this.engine.E;
      const provider = this.engine.rpc.provider;
      // Sem burner, a simulação (eth_call) é feita "como se fosse" o dono — não precisa assinar nada.
      const signer = this.wallet ? this.wallet.connect(provider) : new E.VoidSigner(this.contractInfo.owner, provider);
      const contract = new E.Contract(this.contractAddress, C.ABI.arb, signer);
      this.stats.simulations += 1;
      this.log('info', `${dryRun ? '🔎 Simulando' : source === 'auto' ? '🤖 Executando' : '⚡ Executando'} ${opp.pairLabel}: ${opp.buy.label} → ${opp.sell.label} (estimado ${opp.netUsd >= 0 ? '+' : ''}$${opp.netUsd.toFixed(2)})`);
      const result = await executeArb(E, contract, opp, {
        minProfitUsd: this.settings.minProfitUsd,
        dryRun,
        blockTs: this.engine.state.blockTs,
        overrides: this.engine.feeOverrides(this.settings.priorityBoostPct),
        onSent: (hash) => {
          this.stats.sent += 1;
          this.log('tx', `Transação enviada: ${hash}`, { hash, link: C.txLink(hash) });
          this.emit('tx', { hash, status: 'enviada', oppId: opp.id, link: C.txLink(hash) });
        },
      });
      this._afterExecution(opp, result, dryRun);
      return result;
    } finally {
      this.busy = false;
    }
  }

  _afterExecution(opp, r, dryRun) {
    const E = this.engine.E;
    const base = C.TOKENS[opp.base];
    if (r.receipt && r.receipt.fee != null) this.stats.gasSpentWei += BigInt(r.receipt.fee);
    const extra = r.hash ? { hash: r.hash, link: C.txLink(r.hash) } : {};
    if (!r.ok) {
      if (r.stage === 'simulacao') {
        this.stats.simFailed += 1;
        this.cooldown.set(opp.id, (this.lastResult ? this.lastResult.block : 0) + 3);
      }
      if (r.stage === 'revertida') this.stats.reverted += 1;
      this.log(r.stage === 'simulacao' ? 'warn' : 'error', `${STAGE_LABEL[r.stage] || r.stage}: ${r.reason}${r.stage === 'simulacao' ? ' (nada foi enviado, zero gás gasto)' : ''}`, extra);
    } else if (dryRun) {
      const amount = Number(E.formatUnits(r.profit, base.decimals));
      this.log('ok', `Simulação OK no bloco atual: lucro on-chain = ${amount} ${base.symbol} (≈ $${(amount * opp.basePrice).toFixed(2)}, antes do gás)`);
    } else {
      this.stats.success += 1;
      const amount = Number(E.formatUnits(r.profit || 0n, base.decimals));
      const usd = amount * opp.basePrice;
      this.stats.profitUsd += usd;
      this.log('ok', `✅ LUCRO de ${amount} ${base.symbol} (≈ $${usd.toFixed(2)}) enviado para a carteira dona`, extra);
    }
    this.emit('tx', { hash: r.hash || null, status: r.ok ? (dryRun ? 'simulada' : 'confirmada') : r.stage, oppId: opp.id, reason: r.reason || null, link: r.hash ? C.txLink(r.hash) : null });
    this.emit('stats', this.publicStats());
  }
}

/** Converte BigInt em string para logs/JSON (postMessage aceita BigInt, JSON não). */
export function serializable(obj) {
  return JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
