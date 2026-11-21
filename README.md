# ⚡ FLASH//ARB: arbitragem atômica com flash loan na Polygon

[![CI](https://github.com/digitalrobertlima/flah-loans/actions/workflows/ci.yml/badge.svg)](https://github.com/digitalrobertlima/flah-loans/actions/workflows/ci.yml)

O projeto tem duas partes:

1. **Contrato inteligente** (`contracts/FlashArbitragePolygon.sol`): pega um *flash loan* na Aave V3, compra numa DEX, vende em outra, paga a Aave e manda o lucro para a sua carteira. Tudo acontece numa única transação. Se não houver lucro, a transação é desfeita.
2. **App PWA 100% estático** (GitHub Pages): um scanner em tempo real que lê preços **direto da blockchain** (sem API, sem cadastro, sem servidor), calcula o lucro líquido de cada rota e executa com 1 clique ou no piloto automático.

> ### ⚠️ Antes de tudo: expectativa realista
> Arbitragem entre DEXs na Polygon é disputada por robôs profissionais, com nós próprios e latência de milissegundos. As oportunidades costumam durar **menos de 1 segundo**. Um app no navegador, lendo RPC público a cada ~2 s, **perde essa corrida quase sempre**. O normal é ver o quadro todo vermelho.
>
> O que o projeto garante:
> - o contrato **nunca perde o dinheiro emprestado** (sem lucro, ele reverte);
> - o app **simula cada operação antes de enviar**, então ficar esperando quase não gasta gás;
> - o **modo simulação** mostra quanto você *teria* ganhado, sem arriscar nada.
>
> Trate o projeto como laboratório, portfólio e um "bilhete de loteria" barato, não como renda. Isto não é recomendação financeira.

---

## Sumário

1. [O que tem no repositório](#1-o-que-tem-no-repositório)
2. [Como funciona](#2-como-funciona)
3. [Implantar o contrato em 2 minutos (Remix + Rabby)](#3-implantar-o-contrato-em-2-minutos-remix--rabby)
4. [Ativar o GitHub Pages e abrir o app](#4-ativar-o-github-pages-e-abrir-o-app)
5. [Usar o app](#5-usar-o-app)
6. [Piloto automático com burner wallet](#6-piloto-automático-com-burner-wallet)
7. [Segurança: boas práticas](#7-segurança-boas-práticas)
8. [Rodar 24h no seu VPS (opcional)](#8-rodar-24h-no-seu-vps-opcional)
9. [Configurações](#9-configurações)
10. [Testes automáticos](#10-testes-automáticos)
11. [Endereços verificados e correções da especificação](#11-endereços-verificados-e-correções-da-especificação)
12. [Problemas comuns](#12-problemas-comuns)

---

## 1. O que tem no repositório

```
contracts/FlashArbitragePolygon.sol   contrato (Solidity ^0.8.20)
index.html · style.css · app.js       interface do PWA (tema dark/cyberpunk)
manifest.json · sw.js · icons/        PWA instalável (funciona como app no celular/PC)
js/config.js                          endereços, tokens, pares, DEXs, RPCs, ABIs
js/engine.js                          motor: cotações on-chain, cálculo de lucro, execução
js/runner.js                          laço por bloco, rodízio de pares, piloto automático
js/worker.js                          roda o motor num Web Worker (a tela não trava)
js/rpc.js                             RPCs públicos com fallback automático
js/wallet.js                          Rabby / MetaMask (EIP-6963)
bot/run.mjs                           mesmo motor em Node.js para VPS (opcional)
test/FlashArbitragePolygon.t.sol      testes do contrato num fork real da Polygon
tools/                                ABI, scanner ao vivo e teste ponta a ponta
.github/workflows/ci.yml              CI gratuito que roda tudo isso a cada push
```

Sem build e sem `npm install` para o site: o GitHub Pages publica os arquivos como estão. O `ethers.js v6` é carregado como módulo ES6 via CDN (esm.sh, com jsDelivr de reserva).

## 2. Como funciona

```
 Scanner (seu navegador)                                 Blockchain Polygon
 ───────────────────────                                 ──────────────────
 a cada bloco novo (~2 s):
  1 eth_call (Multicall3) ─ cotações de COMPRA ───────▶  Uniswap V3 QuoterV2 (4 faixas de taxa)
                                                         QuickSwap V3 (Algebra) Quoter
                                                         QuickSwap V2 / SushiSwap getAmountsOut
  1 eth_call (Multicall3) ─ cotações de VENDA ────────▶  (mesmas DEXs, sentido inverso)
  calcula: retorno bruto − taxa Aave − gás (US$)
  linha verde se lucro líquido ≥ mínimo
        │
        ▼ (1 clique ou piloto automático)
  simula (eth_call) ── reverteu? não envia nada, gasto zero
        │ passou
        ▼
  envia tx ───────────────────────────────────────────▶  FlashArbitragePolygon.executeArbitrage()
                                                          ├─ Aave V3: flashLoanSimple(USDC…)
                                                          ├─ compra na DEX A
                                                          ├─ vende na DEX B
                                                          ├─ require(lucro ≥ mínimo) senão REVERTE
                                                          ├─ Aave recebe empréstimo + 0,05%
                                                          └─ lucro → carteira DONA
```

- **36 pares**: todos os pares entre USDC, USDT0, USDC.e, DAI, WETH, WPOL, WBTC, LINK e AAVE. Isso inclui os 4 da especificação (USDC/WETH, USDC/WPOL, USDT/WETH, WBTC/USDC).
- **4 DEXs**: Uniswap V3, QuickSwap V3 (Algebra), QuickSwap V2 e SushiSwap V2 (esta desligada por padrão por ter pouca liquidez). Todos os sentidos são testados: A→B, B→A e também faixas de taxa diferentes da própria Uniswap V3.
- **Rodízio**: para não ser bloqueado pelos RPCs gratuitos, o scanner cota 8 pares por bloco. A volta completa nos 36 pares leva uns 5 blocos (~10 s).
- **Taxa da Aave** e **liquidez disponível** são lidas on-chain. Se um ativo estiver pausado ou sem liquidez, a rota aparece com ⚠ e não é executada.
- **Gás** vem de `provider.getFeeData()` mais a base fee do bloco, respeitando a gorjeta mínima da Polygon (~25–30 gwei). Ele é convertido para US$ pelo preço do POL lido on-chain.

## 3. Implantar o contrato em 2 minutos (Remix + Rabby)

Você só precisa de um pouco de **POL** na carteira principal (Rabby). O deploy custa centavos.

1. Na Rabby, selecione a rede **Polygon**.
2. Abra **https://remix.ethereum.org**.
3. No explorador de arquivos (ícone de páginas), clique em **"Create new file"** e chame de `FlashArbitragePolygon.sol`.
4. Abra [`contracts/FlashArbitragePolygon.sol`](contracts/FlashArbitragePolygon.sol) aqui no GitHub, clique em **"Raw"**, copie tudo (Ctrl+A, Ctrl+C) e cole no Remix.
5. Aba **Solidity Compiler** (ícone "S"):
   - **Compiler**: `0.8.24` (ou qualquer `0.8.x` mais nova);
   - abra **Advanced Configurations** e escolha **EVM Version: `cancun`**; marque **Optimization** com `200`;
   - clique em **Compile FlashArbitragePolygon.sol** e espere o ✓ verde.
6. Aba **Deploy & run transactions** (ícone do Ethereum):
   - **Environment**: `Injected Provider` (aparece como *Rabby Wallet* ou *MetaMask*). Confirme a conexão na Rabby;
   - confira se aparece **"Custom (137) network"** ou **Polygon**;
   - em **Contract**, escolha `FlashArbitragePolygon`;
   - clique em **Deploy** e confirme na Rabby.
7. Em **Deployed Contracts**, copie o endereço (`0x…`). **Esse é o endereço do seu contrato.** A carteira que fez o deploy é a **dona** e recebe todos os lucros.

> O construtor confere sozinho se a rede é a Polygon (137) e se o Pool da Aave é o oficial. Em outra rede, o deploy falha de propósito.

**Funções que você pode chamar pelo Remix** (todas só pelo dono):

| Função | Para quê |
|---|---|
| `setExecutor(burner, true)` | autoriza a burner do piloto automático (o app também faz isso com 1 clique) |
| `setExecutor(burner, false)` | revoga a burner na hora |
| `setRouter(router, true/false)` | libera/bloqueia uma DEX |
| `withdrawToken(token, 0)` | saque de emergência de um token (0 = tudo) |
| `withdrawNative(0)` | saque de emergência de POL (0 = tudo) |
| `transferOwnership(novo)` + `acceptOwnership()` | troca de dono em 2 etapas |

## 4. Ativar o GitHub Pages e abrir o app

1. No GitHub, abra o repositório → **Settings** → **Pages**.
2. Em **Build and deployment → Source**, escolha **Deploy from a branch**.
3. **Branch**: `main`, pasta `/ (root)` → **Save**.
4. Espere 1–2 minutos. O app fica em:
   **https://digitalrobertlima.github.io/flah-loans/**
5. No celular ou no PC, use **"Instalar app"** (botão no topo ou menu do navegador) para abrir como aplicativo.

Cada `git push` na `main` publica a nova versão sozinho. O app se atualiza ao recarregar e, com o robô parado, recarrega sozinho quando detecta versão nova.

## 5. Usar o app

1. Clique em **▶ Iniciar scanner**. O app testa os RPCs, escolhe o mais rápido e começa a ler cada bloco.
2. Ajuste o **valor simulado do flash loan** (10 mil, 50 mil, 100 mil ou outro) e o **lucro líquido mínimo**.
3. Acompanhe:
   - **Modo simulação**: soma o que o robô *teria* ganhado executando cada linha verde (sem gastar nada) e mostra o gráfico do melhor lucro por varredura;
   - **Oportunidades ao vivo**: par, rota (compra → venda), spread, bruto, taxa Aave, gás, **lucro líquido** e idade em blocos;
   - **Console**: blocos analisados, troca de RPC, simulações, transações com link do PolygonScan.
4. Cole o **endereço do contrato** em *Execução* → **Conectar**. A partir daí:
   - **Simular** funciona em qualquer linha: roda o contrato de verdade em `eth_call` e mostra o lucro on-chain naquele bloco, sem custo;
   - **Executar** (só linhas verdes): com a **Rabby/MetaMask** conectada, ela pede para você assinar. Sem carteira, usa a burner.

## 6. Piloto automático com burner wallet

O piloto automático assina sozinho, então precisa de uma chave privada no navegador. **Nunca use a chave da sua carteira principal.**

1. **Crie uma burner nova.** Na Rabby: *Adicionar endereço → Criar novo endereço*. Ou no app: **"gerar burner nova"** (guarde a chave antes de usar).
2. **Abasteça com pouco POL**, só para gás (2 a 5 POL já sobram). A burner **não precisa de capital**: o empréstimo vem da Aave e o lucro vai para a carteira dona.
3. **Exporte a chave** da burner (Rabby: endereço → ⋯ → *Exportar chave privada*) e cole no app → **Carregar**.
4. **Autorize a burner no contrato.** Com a Rabby **dona** conectada no app, clique em **"Autorizar burner como executora"**. Ou no Remix: `setExecutor(enderecoDaBurner, true)`.
5. Defina o **teto de gás** (POL por sessão) e ligue **AUTO-EXECUTE**.

Quando uma rota passa do lucro mínimo, o robô:
1. **simula** (se reverter, não envia nada e não gasta gás);
2. estima o gás e envia com gorjeta configurável;
3. espera a confirmação e mostra o lucro e o link no console.

O contrato exige on-chain um lucro de **pelo menos o custo do gás mais o seu mínimo**. Se o preço mudar entre a simulação e o bloco, a transação reverte e você paga só o gás daquela tentativa.

## 7. Segurança: boas práticas

- **Carteira dedicada (burner)** só com POL para gás. Se ela vazar, o prejuízo máximo é esse POL.
- **O lucro nunca fica na burner.** O contrato manda tudo direto para a carteira **dona**. A burner não consegue sacar nada nem mudar configurações.
- **Revogue rápido**: `setExecutor(burner, false)` desliga a burner na hora.
- A chave fica **só na memória do navegador** (Web Worker). Se você marcar "lembrar até fechar a aba", ela vai para o `sessionStorage` e some ao fechar a aba. Ela nunca é enviada para servidor nenhum: o app não tem servidor.
- **Teto de gás por sessão**: o piloto automático desliga sozinho ao atingir o limite.
- **Use um navegador limpo**, sem extensões desconhecidas, quando a burner estiver carregada.
- **Segurança máxima (opcional)**: baixe `https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js`, salve como `vendor/ethers.min.js` no repositório e faça push. O app passa a usar a cópia local e nenhum script de terceiro roda junto com a sua chave.
- O contrato só aprova tokens para **routers da lista permitida** e ignora saldo que já estava parado nele. Uma rota maliciosa não consegue "fingir" lucro nem drenar nada.
- **Desconfie** de qualquer "bot de MEV" que peça para você depositar dinheiro num contrato. Esse é um golpe comum. Aqui você **nunca** deposita nada no contrato.

## 8. Rodar 24h no seu VPS (opcional)

No navegador, o robô para se a aba for fechada ou o celular suspender a página. O mesmo motor roda em Node.js, por exemplo numa VM Oracle Cloud *Always Free* (ARM funciona).

```bash
# Node 22 (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone https://github.com/digitalrobertlima/flah-loans.git
cd flah-loans
npm install

# 1) só observar (modo simulação, custo zero)
node bot/run.mjs
```

Para executar de verdade, crie um arquivo de ambiente protegido:

```bash
sudo tee /etc/flasharb.env > /dev/null << 'EOF'
ARB_CONTRACT=0xSEU_CONTRATO
BURNER_KEY=0xCHAVE_DA_BURNER
AUTO=1
MIN_PROFIT_USD=2
LOAN_USD=10000
GAS_CAP_POL=2
QUIET=1
EOF
sudo chmod 600 /etc/flasharb.env
```

E um serviço que reinicia sozinho:

```bash
sudo tee /etc/systemd/system/flasharb.service > /dev/null << EOF
[Unit]
Description=FLASH//ARB bot
After=network-online.target

[Service]
WorkingDirectory=$(pwd)
EnvironmentFile=/etc/flasharb.env
ExecStart=$(which node) bot/run.mjs
Restart=always
RestartSec=10
User=$(whoami)

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now flasharb
journalctl -u flasharb -f     # acompanhar os logs
```

A cada 10 minutos o bot imprime um resumo: blocos, verdes, txs, lucro real e lucro simulado. **Sugestão:** rode uma semana **sem** `AUTO=1` e veja o lucro simulado antes de arriscar gás.

## 9. Configurações

| Tela | Variável do bot | Padrão | O que faz |
|---|---|---|---|
| Valor do flash loan | `LOAN_USD` | 10000 | valor simulado/emprestado em US$ (convertido para o token do par) |
| Lucro líquido mínimo | `MIN_PROFIT_USD` | 2 | linha verde e exigência on-chain (além do gás) |
| Intervalo | `INTERVAL_MS` | 2500 | de quanto em quanto tempo checa bloco novo |
| Pares por bloco | `PAIRS_PER_SCAN` | 8 | tamanho do rodízio (mais = mais RPC por bloco) |
| Teto de gás | `GAS_CAP_POL` | 2 | desliga o automático após gastar isso |
| Gorjeta | `PRIORITY_BOOST_PCT` | 100 | % da gorjeta sugerida (150 = 50% a mais para entrar antes) |
| DEXs / Pares | `DEXES` / `PAIRS` | todas / todos | ids separados por vírgula (ver `js/config.js`) |
| RPCs | `RPC_URLS` | lista pública | um por linha na tela, vírgula no bot |

Para adicionar tokens ou DEXs, edite `js/config.js`. Os pares são gerados automaticamente.

## 10. Testes automáticos

Cada push roda o [CI](.github/workflows/ci.yml) de graça (repositório público):

| Etapa | O que prova |
|---|---|
| Compilação | o contrato compila em Solidity 0.8.24 **e** no mínimo 0.8.20 |
| `forge test` no fork da Polygon | Aave, Uniswap e QuickSwap **reais**: lucro capturado nos dois sentidos (V3→V2, V2→V3) e com QuickSwap V3; reverte sem lucro; saldo parado não vira "lucro"; flash loan iniciado por terceiros é recusado; controle de acesso; saques; troca de dono |
| `check-abi` | a ABI do app é idêntica à do contrato compilado |
| `scan-once` | scanner **ao vivo** com RPCs públicos: decimais dos 9 tokens, cotações em todas as DEXs, status e liquidez da Aave, taxa do flash loan on-chain |
| `e2e-fork` | o motor do app encontra sozinho uma distorção criada no fork, simula, executa com a burner, o lucro chega na carteira dona, rota ruim é barrada e o **piloto automático** executa sozinho |

Rodar localmente (precisa de [Foundry](https://book.getfoundry.sh/) e Node 20+):

```bash
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
npm install
forge test --fork-url https://polygon-bor-rpc.publicnode.com -vvv
node tools/scan-once.mjs
anvil --fork-url https://polygon-bor-rpc.publicnode.com &   # em outro terminal
forge build && node tools/e2e-fork.mjs
```

## 11. Endereços verificados e correções da especificação

| Contrato | Endereço (Polygon 137) |
|---|---|
| Aave V3 Pool | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Aave V3 PoolAddressesProvider | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` |
| Uniswap V3 SwapRouter | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |
| Uniswap V3 QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| QuickSwap V2 Router | `0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff` |
| QuickSwap V3 (Algebra) SwapRouter / Quoter | `0xf5b509bB0909a69B1c207E495f687a596C168E12` / `0xa15F0D7377B2A0C0c10db057f641beD21028FC89` |
| SushiSwap V2 Router | `0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| USDC (nativo Circle) / USDC.e (bridged) | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` / `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| USDT0 (antigo USDT, mesmo endereço) | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` |
| WETH / WPOL / WBTC | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` / `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` / `0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6` |
| DAI / LINK / AAVE | `0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063` / `0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39` / `0xD6DF932A45C0f255f85145f286eA0b292B21C90B` |

**O que mudou em relação à especificação original, e por quê:**

- **`polygon-rpc.com` foi desligado** em 31/07/2026, e **`rpc.ankr.com/polygon` passou a exigir login/API key**. Por isso nenhum dos dois está na lista padrão. O app usa os RPCs públicos da lista oficial da Polygon (dRPC, PublicNode, Tenderly, Nodies, 1RPC, OnFinality…), com teste de velocidade e troca automática. O `polygon.llamarpc.com` ficou como reserva.
- **Taxa do flash loan**: 0,05% é o valor padrão da Aave V3, mas a governança pode mudar. O app lê o valor real on-chain (`FLASHLOAN_PREMIUM_TOTAL`).
- **Trava de lucro**: além de `finalBalance >= amountOwed + minProfit`, o contrato desconta o saldo que já estava parado nele, para uma rota maliciosa não conseguir "fingir" lucro com dinheiro antigo.
- **`onlyOwner` + executores**: o dono pode autorizar uma burner para o piloto automático. A burner só dispara arbitragens; o lucro vai sempre para o dono.
- **USDT na Polygon agora é USDT0**, com o mesmo endereço.
- **QuickSwap V3 (Algebra)** foi incluída além da V2: hoje é onde está a maior parte da liquidez da QuickSwap.

Fontes: [Aave: flash loans e taxa](https://aave.com/docs/developers/flash-loans) · [Endereços Aave Polygon (governança)](https://governance.aave.com/t/arfc-adopt-the-seal-safe-harbor-agreement/23059) · [Uniswap V3 na Polygon](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-polygon-deployments) · [QuickSwap V2 Router](https://quickswap-docs.pages.dev/reference/smart-contracts/v2/router02) · [USDC nativo (Circle)](https://developers.circle.com/stablecoins/usdc-contract-addresses) · [USDT0 na Polygon](https://polygon.technology/blog/native-usdt0-comes-to-polygon-for-lower-fees-and-deeper-liquidity) · [Desligamento do polygon-rpc.com](https://forum.polygon.technology/t/deprecation-of-polygons-public-rpc-endpoints-mainnet-amoy/22014) · [RPCs públicos oficiais](https://docs.polygon.technology/pos/reference/rpc-endpoints) · [Gorjeta mínima na Polygon](https://docs.polygon.technology/tools/gas/polygon-gas-station) · [Estudo de MEV/arbitragem na Polygon](https://arxiv.org/html/2508.21473v1)

## 12. Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| "Não foi possível carregar o ethers.js" | sem internet ou CDN bloqueada (adblock/firewall). Tente outra rede ou use a cópia local (seção 7) |
| "Nenhum RPC respondeu" | rede bloqueando ou RPCs fora do ar. Adicione outro RPC na seção *RPCs públicos* |
| Muitas trocas de RPC no console | limite de requisições do RPC gratuito. Aumente o intervalo ou diminua "pares por bloco" |
| Simulação: `Sem lucro liquido` | normal: o spread sumiu ou nunca cobriu as taxas. Nada foi enviado |
| Simulação: `Nao autorizado` | a carteira/burner não é dona nem executora. Use `setExecutor` |
| Rota com ⚠ | a Aave está sem liquidez suficiente ou com flash loan pausado para esse ativo |
| Deploy falha no Remix | rede errada (precisa ser Polygon 137) ou EVM version incompatível (use `cancun`) |
| Celular parou de executar | o navegador suspende abas em segundo plano. Para 24h use o bot no VPS |

---

Licença MIT. Use por sua conta e risco.
