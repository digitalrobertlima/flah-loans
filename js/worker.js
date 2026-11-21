// Web Worker do scanner: roda fora da thread da interface, então a tela não trava
// e o laço continua mesmo com a aba em segundo plano (desde que o navegador não suspenda a aba).
// A chave da burner wallet, se usada, vive SOMENTE na memória deste worker.

import { ArbRunner } from './runner.js';
import { shortError } from './rpc.js';

let runner = null;

const post = (type, data) => {
  try {
    self.postMessage({ type, data });
  } catch (err) {
    self.postMessage({ type: 'log', data: { level: 'error', msg: `postMessage falhou (${type}): ${shortError(err)}`, time: Date.now() } });
  }
};

async function handle(type, data) {
  if (type === 'init') {
    runner = new ArbRunner({ settings: data && data.settings, emit: post });
    await runner.init();
    return;
  }
  if (!runner || !runner.engine) throw new Error('Scanner ainda carregando…');
  switch (type) {
    case 'start':
      runner.start();
      break;
    case 'stop':
      runner.stop();
      break;
    case 'settings':
      await runner.setSettings(data);
      break;
    case 'contract':
      await runner.setContract(data && data.address);
      break;
    case 'burner':
      await runner.setBurner(data && data.privateKey);
      break;
    case 'burner-refresh':
      await runner.burnerStatus();
      break;
    case 'auto':
      runner.setAuto(data && data.enabled);
      break;
    case 'execute': {
      const opp = runner.findOpportunity(data.id);
      if (!opp) throw new Error('Essa oportunidade já saiu do quadro — espere a próxima varredura.');
      await runner.executeOpportunity(opp, { dryRun: !!data.dryRun, source: 'manual' });
      break;
    }
    case 'reprobe':
      await runner.engine.rpc.probe();
      break;
    default:
      throw new Error(`Mensagem desconhecida: ${type}`);
  }
}

self.onmessage = async (ev) => {
  const { type, data, id } = ev.data || {};
  try {
    await handle(type, data);
    if (id) post('ack', { id, ok: true });
  } catch (err) {
    const msg = shortError(err);
    post('log', { level: 'error', msg, time: Date.now() });
    if (id) post('ack', { id, ok: false, error: msg });
  }
};

post('worker-ready', {});
