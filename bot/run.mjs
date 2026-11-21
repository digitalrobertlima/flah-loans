#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  Robô headless (opcional) — o MESMO motor do PWA rodando em Node.js,
//  para deixar 24h ligado num VPS (ex.: Oracle Cloud Always Free).
//
//  Instalação (uma vez):   npm install
//  Só observar:            node bot/run.mjs
//  Executar sozinho:       ARB_CONTRACT=0x... BURNER_KEY=0x... AUTO=1 node bot/run.mjs
//
//  Variáveis (todas opcionais):
//    ARB_CONTRACT        endereço do FlashArbitragePolygon implantado
//    BURNER_KEY          chave privada da burner wallet (NUNCA a da sua carteira principal)
//    AUTO=1              liga o piloto automático
//    LOAN_USD            valor do flash loan em US$ (padrão 10000)
//    MIN_PROFIT_USD      lucro líquido mínimo em US$ (padrão 2)
//    INTERVAL_MS         intervalo entre checagens de bloco (padrão 2500)
//    PAIRS_PER_SCAN      pares cotados por bloco (padrão 8)
//    GAS_CAP_POL         teto de gás por sessão em POL (padrão 2)
//    PRIORITY_BOOST_PCT  gorjeta em % da sugerida (padrão 100)
//    RPC_URLS            lista separada por vírgula (padrão: RPCs públicos do config.js)
//    PAIRS / DEXES       ids separados por vírgula (ex.: PAIRS=USDC-WETH,USDC-WPOL)
//    QUIET=1             não imprime uma linha por bloco
// ════════════════════════════════════════════════════════════════════════════

import { ArbRunner } from '../js/runner.js';
import { DEFAULT_SETTINGS } from '../js/config.js';

const env = process.env;
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

const settings = {
  loanUsd: num(env.LOAN_USD, DEFAULT_SETTINGS.loanUsd),
  minProfitUsd: num(env.MIN_PROFIT_USD, DEFAULT_SETTINGS.minProfitUsd),
  intervalMs: num(env.INTERVAL_MS, DEFAULT_SETTINGS.intervalMs),
  pairsPerScan: num(env.PAIRS_PER_SCAN, DEFAULT_SETTINGS.pairsPerScan),
  gasCapPol: num(env.GAS_CAP_POL, DEFAULT_SETTINGS.gasCapPol),
  priorityBoostPct: num(env.PRIORITY_BOOST_PCT, DEFAULT_SETTINGS.priorityBoostPct),
};
if (list(env.RPC_URLS)) settings.rpcUrls = list(env.RPC_URLS);
if (list(env.PAIRS)) settings.pairIds = list(env.PAIRS);
if (list(env.DEXES)) settings.dexIds = list(env.DEXES);

const quiet = env.QUIET === '1';
const COLORS = { info: 36, ok: 32, warn: 33, error: 31, tx: 35, scan: 90 };
const useColor = process.stdout.isTTY;

function print(entry) {
  if (quiet && entry.level === 'scan') return;
  const t = new Date(entry.time).toISOString().replace('T', ' ').slice(0, 19);
  const tag = entry.level.toUpperCase().padEnd(5);
  const line = `${t} ${tag} ${entry.msg}${entry.link ? `  ${entry.link}` : ''}`;
  console.log(useColor ? `\x1b[${COLORS[entry.level] || 0}m${line}\x1b[0m` : line);
}

const runner = new ArbRunner({
  settings,
  emit: (type, data) => {
    if (type === 'log') print(data);
  },
});

await runner.init();
if (env.ARB_CONTRACT) await runner.setContract(env.ARB_CONTRACT);
if (env.BURNER_KEY) await runner.setBurner(env.BURNER_KEY);
runner.start();
if (env.AUTO === '1') runner.setAuto(true);
else print({ level: 'info', time: Date.now(), msg: 'Modo observação. Use AUTO=1 (com ARB_CONTRACT e BURNER_KEY) para executar sozinho.' });

// resumo a cada 10 minutos
setInterval(() => {
  const s = runner.publicStats();
  print({
    level: 'info',
    time: Date.now(),
    msg: `Resumo: ${s.blocks} blocos · ${s.quotes} cotações · ${s.greens} verdes · ${s.sent} txs · ${s.success} sucessos · lucro real $${s.profitUsd.toFixed(2)} · simulado $${s.paperUsd.toFixed(2)} · gás ${s.gasSpentPol.toFixed(4)} POL`,
  });
}, 10 * 60 * 1000).unref();

function shutdown() {
  runner.stop();
  console.log(JSON.stringify(runner.publicStats()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
