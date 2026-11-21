// Teste ponta a ponta: contrato + motor do PWA num FORK da Polygon (anvil).
//
//   anvil --fork-url https://polygon-bor-rpc.publicnode.com &
//   forge build && node tools/e2e-fork.mjs
//
// Roteiro:
//  1. Implanta o FlashArbitragePolygon e autoriza uma burner.
//  2. Uma "baleia" despeja WPOL na QuickSwap V2 (cria uma distorção de preço real no fork).
//  3. O scanner do PWA precisa ENCONTRAR a oportunidade sozinho (rota verde).
//  4. Simula, executa com a burner e confere que o lucro chegou na carteira DONA.
//  5. Rota ruim: a simulação precisa ser barrada com "Sem lucro liquido" (nada enviado).
//  6. Nova distorção + piloto automático ligado: o robô precisa executar sozinho.

import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { setEthers } from '../js/eth.js';
import { ArbRunner } from '../js/runner.js';
import * as C from '../js/config.js';

setEthers(ethers);

const RPC = process.env.ANVIL_URL || 'http://127.0.0.1:8545';
const net = new ethers.Network('polygon-fork', 137n);
const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, batchMaxCount: 1 });

// Contas padrão do anvil (chaves públicas e conhecidas — só servem no fork local)
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BURNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const WHALE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

const owner = new ethers.Wallet(OWNER_KEY, provider);
const burner = new ethers.Wallet(BURNER_KEY, provider);
const whale = new ethers.Wallet(WHALE_KEY, provider);

const WPOL = C.TOKENS.WPOL.address;
const USDCE = C.TOKENS['USDC.e'].address;
const wpol = new ethers.Contract(WPOL, ['function deposit() payable', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], whale);
const router = new ethers.Contract(
  C.ADDR.QUICK_V2_ROUTER,
  ['function factory() view returns (address)', 'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'],
  whale,
);

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failures++;
  }
}

async function quickReserveWpol() {
  const factory = new ethers.Contract(await router.factory(), ['function getPair(address,address) view returns (address)'], provider);
  const pairAddr = await factory.getPair(WPOL, USDCE);
  const pair = new ethers.Contract(pairAddr, ['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)'], provider);
  const [r0, r1] = await pair.getReserves();
  return (await pair.token0()).toLowerCase() === WPOL.toLowerCase() ? r0 : r1;
}

async function whaleDump(amount) {
  await (await wpol.deposit({ value: amount })).wait();
  await (await wpol.approve(C.ADDR.QUICK_V2_ROUTER, amount)).wait();
  const block = await provider.getBlock('latest');
  await (await router.swapExactTokensForTokens(amount, 0, [WPOL, USDCE], whale.address, block.timestamp + 600)).wait();
}

const logs = [];
const runner = new ArbRunner({
  settings: {
    rpcUrls: [RPC],
    extraPairs: [{ id: 'E2E-WPOL-USDCe', base: 'WPOL', mid: 'USDC.e', label: 'WPOL / USDC.e (e2e)' }],
    pairIds: ['E2E-WPOL-USDCe'],
    dexIds: ['univ3', 'quickv3', 'quickv2'],
    minProfitUsd: 0.01,
    intervalMs: 500,
    gasCapPol: 50,
  },
  emit: (type, d) => {
    if (type === 'log') {
      logs.push(d);
      if (d.level !== 'scan') console.log(`   [${d.level}] ${d.msg}`);
    }
  },
});

