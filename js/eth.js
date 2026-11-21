// Carregador do ethers.js v6 — funciona no navegador, no Web Worker e no Node.js.
//
// Navegador: módulo ES6 nativo via CDN (esm.sh), com jsDelivr como reserva. Sem build, sem npm.
// Node.js (robô no VPS / testes): usa o pacote "ethers" instalado com `npm install`.
//
// Segurança extra (opcional): baixe https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js,
// salve em /vendor/ethers.min.js e o app passa a usar a cópia local primeiro (nenhum script de terceiro
// roda na mesma página que a sua chave da burner wallet).

export const ETHERS_VERSION = '6.13.4';

const BROWSER_SOURCES = [
  new URL('../vendor/ethers.min.js', import.meta.url).href,
  `https://esm.sh/ethers@${ETHERS_VERSION}`,
  `https://cdn.jsdelivr.net/npm/ethers@${ETHERS_VERSION}/dist/ethers.min.js`,
];

let cached = null;
let loading = null;

function isNode() {
  return typeof process !== 'undefined' && !!(process.versions && process.versions.node) && typeof window === 'undefined' && typeof self === 'undefined';
}

export function setEthers(lib) {
  cached = lib.ethers ?? lib;
}

export async function loadEthers() {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    if (isNode()) {
      const mod = await import('ethers');
      cached = mod.ethers ?? mod;
      return cached;
    }
    const errors = [];
    for (const src of BROWSER_SOURCES) {
      try {
        const mod = await import(/* @vite-ignore */ src);
        const lib = mod.ethers ?? mod;
        if (!lib || typeof lib.JsonRpcProvider !== 'function') throw new Error('módulo inválido');
        cached = lib;
        cached.__source = src;
        return cached;
      } catch (err) {
        errors.push(`${src}: ${err && err.message ? err.message : err}`);
      }
    }
    loading = null;
    throw new Error(`Não foi possível carregar o ethers.js.\n${errors.join('\n')}`);
  })();
  return loading;
}
