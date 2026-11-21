// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * ███ FlashArbitragePolygon ███
 *
 * Arbitragem atômica com Flash Loan da Aave V3 na Polygon PoS (chain 137).
 *
 * Fluxo de uma operação:
 *   1. executeArbitrage() pede um flash loan "simples" (1 ativo) ao Pool da Aave V3.
 *   2. A Aave transfere o ativo e chama executeOperation() neste contrato.
 *   3. Perna de COMPRA:  ativo emprestado -> tokenMid  (DEX A)
 *      Perna de VENDA:   tokenMid -> ativo emprestado  (DEX B)
 *      (o caminho inverso é só trocar as pernas: DEX B -> DEX A)
 *   4. Trava atômica: se o saldo final não cobrir empréstimo + taxa + lucro mínimo,
 *      tudo é revertido ("Sem lucro liquido") e nada acontece, exceto o gás gasto.
 *   5. A Aave puxa empréstimo + taxa, e o lucro líquido vai AUTOMATICAMENTE para o dono.
 *
 * DEXs suportadas (cada perna escolhe a sua):
 *   - UNISWAP_V3 : SwapRouter da Uniswap V3 (exactInputSingle com fee tier)
 *   - UNISWAP_V2 : qualquer router estilo Uniswap V2 (QuickSwap V2, SushiSwap V2...)
 *   - ALGEBRA    : SwapRouter Algebra (QuickSwap V3, taxa dinâmica por pool)
 *
 * Segurança:
 *   - Só o dono ou executores autorizados pelo dono disparam arbitragens.
 *   - Executores NÃO conseguem sacar nada: o lucro sempre vai para o dono.
 *   - Só routers da lista permitida (whitelist) podem receber aprovação de tokens.
 *   - Saldo que já estava no contrato não conta como lucro (evita drenagem por rota maliciosa).
 *   - executeOperation só aceita chamadas do Pool da Aave iniciadas por este contrato.
 *
 * Compilação recomendada (Remix ou Foundry): Solidity 0.8.24, EVM "cancun", otimização 200 runs.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces mínimas
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @dev Aave V3 — PoolAddressesProvider
interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

/// @dev Aave V3 — Pool (somente o que este contrato usa)
interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

/// @dev Aave V3 — interface do recebedor de flash loan simples
interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);

    function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider);

    function POOL() external view returns (IPool);
}

/**
 * @dev Mesma base oficial da Aave V3 (aave-v3-core/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol),
 *      reproduzida aqui para o arquivo compilar sozinho no Remix, sem depender de imports remotos.
 */
abstract contract FlashLoanSimpleReceiverBase is IFlashLoanSimpleReceiver {
    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;
    IPool public immutable override POOL;

    constructor(IPoolAddressesProvider provider) {
        ADDRESSES_PROVIDER = provider;
        POOL = IPool(provider.getPool());
    }
}

/// @dev Uniswap V3 SwapRouter (0xE592...1564), versão com deadline no struct
interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Algebra SwapRouter (QuickSwap V3) — não tem fee tier, a taxa é dinâmica por pool
interface IAlgebraSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 limitSqrtPrice;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Router estilo Uniswap V2 (QuickSwap V2, SushiSwap V2)
interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Transferências seguras (compatível com tokens que não retornam bool, ex.: USDT antigo)
// ─────────────────────────────────────────────────────────────────────────────

