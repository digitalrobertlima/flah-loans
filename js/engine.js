// ════════════════════════════════════════════════════════════════════════════
//  Motor de arbitragem: cotações on-chain, cálculo de viabilidade e execução.
//  Sem DOM: roda no navegador, no Web Worker e no Node.js (robô no VPS e testes).
// ════════════════════════════════════════════════════════════════════════════

import { loadEthers } from './eth.js';
import { RpcPool, shortError, isRevert } from './rpc.js';
import * as C from './config.js';

const CHUNK = 30; // chamadas por eth_call (Multicall3) — RPCs públicos não gostam de chamadas gigantes
const SLOW_REFRESH_BLOCKS = 15; // a cada ~30 s relê taxa da Aave, liquidez, preços e gás
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ─── utilidades de decodificação ────────────────────────────────────────────

export function firstWord(data) {
  if (typeof data !== 'string' || data.length < 66) return null;
  return BigInt(data.slice(0, 66));
}

function word(data, i) {
  const start = 2 + 64 * i;
  if (typeof data !== 'string' || data.length < start + 64) return null;
  return BigInt('0x' + data.slice(start, start + 64));
}

function addressFromWord(w) {
  return '0x' + (w & ((1n << 160n) - 1n)).toString(16).padStart(40, '0');
}

function bit(value, n) {
  return ((value >> BigInt(n)) & 1n) === 1n;
}

/** Bits da configuração de reserva da Aave V3 (ReserveConfiguration.sol) */
export function decodeReserveConfig(cfg) {
  const active = bit(cfg, 56);
  const frozen = bit(cfg, 57);
  const paused = bit(cfg, 60);
  const flashEnabled = bit(cfg, 63);
  return { active, frozen, paused, flashEnabled, canFlash: active && !paused && flashEnabled };
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function toUnits(E, value, decimals) {
  const safe = Math.max(0, Number(value) || 0);
  return E.parseUnits(safe.toFixed(Math.min(decimals, 8)), decimals);
}

function toUnitsCeil(E, value, decimals) {
  return toUnits(E, value, decimals) + 1n;
}

export function feeLabel(fee) {
  return `${(fee / 10000).toString()}%`;
}

/** Lista de "lugares" onde dá para trocar: cada faixa de taxa da Uniswap V3 conta como um. */
export function buildVenues(dexIds) {
  const venues = [];
  for (const id of dexIds) {
    const dex = C.findDex(id);
    if (!dex) continue;
    if (dex.kind === 0) {
      for (const fee of dex.fees) venues.push({ key: `${dex.id}:${fee}`, dex, fee, label: `${dex.short} ${feeLabel(fee)}` });
    } else {
      venues.push({ key: dex.id, dex, fee: 0, label: dex.short });
    }
  }
  return venues;
}

/** Para cada DEX, a melhor compra (na Uniswap V3, a melhor faixa de taxa). */
function bestBuyPerDex(buys) {
  const best = new Map();
  for (const b of buys) {
    if (b.out == null || b.out <= 0n) continue;
    const cur = best.get(b.venue.dex.id);
    if (!cur || b.out > cur.out) best.set(b.venue.dex.id, b);
  }
  return [...best.values()];
}

// ─── erros e resultado de transações ────────────────────────────────────────

export function revertReason(E, err) {
  if (!err) return 'erro desconhecido';
  if (err.reason) return String(err.reason);
  if (err.revert && err.revert.args && err.revert.args.length) return String(err.revert.args[0]);
  const candidates = [err.data, err.info && err.info.error && err.info.error.data, err.error && err.error.data];
  for (const c of candidates) {
    const data = typeof c === 'string' ? c : c && typeof c.data === 'string' ? c.data : null;
    if (data && data.startsWith('0x08c379a0')) {
      try {
        return E.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
      } catch (_) {
        /* segue */
      }
    }
  }
  return shortError(err);
}

function slimReceipt(r) {
  if (!r) return null;
  const fee = r.fee != null ? r.fee : r.gasUsed != null && r.gasPrice != null ? r.gasUsed * r.gasPrice : null;
  return { blockNumber: r.blockNumber, gasUsed: r.gasUsed, fee, status: r.status };
}

export function parseProfit(E, receipt) {
  if (!receipt || !receipt.logs) return null;
  const iface = new E.Interface(C.ABI.arb);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed && parsed.name === 'ArbitrageExecuted') return parsed.args.profit;
    } catch (_) {
      /* outro evento */
    }
  }
  return null;
}

