// ════════════════════════════════════════════════════════════════════════════
//  Configuração central — Polygon PoS (chain 137)
//  Todos os endereços foram conferidos nas documentações oficiais (fontes no README).
//  Este arquivo é usado pelo PWA (navegador), pelo Web Worker e pelo robô Node (bot/run.mjs).
// ════════════════════════════════════════════════════════════════════════════

export const APP_VERSION = '1.0.0';

export const CHAIN = {
  id: 137,
  hex: '0x89',
  name: 'Polygon PoS',
  nativeSymbol: 'POL',
  explorer: 'https://polygonscan.com',
};

// RPCs públicos e gratuitos, sem cadastro nem API key.
// Lista baseada em docs.polygon.technology/pos/reference/rpc-endpoints (nov/2026).
// ATENÇÃO: https://polygon-rpc.com foi desligado em 31/07/2026 e https://rpc.ankr.com/polygon
// passou a exigir login/API key — por isso NÃO estão na lista padrão (dá para adicioná-los na tela).
// O app testa todos ao iniciar, ordena pelo mais rápido e troca sozinho quando um falha.
export const DEFAULT_RPCS = [
  'https://polygon.drpc.org',
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.publicnode.com',
  'https://tenderly.rpc.polygon.community',
  'https://polygon-public.nodies.app',
  'https://1rpc.io/matic',
  'https://polygon.api.onfinality.io/public',
  'https://polygon-mainnet.gateway.tatum.io',
  'https://rpc-mainnet.matic.quiknode.pro',
  'https://polygon.llamarpc.com',
];

export const ADDR = {
  // Aave V3
  AAVE_POOL: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  AAVE_POOL_ADDRESSES_PROVIDER: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
  // Uniswap V3
  UNI_V3_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  UNI_V3_QUOTER_V2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  // QuickSwap
  QUICK_V2_ROUTER: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  QUICK_V3_ROUTER: '0xf5b509bB0909a69B1c207E495f687a596C168E12', // Algebra
  QUICK_V3_QUOTER: '0xa15F0D7377B2A0C0c10db057f641beD21028FC89', // Algebra
  // SushiSwap V2 (liquidez baixa na Polygon hoje — desligada por padrão)
  SUSHI_V2_ROUTER: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  // Multicall3 (mesmo endereço em todas as redes EVM)
  MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};