library SafeERC20Lite {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        require(_callOptionalReturn(token, abi.encodeCall(IERC20.transfer, (to, value))), "Falha na transferencia");
    }

    /// @dev Aprova `value`; se o token exigir zerar antes (padrão USDT), zera e aprova de novo.
    function forceApprove(IERC20 token, address spender, uint256 value) internal {
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (spender, value));
        if (!_callOptionalReturn(token, approveCall)) {
            require(_callOptionalReturn(token, abi.encodeCall(IERC20.approve, (spender, 0))), "Falha no approve");
            require(_callOptionalReturn(token, approveCall), "Falha no approve");
        }
    }

    function _callOptionalReturn(IERC20 token, bytes memory data) private returns (bool) {
        (bool success, bytes memory ret) = address(token).call(data);
        if (!success) return false;
        if (ret.length == 0) return address(token).code.length > 0;
        return ret.length >= 32 && abi.decode(ret, (bool));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contrato principal
// ─────────────────────────────────────────────────────────────────────────────

contract FlashArbitragePolygon is FlashLoanSimpleReceiverBase {
    using SafeERC20Lite for IERC20;

    // Endereços oficiais na Polygon PoS (verificados nas documentações da Aave, Uniswap e QuickSwap)
    address public constant AAVE_POOL_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address public constant AAVE_V3_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant QUICKSWAP_V2_ROUTER = 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff;
    address public constant QUICKSWAP_V3_ROUTER = 0xf5b509bB0909a69B1c207E495f687a596C168E12;
    address public constant SUSHISWAP_V2_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;

    enum DexKind {
        UNISWAP_V3, // 0
        UNISWAP_V2, // 1
        ALGEBRA // 2
    }

    /// @notice Uma perna da arbitragem (um swap em uma DEX)
    struct Leg {
        DexKind kind;
        address router;
        uint24 fee; // só usado em UNISWAP_V3 (100, 500, 3000, 10000)
    }

    /// @notice Parâmetros completos de uma arbitragem
    struct ArbParams {
        address tokenMid; // token intermediário (ex.: WETH)
        Leg buy; // ativo emprestado -> tokenMid
        Leg sell; // tokenMid -> ativo emprestado
        uint256 minProfit; // lucro mínimo exigido, em unidades do ativo emprestado (já descontada a taxa da Aave)
        uint256 deadline; // timestamp limite (protege contra tx "velha" presa na mempool)
    }

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isExecutor;
    mapping(address => bool) public routerAllowed;

    uint256 public totalTrades;
    mapping(address => uint256) public totalProfitByAsset;

    uint256 private _lock = 1;

    event ArbitrageExecuted(
        address indexed asset,
        address indexed tokenMid,
        uint256 amount,
        uint256 profit,
        address buyRouter,
        address sellRouter,
        address indexed caller
    );
    event ExecutorUpdated(address indexed account, bool allowed);
    event RouterUpdated(address indexed router, bool allowed);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Somente dono");
        _;
    }

    modifier onlyExecutor() {
        require(msg.sender == owner || isExecutor[msg.sender], "Nao autorizado");
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "Reentrada");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor() FlashLoanSimpleReceiverBase(IPoolAddressesProvider(AAVE_POOL_ADDRESSES_PROVIDER)) {
        require(block.chainid == 137, "Somente Polygon (137)");
        require(IPoolAddressesProvider(AAVE_POOL_ADDRESSES_PROVIDER).getPool() == AAVE_V3_POOL, "Pool Aave inesperado");

        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        _setRouter(UNISWAP_V3_ROUTER, true);
        _setRouter(QUICKSWAP_V2_ROUTER, true);
        _setRouter(QUICKSWAP_V3_ROUTER, true);
        _setRouter(SUSHISWAP_V2_ROUTER, true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Arbitragem
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Dispara a arbitragem com flash loan.
     * @param asset  Ativo emprestado da Aave (ex.: USDC) — o lucro é medido nele.
     * @param amount Valor emprestado (em unidades do token, ex.: 10_000e6 para 10.000 USDC).
     * @param p      Rota (pernas de compra e venda), lucro mínimo e prazo.
     * @return profit Lucro líquido enviado ao dono (em unidades de `asset`).
     */
    function executeArbitrage(address asset, uint256 amount, ArbParams calldata p)
        external
        onlyExecutor
        nonReentrant
        returns (uint256 profit)
    {
        require(block.timestamp <= p.deadline, "Expirado");
        require(amount > 0, "Valor zero");
        require(p.tokenMid != address(0) && p.tokenMid != asset, "Par invalido");
        require(routerAllowed[p.buy.router] && routerAllowed[p.sell.router], "Router nao permitido");

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));

        POOL.flashLoanSimple(address(this), asset, amount, abi.encode(p), 0);

        // Aqui a Aave já recebeu empréstimo + taxa. O que sobrou acima do saldo anterior é lucro.
        profit = IERC20(asset).balanceOf(address(this)) - balanceBefore;
        if (profit > 0) {
            IERC20(asset).safeTransfer(owner, profit); // lucro vai direto para a carteira do dono
        }

        unchecked {
            totalTrades += 1;
        }
        totalProfitByAsset[asset] += profit;

        emit ArbitrageExecuted(asset, p.tokenMid, amount, profit, p.buy.router, p.sell.router, msg.sender);
    }

    /**
     * @notice Callback chamado pela Aave depois de transferir o empréstimo.
     * @dev Não chame diretamente: só o Pool da Aave, em flash loans iniciados por este contrato.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Somente Aave Pool");
        require(initiator == address(this), "Iniciador invalido");

        ArbParams memory p = abi.decode(params, (ArbParams));

        // Saldo que o contrato já tinha ANTES do empréstimo: não pode ser usado para "fingir" lucro.
        uint256 preexisting = IERC20(asset).balanceOf(address(this)) - amount;

        _executeRoute(asset, amount, p);

        // ── Trava atômica de lucro ──
        uint256 amountOwed = amount + premium;
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        require(finalBalance >= preexisting + amountOwed + p.minProfit, "Sem lucro liquido");

        // Autoriza a Aave a puxar empréstimo + taxa
        IERC20(asset).forceApprove(address(POOL), amountOwed);
        return true;
    }

    function _executeRoute(address asset, uint256 amount, ArbParams memory p) internal {
        uint256 midReceived = _swap(p.buy, asset, p.tokenMid, amount, p.deadline);
        _swap(p.sell, p.tokenMid, asset, midReceived, p.deadline);
    }

    /// @dev Faz um swap "exact input" e devolve quanto de `tokenOut` realmente entrou no contrato.
    function _swap(Leg memory leg, address tokenIn, address tokenOut, uint256 amountIn, uint256 deadline)
        internal
        returns (uint256 received)
    {
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(leg.router, amountIn);

        // amountOutMinimum = 0 nas pernas é intencional: a proteção real é a trava global de lucro,
        // que reverte a transação inteira (inclusive o swap) se o resultado final não compensar.
        if (leg.kind == DexKind.UNISWAP_V3) {
            IUniswapV3SwapRouter(leg.router).exactInputSingle(
                IUniswapV3SwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: leg.fee,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        } else if (leg.kind == DexKind.ALGEBRA) {
            IAlgebraSwapRouter(leg.router).exactInputSingle(
                IAlgebraSwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    limitSqrtPrice: 0
                })
            );
        } else {
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            IUniswapV2Router02(leg.router).swapExactTokensForTokens(amountIn, 0, path, address(this), deadline);
        }

        // Zera qualquer aprovação que tenha sobrado (ex.: swap parcial por falta de liquidez)
        if (IERC20(tokenIn).allowance(address(this), leg.router) != 0) {
            IERC20(tokenIn).forceApprove(leg.router, 0);
        }

        received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        require(received > 0, "Swap sem retorno");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Administração (somente dono)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Autoriza (ou remove) uma carteira executora — ex.: a burner wallet do modo automático.
    function setExecutor(address account, bool allowed) external onlyOwner {
        require(account != address(0), "Endereco zero");
        isExecutor[account] = allowed;
        emit ExecutorUpdated(account, allowed);
    }

    /// @notice Adiciona/remove um router da lista permitida.
    function setRouter(address router, bool allowed) external onlyOwner {
        _setRouter(router, allowed);
    }

    function _setRouter(address router, bool allowed) internal {
        require(router != address(0), "Endereco zero");
        routerAllowed[router] = allowed;
        emit RouterUpdated(router, allowed);
    }

    /// @notice Inicia a transferência de propriedade (o novo dono precisa chamar acceptOwnership).
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Endereco zero");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Somente novo dono");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Saque de emergência de qualquer token. amount = 0 saca tudo.
    function withdrawToken(address token, uint256 amount) external onlyOwner nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 value = amount == 0 ? balance : amount;
        require(value > 0 && value <= balance, "Saldo insuficiente");
        IERC20(token).safeTransfer(owner, value);
        emit Withdrawn(token, owner, value);
    }

    /// @notice Saque de emergência de POL nativo. amount = 0 saca tudo.
    function withdrawNative(uint256 amount) external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        uint256 value = amount == 0 ? balance : amount;
        require(value > 0 && value <= balance, "Saldo insuficiente");
        (bool ok,) = payable(owner).call{value: value}("");
        require(ok, "Falha no envio");
        emit Withdrawn(address(0), owner, value);
    }

    /// @notice Taxa atual do flash loan da Aave em pontos-base (5 = 0,05%).
    function flashLoanFeeBps() external view returns (uint256) {
        return POOL.FLASHLOAN_PREMIUM_TOTAL();
    }

    receive() external payable {}
}