/**
 * Monta os argumentos de executeArbitrage(asset, amount, params) a partir de uma oportunidade.
 * minProfit on-chain = custo estimado do gás + lucro mínimo desejado (convertidos para o token).
 * Assim a transação só passa se, descontado o gás, sobrar pelo menos o seu lucro mínimo.
 */
export function buildArbCall(E, opp, { minProfitUsd = 0, simulateOnly = false, blockTs = 0 } = {}) {
  const base = C.TOKENS[opp.base];
  const mid = C.TOKENS[opp.mid];
  let minProfit = 0n;
  if (!simulateOnly) {
    const usd = Math.max(0, (opp.gasUsd || 0) + (minProfitUsd || 0));
    minProfit = toUnitsCeil(E, usd / opp.basePrice, base.decimals);
  }
  const nowTs = Math.max(Number(blockTs) || 0, Math.floor(Date.now() / 1000));
  const deadline = BigInt(nowTs + 90);
  const params = {
    tokenMid: mid.address,
    buy: { kind: opp.buy.kind, router: opp.buy.router, fee: opp.buy.fee },
    sell: { kind: opp.sell.kind, router: opp.sell.router, fee: opp.sell.fee },
    minProfit,
    deadline,
  };
  return { args: [base.address, opp.amountIn, params], minProfit, deadline };
}

/**
 * 1) Simula (eth_call) — se reverter, NADA é enviado e nenhum gás é gasto.
 * 2) Estima gás  3) Envia  4) Espera confirmação e lê o lucro do evento.
 * @param contract ethers.Contract conectado a um signer (burner wallet ou Rabby/MetaMask)
 */
export async function executeArb(E, contract, opp, opts = {}) {
  const { minProfitUsd = 0, dryRun = false, overrides = null, waitTimeoutMs = 120000, onSent = null, blockTs = 0 } = opts;
  const { args } = buildArbCall(E, opp, { minProfitUsd, simulateOnly: dryRun, blockTs });

  let simulated;
  try {
    simulated = await contract.executeArbitrage.staticCall(...args);
  } catch (err) {
    return { ok: false, stage: 'simulacao', reason: revertReason(E, err) };
  }
  if (dryRun) return { ok: true, stage: 'simulacao', profit: simulated };

  let gasLimit;
  try {
    const est = await contract.executeArbitrage.estimateGas(...args);
    gasLimit = (est * BigInt(C.GAS.LIMIT_MULTIPLIER_PCT)) / 100n;
  } catch (err) {
    return { ok: false, stage: 'estimativa', reason: revertReason(E, err) };
  }

  let tx;
  try {
    tx = await contract.executeArbitrage(...args, { gasLimit, ...(overrides || {}) });
  } catch (err) {
    return { ok: false, stage: 'envio', reason: revertReason(E, err) };
  }
  if (onSent) onSent(tx.hash);

  try {
    const receipt = await tx.wait(1, waitTimeoutMs);
    const profit = parseProfit(E, receipt) ?? simulated;
    return { ok: receipt.status === 1, stage: 'confirmada', hash: tx.hash, receipt: slimReceipt(receipt), profit, simulated, gasLimit };
  } catch (err) {
    const receipt = err && err.receipt ? slimReceipt(err.receipt) : null;
    return { ok: false, stage: receipt ? 'revertida' : 'confirmacao', hash: tx.hash, reason: revertReason(E, err), receipt };
  }
}

// ─── Motor ──────────────────────────────────────────────────────────────────

export class Engine {
  constructor(E, rpc, { log = () => {} } = {}) {
    this.E = E;
    this.rpc = rpc;
    this.log = log;
    this.I = {
      mc: new E.Interface(C.ABI.multicall3),
      quoterV2: new E.Interface(C.ABI.quoterV2),
      algebra: new E.Interface(C.ABI.algebraQuoter),
      v2: new E.Interface(C.ABI.v2Router),
      aave: new E.Interface(C.ABI.aavePool),
      erc20: new E.Interface(C.ABI.erc20),
      arb: new E.Interface(C.ABI.arb),
    };
    this.state = {
      premiumBps: 5n, // 0,05% (valor real é lido on-chain em FLASHLOAN_PREMIUM_TOTAL)
      premiumFromChain: false,
      prices: {},
      polUsd: null,
      aave: {},
      tipWei: E.parseUnits(String(C.GAS.MIN_PRIORITY_GWEI), 'gwei'),
      feeData: null,
      lastSlowAt: 0,
      lastSlowBlock: 0,
      block: 0,
      blockTs: 0,
      baseFeeWei: 0n,
    };
  }