try {
  console.log(`Fork em ${RPC} · bloco ${await provider.getBlockNumber()}`);

  // 1. Deploy
  const artifact = JSON.parse(readFileSync(new URL('../out/FlashArbitragePolygon.sol/FlashArbitragePolygon.json', import.meta.url), 'utf8'));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, owner);
  const arb = await factory.deploy();
  await arb.waitForDeployment();
  const arbAddr = await arb.getAddress();
  console.log(`Contrato implantado: ${arbAddr}`);
  await (await arb.setExecutor(burner.address, true)).wait();
  check(await arb.isExecutor(burner.address), 'burner autorizada (setExecutor)');

  // 2. Distorção
  const reserve = await quickReserveWpol();
  console.log(`Reserva de WPOL no par QuickSwap V2 WPOL/USDC.e: ${ethers.formatEther(reserve)}`);
  await provider.send('anvil_setBalance', [whale.address, ethers.toBeHex(10n ** 30n)]);
  await whaleDump(reserve / 8n);
  console.log('Baleia despejou 1/8 da reserva de WPOL na QuickSwap V2');

  // 3. Scanner encontra a oportunidade
  await runner.init();
  await runner.engine.slowRefresh(runner.settings);
  const price = runner.engine.state.prices.WPOL;
  check(price > 0, `preço do WPOL lido on-chain: $${price}`);
  let loanWpol = Number(ethers.formatEther(reserve / 50n));
  if (loanWpol > 100000) loanWpol = 100000;
  await runner.setSettings({ loanUsd: Math.round(loanWpol * price) });
  const res = await runner.scanOnce(['E2E-WPOL-USDCe']);
  console.log('Top 5 rotas encontradas pelo scanner:');
  for (const o of res.opportunities.slice(0, 5)) {
    console.log(`   ${o.buy.label.padEnd(12)} → ${o.sell.label.padEnd(12)} spread ${o.spreadPct.toFixed(3)}%  líquido ${o.netUsd.toFixed(2)} USD  gás≈${o.gasUsd.toFixed(4)} USD  ${o.executable ? 'VERDE' : ''}`);
  }
  const best = res.opportunities[0];
  check(best && best.executable && best.netUsd > 0, 'scanner encontrou rota verde (lucrativa) sozinho');
  check(best && best.sell.dexId === 'quickv2', 'melhor rota recompra WPOL na QuickSwap V2 (onde ficou barato)');

  // 4. Simulação + execução com a burner
  await runner.setContract(arbAddr);
  await runner.setBurner(BURNER_KEY);
  check(runner.burnerAuthorized === true, 'runner reconhece a burner como autorizada');
  const sim = await runner.executeOpportunity(best, { dryRun: true });
  check(sim.ok && sim.profit > 0n, `simulação on-chain aprovada (lucro ${sim.profit ? ethers.formatEther(sim.profit) : '?'} WPOL)`);

  const wpolRead = new ethers.Contract(WPOL, ['function balanceOf(address) view returns (uint256)'], provider);
  const ownerBefore = await wpolRead.balanceOf(owner.address);
  const exec = await runner.executeOpportunity(best);
  const ownerAfter = await wpolRead.balanceOf(owner.address);
  check(exec.ok && exec.stage === 'confirmada', `arbitragem confirmada on-chain (tx ${exec.hash})`);
  if (exec.receipt) console.log(`   gás usado: ${exec.receipt.gasUsed} · custo ${ethers.formatEther(exec.receipt.fee)} POL`);
  check(exec.profit > 0n && ownerAfter - ownerBefore === exec.profit, `lucro de ${ethers.formatEther(exec.profit || 0n)} WPOL chegou na carteira DONA`);
  check((await wpolRead.balanceOf(burner.address)) === 0n, 'burner não recebeu nada (só paga o gás)');
  check((await wpolRead.balanceOf(arbAddr)) === 0n, 'contrato não reteve saldo');
  check((await arb.totalTrades()) === 1n, 'totalTrades = 1');

  // 5. Rota ruim: precisa ser barrada na simulação
  const res2 = await runner.scanOnce(['E2E-WPOL-USDCe']);
  const worst = res2.opportunities[res2.opportunities.length - 1];
  const bad = await runner.executeOpportunity(worst, { dryRun: true });
  check(!bad.ok && /Sem lucro liquido/.test(bad.reason || ''), `rota com prejuízo barrada na simulação: "${bad.reason}"`);

  // 6. Piloto automático
  await whaleDump(reserve / 10n);
  const before = runner.stats.success;
  runner.setAuto(true);
  const t0 = Date.now();
  while (runner.stats.success === before && Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 500));
  }
  runner.setAuto(false);
  runner.stop();
  check(runner.stats.success > before, `piloto automático executou sozinho (${runner.stats.success - before} arbitragem)`);
  check((await arb.totalTrades()) === 2n, 'totalTrades = 2');

  const st = runner.publicStats();
  console.log(`\nResumo: ${st.success} sucessos · lucro ≈ $${st.profitUsd.toFixed(2)} · gás ${st.gasSpentPol.toFixed(5)} POL · simulado $${st.paperUsd.toFixed(2)}`);
} catch (err) {
  console.error(err);
  failures++;
}

if (failures) {
  console.error(`\nE2E: ${failures} falha(s).`);
  process.exit(1);
}
console.log('\nE2E OK: scanner + contrato + execução + piloto automático funcionando no fork da Polygon.');
process.exit(0);
