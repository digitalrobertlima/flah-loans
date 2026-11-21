// Confere se a ABI usada pelo PWA (js/config.js) bate com a ABI compilada do contrato (forge build).
// Uso: forge build && node tools/check-abi.mjs

import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { ABI } from '../js/config.js';

const artifactUrl = new URL('../out/FlashArbitragePolygon.sol/FlashArbitragePolygon.json', import.meta.url);
const artifact = JSON.parse(readFileSync(artifactUrl, 'utf8'));
const real = new ethers.Interface(artifact.abi);
const front = new ethers.Interface(ABI.arb);

let failures = 0;
const fmt = (params) => params.map((p) => p.format('sighash')).join(',');

front.forEachFunction((f) => {
  const r = real.getFunction(f.name);
  if (!r) {
    console.error(`✗ função ${f.name} não existe no contrato`);
    failures++;
    return;
  }
  if (r.selector !== f.selector) {
    console.error(`✗ ${f.name}: seletor do PWA ${f.selector} ≠ contrato ${r.selector}`);
    failures++;
    return;
  }
  if (fmt(r.outputs) !== fmt(f.outputs)) {
    console.error(`✗ ${f.name}: retorno do PWA (${fmt(f.outputs)}) ≠ contrato (${fmt(r.outputs)})`);
    failures++;
    return;
  }
  console.log(`✓ ${f.format('sighash')}  ${f.selector}`);
});

front.forEachEvent((e) => {
  const r = real.getEvent(e.name);
  if (!r || r.topicHash !== e.topicHash) {
    console.error(`✗ evento ${e.name} diferente do contrato`);
    failures++;
    return;
  }
  console.log(`✓ evento ${e.format('sighash')}`);
});

if (failures) {
  console.error(`\n${failures} divergência(s) entre a ABI do PWA e o contrato.`);
  process.exit(1);
}
console.log('\nABI do PWA idêntica à do contrato compilado.');