  static async create({ rpcUrls, onRpcEvent, log, timeoutMs } = {}) {
    const E = await loadEthers();
    const rpc = new RpcPool(E, rpcUrls && rpcUrls.length ? rpcUrls : C.DEFAULT_RPCS, { timeoutMs, onEvent: onRpcEvent });
    await rpc.probe();
    return new Engine(E, rpc, { log });
  }

  async setRpcs(urls, onRpcEvent) {
    this.rpc = new RpcPool(this.E, urls, { onEvent: onRpcEvent });
    await this.rpc.probe();
  }

  /** Executa várias leituras num único eth_call (Multicall3.aggregate3 com allowFailure). */
  async multicall(calls, blockTag = 'latest') {
    if (!calls.length) return [];
    const chunks = [];
    for (let i = 0; i < calls.length; i += CHUNK) chunks.push(calls.slice(i, i + CHUNK));
    const parts = await Promise.all(
      chunks.map((chunk) =>
        this.rpc.run('multicall', async (provider) => {
          const data = this.I.mc.encodeFunctionData('aggregate3', [chunk.map((c) => [c.target, true, c.callData])]);
          let raw;
          try {
            raw = await provider.call({ to: C.ADDR.MULTICALL3, data, blockTag });
          } catch (err) {
            if (blockTag === 'latest' || isRevert(err)) throw err;
            raw = await provider.call({ to: C.ADDR.MULTICALL3, data }); // nó atrasado: usa o último bloco
          }
          const [results] = this.I.mc.decodeFunctionResult('aggregate3', raw);
          return results.map((r) => ({ success: r[0], data: r[1] }));
        }),
      ),
    );
    return parts.flat().map((r, i) => {
      if (!r || !r.success) return null;
      try {
        return calls[i].decode ? calls[i].decode(r.data) : r.data;
      } catch (_) {
        return null;
      }
    });
  }

  /** Monta a chamada de cotação (sem executar nada) para uma DEX. */
  quoteCall(venue, tokenIn, tokenOut, amountIn) {
    const dex = venue.dex;
    if (dex.kind === 0) {
      return {
        target: dex.quoter,
        callData: this.I.quoterV2.encodeFunctionData('quoteExactInputSingle', [[tokenIn, tokenOut, amountIn, venue.fee, 0n]]),
        decode: firstWord,
      };
    }
    if (dex.kind === 2) {
      return {
        target: dex.quoter,
        callData: this.I.algebra.encodeFunctionData('quoteExactInputSingle', [tokenIn, tokenOut, amountIn, 0n]),
        decode: firstWord,
      };
    }
    return {
      target: dex.router,
      callData: this.I.v2.encodeFunctionData('getAmountsOut', [amountIn, [tokenIn, tokenOut]]),
      decode: (data) => {
        const [amounts] = this.I.v2.decodeFunctionResult('getAmountsOut', data);
        return amounts[amounts.length - 1];
      },
    };
  }

