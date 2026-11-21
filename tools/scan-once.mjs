// Teste AO VIVO (somente leitura) do scanner contra a Polygon real, usando RPCs públicos.
// Confere endereços, decimais dos tokens, ABIs das DEXs (Uniswap V3 QuoterV2, Algebra, V2),
// leitura da Aave (taxa, status, liquidez) e o cálculo das oportunidades.
// Uso: npm install && node tools/scan-once.mjs

import { ethers } from 'ethers';
import { setEthers } from '../js/eth.js';
import { ArbRunner } from '../js/runner.js';
import * as C from '../js/config.js';

setEthers(ethers);

const rpcUrls = process.env.RPC_URLS ? process.env.RPC_URLS.split(',') : C.DEFAULT_RPCS;
const runner = new ArbRunner({
  settings: { rpcUrls, pairsPerScan: 12, minProfitUsd: 2, loanUsd: 10000 },
  emit: (type, d) => {
    if (type === 'log' && d.level !== 'scan') console.log(`[${d.level}] ${d.msg}`);
  },
});

const failures = [];
const check = (cond, msg) => {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failures.push(msg);
  }
};

await runner.init();
const engine = runner.engine;
console.log('\nRPCs:');
for (const n of engine.rpc.status()) console.log(`  ${n.ok ? '●' : '○'} ${n.url} ${n.latency != null ? `${n.latency} ms` : n.lastError || ''}`);

// 1) Tokens: os decimais on-chain precisam bater com o config
const erc20 = new ethers.Interface(C.ABI.erc20);
const tokenCalls = [];
for (const t of Object.values(C.TOKENS)) {
  tokenCalls.push({ target: t.address, callData: erc20.encodeFunctionData('symbol', []), decode: (d) => erc20.decodeFunctionResult('symbol', d)[0] });
  tokenCalls.push({ target: t.address, callData: erc20.encodeFunctionData('decimals', []), decode: (d) => Number(erc20.decodeFunctionResult('decimals', d)[0]) });
}
const meta = await engine.multicall(tokenCalls);
console.log('\nTokens:');
Object.values(C.TOKENS).forEach((t, i) => {
  const symbol = meta[i * 2];
  const decimals = meta[i * 2 + 1];
  check(decimals === t.decimals, `${t.key.padEnd(7)} ${t.address} symbol=${symbol} decimals=${decimals} (esperado ${t.decimals})`);
});

// 2) Três varreduras = os 36 pares
console.log('\nVarrendo todos os pares…');
const results = [];
for (let i = 0; i < Math.ceil(runner.settings.pairIds.length / runner.settings.pairsPerScan); i++) {
  results.push(await runner.scanOnce());
}
const last = results[results.length - 1];

check(last.premiumFromChain, `Taxa do flash loan lida on-chain: ${last.premiumBps} bps (${(last.premiumBps / 100).toFixed(2)}%)`);
check(last.polUsd > 0, `Preço do POL on-chain: $${last.polUsd}`);
console.log('Preços:', Object.fromEntries(Object.entries(last.prices).map(([k, v]) => [k, Number(v.toPrecision(6))])));
console.log('Gás:', `${last.gasPriceGwei.toFixed(1)} gwei (base ${last.baseFeeGwei.toFixed(1)} + gorjeta ${last.tipGwei.toFixed(1)})`);

console.log('\nAave V3 (flash loan):');
for (const [k, a] of Object.entries(last.aave)) {
  console.log(`  ${k.padEnd(7)} ${a.canFlash ? 'OK      ' : 'BLOQUEADO'} ativo=${a.active} pausado=${a.paused} congelado=${a.frozen} flash=${a.flashEnabled} disponível≈${a.availableHuman != null ? Math.round(a.availableHuman).toLocaleString('en-US') : '?'}`);
}
check(Object.keys(last.aave).length > 0, 'Leitura das reservas da Aave');

const health = {};
for (const r of results) {
  for (const [id, h] of Object.entries(r.dexHealth)) {
    const acc = (health[id] = health[id] || { ok: 0, total: 0 });
    acc.ok += h.ok;
    acc.total += h.total;
  }
}
console.log('\nCotações por DEX (compra, todos os pares):');
for (const d of C.DEXES.filter((x) => runner.settings.dexIds.includes(x.id))) {
  const h = health[d.id] || { ok: 0, total: 0 };
  check(h.ok > 0, `${d.name.padEnd(13)} ${h.ok}/${h.total} cotações com retorno`);
}

const board = [...runner.board.values()].sort((a, b) => b.netUsd - a.netUsd);
check(board.length > 0, `Rotas avaliadas: ${board.length}`);
console.log('\nMelhor rota de cada par (empréstimo de $10.000):');
const bestPerPair = new Map();
for (const o of board) if (!bestPerPair.has(o.pairId)) bestPerPair.set(o.pairId, o);
for (const o of bestPerPair.values()) {
  console.log(`  ${o.pairLabel.padEnd(16)} ${`${o.buy.label} → ${o.sell.label}`.padEnd(28)} spread ${o.spreadPct.toFixed(4).padStart(8)}%  líquido ${o.netUsd >= 0 ? '+' : ''}${o.netUsd.toFixed(2)} USD${o.aaveOk ? '' : `  [${o.aaveNote}]`}`);
}
const routes = results.reduce((s, r) => s + r.routes, 0);
const ms = results.map((r) => r.durationMs);
console.log(`\n${routes} rotas em ${results.length} varreduras · tempo por varredura: ${ms.join(' / ')} ms`);

if (failures.length) {
  console.error(`\n${failures.length} verificação(ões) falharam.`);
  process.exit(1);
}
console.log('\nScanner ao vivo OK.');
process.exit(0);