export const TOKENS = {
  USDC: { key: 'USDC', symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, stable: true },
  'USDC.e': { key: 'USDC.e', symbol: 'USDC.e', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6, stable: true },
  // USDT na Polygon virou USDT0 em 2025, mantendo o MESMO endereço
  USDT: { key: 'USDT', symbol: 'USDT0', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, stable: true },
  WETH: { key: 'WETH', symbol: 'WETH', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
  WPOL: { key: 'WPOL', symbol: 'WPOL', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
  WBTC: { key: 'WBTC', symbol: 'WBTC', address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8 },
  DAI: { key: 'DAI', symbol: 'DAI', address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18, stable: true },
  LINK: { key: 'LINK', symbol: 'LINK', address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', decimals: 18 },
  AAVE: { key: 'AAVE', symbol: 'AAVE', address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', decimals: 18 },
};

// Token usado como "régua" de dólar nas cotações
export const USD_REF = 'USDC';

// kind = mesmo enum do contrato: 0 = UNISWAP_V3, 1 = UNISWAP_V2, 2 = ALGEBRA
// legGas = gás estimado de cada perna (calibrado nos testes do fork — ver README)
export const DEXES = [
  { id: 'univ3', name: 'Uniswap V3', short: 'UNI V3', kind: 0, router: ADDR.UNI_V3_ROUTER, quoter: ADDR.UNI_V3_QUOTER_V2, fees: [100, 500, 3000, 10000], legGas: 150000, enabled: true },
  { id: 'quickv3', name: 'QuickSwap V3', short: 'QS V3', kind: 2, router: ADDR.QUICK_V3_ROUTER, quoter: ADDR.QUICK_V3_QUOTER, legGas: 170000, enabled: true },
  { id: 'quickv2', name: 'QuickSwap V2', short: 'QS V2', kind: 1, router: ADDR.QUICK_V2_ROUTER, legGas: 110000, enabled: true },
  { id: 'sushiv2', name: 'SushiSwap V2', short: 'SUSHI', kind: 1, router: ADDR.SUSHI_V2_ROUTER, legGas: 110000, enabled: false },
];

// Todos os pares possíveis entre os tokens acima (9 tokens = 36 pares).
// base = ativo do flash loan (o lucro é medido nele) · mid = token intermediário.
// A base é sempre o token mais "à esquerda" desta lista (stablecoins primeiro: lucro direto em dólar).
export const PAIR_PRIORITY = ['USDC', 'USDT', 'USDC.e', 'DAI', 'WETH', 'WPOL', 'WBTC', 'LINK', 'AAVE'];

// Os 4 pares pedidos na especificação original ficam marcados como "core"
const CORE_PAIRS = ['USDC-WETH', 'USDC-WPOL', 'USDT-WETH', 'USDC-WBTC'];
const PAIR_LABELS = { 'USDC-WBTC': 'WBTC / USDC' };

export const PAIRS = (() => {
  const out = [];
  for (let i = 0; i < PAIR_PRIORITY.length; i++) {
    for (let j = i + 1; j < PAIR_PRIORITY.length; j++) {
      const base = PAIR_PRIORITY[i];
      const mid = PAIR_PRIORITY[j];
      const id = `${base}-${mid}`;
      const t = (k) => TOKENS[k].symbol;
      out.push({ id, base, mid, label: PAIR_LABELS[id] || `${t(base)} / ${t(mid)}`, core: CORE_PAIRS.includes(id), enabled: true });
    }
  }
  return out;
})();

export const GAS = {
  BASE: 200000, // flash loan + lógica do contrato + envio do lucro
  MIN_PRIORITY_GWEI: 30, // a Polygon exige gorjeta mínima (~25–30 gwei)
  LIMIT_MULTIPLIER_PCT: 130, // gasLimit = estimativa × 1,3
};

export const DEFAULT_SETTINGS = {
  loanUsd: 10000,
  minProfitUsd: 2,
  intervalMs: 2500,
  pairIds: PAIRS.filter((p) => p.enabled).map((p) => p.id),
  pairsPerScan: 8, // rodízio: quantos pares cotar por bloco (protege os RPCs gratuitos de bloqueio)
  dexIds: DEXES.filter((d) => d.enabled).map((d) => d.id),
  crossFeeTiers: true, // também compara faixas de taxa diferentes da própria Uniswap V3
  priorityBoostPct: 100, // 100 = gorjeta sugerida; 150 = 50% a mais (entra antes no bloco)
  gasCapPol: 2, // modo automático para sozinho se gastar isso de gás numa sessão
  rpcUrls: DEFAULT_RPCS,
  extraPairs: [], // pares customizados (usado nos testes)
};

export const ABI = {
  multicall3: [
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
    'function getBlockNumber() view returns (uint256 blockNumber)',
    'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
    'function getBasefee() view returns (uint256 basefee)',
  ],
  quoterV2: [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ],
  algebraQuoter: [
    'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) returns (uint256 amountOut, uint16 fee)',
  ],
  v2Router: ['function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)'],
  aavePool: [
    'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
    // só os campos usados são lidos (palavra 0 = configuração, palavra 8 = aToken)
    'function getReserveData(address asset) view returns (uint256)',
  ],
  erc20: [
    'function balanceOf(address account) view returns (uint256)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
  ],
  arb: [
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
    'function isExecutor(address account) view returns (bool)',
    'function routerAllowed(address router) view returns (bool)',
    'function totalTrades() view returns (uint256)',
    'function totalProfitByAsset(address asset) view returns (uint256)',
    'function flashLoanFeeBps() view returns (uint256)',
    'function executeArbitrage(address asset, uint256 amount, (address tokenMid, (uint8 kind, address router, uint24 fee) buy, (uint8 kind, address router, uint24 fee) sell, uint256 minProfit, uint256 deadline) p) returns (uint256 profit)',
    'function setExecutor(address account, bool allowed)',
    'function setRouter(address router, bool allowed)',
    'function withdrawToken(address token, uint256 amount)',
    'function withdrawNative(uint256 amount)',
    'event ArbitrageExecuted(address indexed asset, address indexed tokenMid, uint256 amount, uint256 profit, address buyRouter, address sellRouter, address indexed caller)',
  ],
};

export const STORAGE_KEYS = {
  settings: 'flasharb.settings.v1',
  contract: 'flasharb.contract.v1',
  burner: 'flasharb.burner.session', // só sessionStorage, e só se o usuário marcar
};

export function txLink(hash) {
  return `${CHAIN.explorer}/tx/${hash}`;
}

export function addressLink(addr) {
  return `${CHAIN.explorer}/address/${addr}`;
}

export function findDex(id) {
  return DEXES.find((d) => d.id === id);
}

export function resolvePairs(pairIds, extraPairs = []) {
  const all = [...PAIRS, ...extraPairs];
  return pairIds.map((id) => all.find((p) => p.id === id)).filter(Boolean);
}