  /** Dados que mudam devagar: taxa da Aave, status/liquidez das reservas, preços em US$ e gás. */
  async slowRefresh(settings) {
    const E = this.E;
    const pairs = C.resolvePairs(settings.pairIds, settings.extraPairs);
    const bases = [...new Set(pairs.map((p) => p.base))];
    const priced = [...new Set([...pairs.map((p) => p.base), ...pairs.map((p) => p.mid), 'WPOL', 'WETH', 'WBTC'])].filter(
      (k) => C.TOKENS[k] && !C.TOKENS[k].stable,
    );
    const usd = C.TOKENS[C.USD_REF];
    const priceVenues = buildVenues(['univ3', 'quickv3', 'quickv2']).filter((v) => v.dex.kind !== 0 || v.fee === 500 || v.fee === 3000);

    const calls = [];
    const tags = [];
    calls.push({ target: C.ADDR.AAVE_POOL, callData: this.I.aave.encodeFunctionData('FLASHLOAN_PREMIUM_TOTAL', []), decode: firstWord });
    tags.push({ t: 'premium' });
    for (const b of bases) {
      calls.push({ target: C.ADDR.AAVE_POOL, callData: this.I.aave.encodeFunctionData('getReserveData', [C.TOKENS[b].address]), decode: (d) => d });
      tags.push({ t: 'reserve', key: b });
    }
    for (const k of priced) {
      const tok = C.TOKENS[k];
      const one = 10n ** BigInt(tok.decimals);
      for (const v of priceVenues) {
        calls.push(this.quoteCall(v, tok.address, usd.address, one));
        tags.push({ t: 'price', key: k });
      }
    }

    const res = await this.multicall(calls);
    const quotes = {};
    res.forEach((r, i) => {
      const tag = tags[i];
      if (r == null) return;
      if (tag.t === 'premium') {
        this.state.premiumBps = r;
        this.state.premiumFromChain = true;
      } else if (tag.t === 'reserve') {
        const cfg = word(r, 0);
        const aTokenWord = word(r, 8);
        if (cfg == null || aTokenWord == null) return;
        const prev = this.state.aave[tag.key] || {};
        this.state.aave[tag.key] = { ...decodeReserveConfig(cfg), aToken: addressFromWord(aTokenWord), available: prev.available ?? null };
      } else if (tag.t === 'price') {
        const v = Number(E.formatUnits(r, usd.decimals));
        if (v > 0) (quotes[tag.key] = quotes[tag.key] || []).push(v);
      }
    });
    for (const [k, tok] of Object.entries(C.TOKENS)) if (tok.stable) this.state.prices[k] = 1;
    for (const [k, list] of Object.entries(quotes)) {
      const m = median(list);
      if (m) this.state.prices[k] = m;
    }
    if (this.state.prices.WPOL) this.state.polUsd = this.state.prices.WPOL;

    // Liquidez disponível para flash loan = saldo do token guardado no aToken
    const balCalls = [];
    const balKeys = [];
    for (const b of bases) {
      const a = this.state.aave[b];
      if (!a || !a.aToken) continue;
      balCalls.push({ target: C.TOKENS[b].address, callData: this.I.erc20.encodeFunctionData('balanceOf', [a.aToken]), decode: firstWord });
      balKeys.push(b);
    }
    const bals = await this.multicall(balCalls);
    bals.forEach((v, i) => {
      if (v != null) this.state.aave[balKeys[i]].available = v;
    });

    // Gás: provider.getFeeData() + piso de gorjeta da Polygon
    try {
      const fd = await this.rpc.run('feeData', (p) => p.getFeeData());
      this.state.feeData = { gasPrice: fd.gasPrice, maxFeePerGas: fd.maxFeePerGas, maxPriorityFeePerGas: fd.maxPriorityFeePerGas };
      const minTip = E.parseUnits(String(C.GAS.MIN_PRIORITY_GWEI), 'gwei');
      const tip = fd.maxPriorityFeePerGas != null ? fd.maxPriorityFeePerGas : minTip;
      this.state.tipWei = tip > minTip ? tip : minTip;
    } catch (err) {
      this.log('warn', `getFeeData falhou: ${shortError(err)}`);
    }

    this.state.lastSlowAt = Date.now();
    this.state.lastSlowBlock = this.state.block;
  }

  gasPriceWei() {
    if (this.state.baseFeeWei > 0n) return this.state.baseFeeWei + this.state.tipWei;
    if (this.state.feeData && this.state.feeData.gasPrice) return this.state.feeData.gasPrice;
    return this.state.tipWei;
  }

  feeOverrides(boostPct = 100) {
    const tip = (this.state.tipWei * BigInt(Math.max(50, Math.round(boostPct)))) / 100n;
    const base = this.state.baseFeeWei > 0n ? this.state.baseFeeWei : this.state.feeData && this.state.feeData.gasPrice ? this.state.feeData.gasPrice : 0n;
    return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
  }

  aaveSnapshot() {
    const out = {};
    for (const [k, a] of Object.entries(this.state.aave)) {
      const tok = C.TOKENS[k];
      out[k] = {
        ...a,
        availableHuman: a.available != null ? Number(this.E.formatUnits(a.available, tok.decimals)) : null,
      };
    }
    return out;
  }

