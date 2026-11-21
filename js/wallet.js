// Conexão com carteiras do navegador (Rabby, MetaMask e outras) via EIP-6963,
// com fallback para window.ethereum. Garante que a carteira esteja na Polygon (137).

import { CHAIN } from './config.js';

const found = new Map();

export function discoverWallets(onChange) {
  const notify = () => onChange([...found.values()]);
  window.addEventListener('eip6963:announceProvider', (ev) => {
    const { info, provider } = ev.detail || {};
    if (!info || !provider) return;
    found.set(info.uuid, { info, provider });
    notify();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  // carteiras antigas que não anunciam via EIP-6963
  setTimeout(() => {
    if (!found.size && window.ethereum) {
      const eth = window.ethereum;
      const name = eth.isRabby ? 'Rabby' : eth.isMetaMask ? 'MetaMask' : 'Carteira do navegador';
      found.set('legacy', { info: { uuid: 'legacy', name, icon: '', rdns: 'legacy' }, provider: eth });
    }
    notify();
  }, 500);
}

export async function ensurePolygon(eip1193) {
  const current = await eip1193.request({ method: 'eth_chainId' });
  if (parseInt(current, 16) === CHAIN.id) return;
  try {
    await eip1193.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.hex }] });
  } catch (err) {
    const code = err && (err.code ?? (err.data && err.data.originalError && err.data.originalError.code));
    if (code !== 4902) throw err;
    await eip1193.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: CHAIN.hex,
          chainName: CHAIN.name,
          nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
          rpcUrls: ['https://polygon.drpc.org'],
          blockExplorerUrls: [CHAIN.explorer],
        },
      ],
    });
  }
}

/** Conecta e devolve { signer, address, provider } (ethers BrowserProvider). */
export async function connectWallet(E, eip1193) {
  await eip1193.request({ method: 'eth_requestAccounts' });
  await ensurePolygon(eip1193);
  const provider = new E.BrowserProvider(eip1193, 'any');
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  return { provider, signer, address };
}