  /**
   * Uma varredura completa:
   *  Rodada 1 — quanto de `mid` cada DEX entrega pelo valor do empréstimo (compra).
   *  Rodada 2 — quanto de `base` as OUTRAS DEXs devolvem por esse `mid` (venda).
   *  Depois: taxa da Aave + gás (em US$) => lucro líquido e spread de cada rota.
   */
  async scan(settings, subsetIds = null) {
    const E = this.E;
    const t0 = now();
    const pairs = C.resolvePairs(subsetIds || settings.pairIds, settings.extraPairs);
    const venues = buildVenues(settings.dexIds);
    if (!pairs.length) throw new Error('Selecione pelo menos um par.');
    if (venues.length < 2) throw new Error('Selecione pelo menos duas DEXs.');

    const stale = !this.state.lastSlowAt || this.state.block - this.state.lastSlowBlock >= SLOW_REFRESH_BLOCKS || Date.now() - this.state.lastSlowAt > 60000;
    if (stale) await this.slowRefresh(settings);

    // ── Rodada 1 ──
    const MC = C.ADDR.MULTICALL3;
    const calls1 = [
      { target: MC, callData: this.I.mc.encodeFunctionData('getBlockNumber', []), decode: firstWord },
      { target: MC, callData: this.I.mc.encodeFunctionData('getCurrentBlockTimestamp', []), decode: firstWord },
      { target: MC, callData: this.I.mc.encodeFunctionData('getBasefee', []), decode: firstWord },
    ];
    const pairStates = [];
    for (const pair of pairs) {
      const base = C.TOKENS[pair.base];
      const mid = C.TOKENS[pair.mid];
      const basePrice = this.state.prices[pair.base];
      if (!base || !mid || !basePrice) continue;
      const amountIn = toUnits(E, settings.loanUsd / basePrice, base.decimals);
      if (amountIn <= 0n) continue;
      const ps = { pair, base, mid, basePrice, amountIn, buys: [] };
      for (const venue of venues) {
        ps.buys.push({ venue, idx: calls1.length, out: null });
        calls1.push(this.quoteCall(venue, base.address, mid.address, amountIn));
      }
      pairStates.push(ps);
    }
    const r1 = await this.multicall(calls1, 'latest');
    const block = Number(r1[0] || 0n);
    const blockTs = Number(r1[1] || 0n);
    if (block) {
      this.state.block = block;
      this.state.blockTs = blockTs;
      if (r1[2] != null) this.state.baseFeeWei = r1[2];
    }

    const dexHealth = {};
    for (const ps of pairStates) {
      for (const b of ps.buys) {
        b.out = r1[b.idx];
        const h = (dexHealth[b.venue.dex.id] = dexHealth[b.venue.dex.id] || { ok: 0, total: 0 });
        h.total += 1;
        if (b.out != null && b.out > 0n) h.ok += 1;
      }
    }

    // ── Rodada 2 ──
    const calls2 = [];
    const routes = [];
    for (const ps of pairStates) {
      for (const buy of bestBuyPerDex(ps.buys)) {
        for (const sell of venues) {
          if (sell.key === buy.venue.key) continue;
          if (sell.dex.id === buy.venue.dex.id && !(sell.dex.kind === 0 && settings.crossFeeTiers)) continue;
          routes.push({ ps, buy, sell, idx: calls2.length });
          calls2.push(this.quoteCall(sell, ps.mid.address, ps.base.address, buy.out));
        }
      }
    }
    const r2 = await this.multicall(calls2, block || 'latest');

    // ── Economia de cada rota ──
    const gasPrice = this.gasPriceWei();
    const polUsd = this.state.polUsd || 0;
    const opportunities = [];
    for (const rt of routes) {
      const finalOut = r2[rt.idx];
      if (finalOut == null) continue;
      const { ps, buy, sell } = rt;
      const amountIn = ps.amountIn;
      const dec = ps.base.decimals;
      const gross = finalOut - amountIn;
      const premium = (amountIn * this.state.premiumBps + 5000n) / 10000n; // mesmo arredondamento da Aave (percentMul)
      const netToken = gross - premium;
      const gasUnits = C.GAS.BASE + buy.venue.dex.legGas + sell.dex.legGas;
      const gasCostWei = BigInt(gasUnits) * gasPrice;
      const gasUsd = Number(E.formatEther(gasCostWei)) * polUsd;
      const grossUsd = Number(E.formatUnits(gross, dec)) * ps.basePrice;
      const premiumUsd = Number(E.formatUnits(premium, dec)) * ps.basePrice;
      const netUsd = Number(E.formatUnits(netToken, dec)) * ps.basePrice - gasUsd;
      const spreadPct = Number((gross * 1000000n) / amountIn) / 10000;

      const aave = this.state.aave[ps.pair.base];
      let aaveOk = true;
      let aaveNote = '';
      if (aave && !aave.canFlash) {
        aaveOk = false;
        aaveNote = 'Flash loan indisponível na Aave para este ativo';
      } else if (aave && aave.available != null && aave.available < amountIn) {
        aaveOk = false;
        aaveNote = 'Liquidez da Aave menor que o valor do empréstimo';
      }

      opportunities.push({
        id: `${ps.pair.id}|${buy.venue.key}>${sell.key}`,
        block,
        pairId: ps.pair.id,
        pairLabel: ps.pair.label || `${ps.pair.base} / ${ps.pair.mid}`,
        base: ps.pair.base,
        mid: ps.pair.mid,
        buy: { key: buy.venue.key, label: buy.venue.label, dexId: buy.venue.dex.id, kind: buy.venue.dex.kind, router: buy.venue.dex.router, fee: buy.venue.fee },
        sell: { key: sell.key, label: sell.label, dexId: sell.dex.id, kind: sell.dex.kind, router: sell.dex.router, fee: sell.fee },
        amountIn,
        midOut: buy.out,
        finalOut,
        gross,
        premium,
        netToken,
        gasUnits,
        gasCostWei,
        basePrice: ps.basePrice,
        loanUsd: Number(E.formatUnits(amountIn, dec)) * ps.basePrice,
        grossUsd,
        premiumUsd,
        gasUsd,
        netUsd,
        spreadPct,
        aaveOk,
        aaveNote,
        executable: aaveOk && netToken > 0n && netUsd >= settings.minProfitUsd,
      });
    }
    opportunities.sort((a, b) => b.netUsd - a.netUsd);

    return {
      block,
      blockTs,
      pairIds: pairs.map((p) => p.id),
      durationMs: Math.round(now() - t0),
      quotes: calls1.length - 3 + calls2.length,
      routes: opportunities.length,
      rpc: this.rpc.url,
      polUsd,
      prices: { ...this.state.prices },
      gasPriceGwei: Number(E.formatUnits(gasPrice, 'gwei')),
      baseFeeGwei: Number(E.formatUnits(this.state.baseFeeWei, 'gwei')),
      tipGwei: Number(E.formatUnits(this.state.tipWei, 'gwei')),
      premiumBps: Number(this.state.premiumBps),
      premiumFromChain: this.state.premiumFromChain,
      aave: this.aaveSnapshot(),
      dexHealth,
      opportunities,
    };
  }

  /** Lê o estado do contrato implantado (dono, executores, routers permitidos). */
  async contractStatus(address, account) {
    const E = this.E;
    if (!address || !E.isAddress(address)) return { ok: false, error: 'Endereço inválido' };
    const code = await this.rpc.run('getCode', (p) => p.getCode(address));
    if (!code || code === '0x') return { ok: false, error: 'Não existe contrato neste endereço na Polygon.' };
    const I = this.I.arb;
    const calls = [
      { target: address, callData: I.encodeFunctionData('owner', []), decode: (d) => I.decodeFunctionResult('owner', d)[0] },
      { target: address, callData: I.encodeFunctionData('totalTrades', []), decode: firstWord },
    ];
    if (account) calls.push({ target: address, callData: I.encodeFunctionData('isExecutor', [account]), decode: (d) => I.decodeFunctionResult('isExecutor', d)[0] });
    for (const d of C.DEXES) {
      calls.push({ target: address, callData: I.encodeFunctionData('routerAllowed', [d.router]), decode: (x) => I.decodeFunctionResult('routerAllowed', x)[0] });
    }
    const r = await this.multicall(calls);
    if (r[0] == null) return { ok: false, error: 'Esse contrato não parece ser o FlashArbitragePolygon (owner() falhou).' };
    let k = 2;
    let isExecutor = null;
    if (account) {
      isExecutor = !!r[k];
      k += 1;
    }
    const routers = {};
    C.DEXES.forEach((d, i) => {
      routers[d.id] = !!r[k + i];
    });
    const owner = E.getAddress(r[0]);
    const isOwner = account ? owner.toLowerCase() === account.toLowerCase() : null;
    return { ok: true, address: E.getAddress(address), owner, totalTrades: r[1] ?? 0n, isExecutor, isOwner, authorized: !!(isOwner || isExecutor), routers };
  }
}
