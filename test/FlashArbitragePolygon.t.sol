// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {FlashArbitragePolygon, IERC20} from "../contracts/FlashArbitragePolygon.sol";

/*
 * Testes num FORK REAL da Polygon (estado on-chain de verdade: Aave, Uniswap, QuickSwap).
 *
 *   forge test --fork-url https://polygon-bor-rpc.publicnode.com -vvv
 *
 * Como em mercado "calmo" quase nunca existe arbitragem, os testes de lucro CRIAM uma distorção de
 * preço (uma "baleia" despeja tokens numa DEX) e verificam que o contrato captura o spread,
 * paga a Aave e manda o lucro para o dono — tudo numa transação só.
 */

interface IWPOL {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ITestV2Router {
    function factory() external view returns (address);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface ITestV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface ITestV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
}

interface ITestUniV3Router {
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

interface ITestAlgebraRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 limitSqrtPrice;
    }

    function factory() external view returns (address);
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface ITestAlgebraFactory {
    function poolByPair(address tokenA, address tokenB) external view returns (address);
}

interface ITestQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

interface ITestAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

contract FlashArbitragePolygonForkTest is Test {
    address constant WPOL = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    address constant WETH = 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619;
    address constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address constant USDCE = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;

    address constant UNI_V3 = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant QUICK_V2 = 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff;
    address constant QUICK_V3 = 0xf5b509bB0909a69B1c207E495f687a596C168E12;
    address constant SUSHI_V2 = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;

    address constant UNI_QUOTER_V2 = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;

    // Rótulos únicos: endereços "famosos" do Foundry (makeAddr("owner")...) já têm código
    // na Polygon real (robôs varredores via EIP-7702) e engoliriam o POL dos testes.
    address owner = makeAddr("flasharb.test.owner.7c1e");
    address executor = makeAddr("flasharb.test.executor.7c1e");
    address stranger = makeAddr("flasharb.test.stranger.7c1e");
    address whale = makeAddr("flasharb.test.whale.7c1e");

    FlashArbitragePolygon arb;

    function setUp() public {
        require(block.chainid == 137, "Rode com --fork-url apontando para a Polygon");
        vm.etch(owner, bytes(""));
        vm.etch(executor, bytes(""));
        vm.etch(stranger, bytes(""));
        vm.etch(whale, bytes(""));
        vm.prank(owner);
        arb = new FlashArbitragePolygon();
        vm.prank(owner);
        arb.setExecutor(executor, true);
    }

    // ───────────────────────── helpers ─────────────────────────

    function _leg(FlashArbitragePolygon.DexKind kind, address router, uint24 fee)
        internal
        pure
        returns (FlashArbitragePolygon.Leg memory)
    {
        return FlashArbitragePolygon.Leg({kind: kind, router: router, fee: fee});
    }

    function _uni(uint24 fee) internal pure returns (FlashArbitragePolygon.Leg memory) {
        return _leg(FlashArbitragePolygon.DexKind.UNISWAP_V3, UNI_V3, fee);
    }

    function _quickV2() internal pure returns (FlashArbitragePolygon.Leg memory) {
        return _leg(FlashArbitragePolygon.DexKind.UNISWAP_V2, QUICK_V2, 0);
    }

    function _quickV3() internal pure returns (FlashArbitragePolygon.Leg memory) {
        return _leg(FlashArbitragePolygon.DexKind.ALGEBRA, QUICK_V3, 0);
    }

    function _params(
        address mid,
        FlashArbitragePolygon.Leg memory buy,
        FlashArbitragePolygon.Leg memory sell,
        uint256 minProfit
    ) internal view returns (FlashArbitragePolygon.ArbParams memory) {
        return FlashArbitragePolygon.ArbParams({
            tokenMid: mid,
            buy: buy,
            sell: sell,
            minProfit: minProfit,
            deadline: block.timestamp + 120
        });
    }

    /// @dev Dá WPOL de verdade para `to` (embrulhando POL nativo, sem truques de storage).
    function _giveWpol(address to, uint256 amount) internal {
        vm.deal(to, amount);
        vm.prank(to);
        IWPOL(WPOL).deposit{value: amount}();
    }

    /// @dev Faixa de taxa da Uniswap V3 que devolve mais `tokenOut` (a liquidez muda de pool com o tempo).
    function _bestUniFee(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint24 best) {
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        uint256 bestOut;
        for (uint256 i = 0; i < fees.length; i++) {
            try ITestQuoterV2(UNI_QUOTER_V2).quoteExactInputSingle(
                ITestQuoterV2.QuoteExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    amountIn: amountIn,
                    fee: fees[i],
                    sqrtPriceLimitX96: 0
                })
            ) returns (uint256 out, uint160, uint32, uint256) {
                if (out > bestOut) {
                    bestOut = out;
                    best = fees[i];
                }
            } catch {}
        }
        require(bestOut > 0, "Nenhum pool Uniswap V3 com liquidez");
        console2.log("melhor faixa Uniswap V3 (fee):", uint256(best));
    }

    /// @dev Limita o valor emprestado para não esbarrar na liquidez disponível da Aave.
    function _cap(uint256 amount) internal pure returns (uint256) {
        return amount > 100_000 ether ? 100_000 ether : amount;
    }

    /// @dev Reserva de `token` no par QuickSwap V2 token/other.
    function _v2Reserve(address token, address other) internal view returns (uint256) {
        address pair = ITestV2Factory(ITestV2Router(QUICK_V2).factory()).getPair(token, other);
        require(pair != address(0), "Par V2 inexistente");
        (uint112 r0, uint112 r1,) = ITestV2Pair(pair).getReserves();
        return ITestV2Pair(pair).token0() == token ? uint256(r0) : uint256(r1);
    }

    function _swapV2(address from, address tokenIn, address tokenOut, uint256 amountIn) internal {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        vm.startPrank(from);
        IERC20(tokenIn).approve(QUICK_V2, amountIn);
        ITestV2Router(QUICK_V2).swapExactTokensForTokens(amountIn, 0, path, from, block.timestamp + 60);
        vm.stopPrank();
    }

    function _swapUni(address from, address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        internal
        returns (uint256 out)
    {
        vm.startPrank(from);
        IERC20(tokenIn).approve(UNI_V3, amountIn);
        out = ITestUniV3Router(UNI_V3).exactInputSingle(
            ITestUniV3Router.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: from,
                deadline: block.timestamp + 60,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
    }

    function _swapAlgebra(address from, address tokenIn, address tokenOut, uint256 amountIn) internal {
        vm.startPrank(from);
        IERC20(tokenIn).approve(QUICK_V3, amountIn);
        ITestAlgebraRouter(QUICK_V3).exactInputSingle(
            ITestAlgebraRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                recipient: from,
                deadline: block.timestamp + 60,
                amountIn: amountIn,
                amountOutMinimum: 0,
                limitSqrtPrice: 0
            })
        );
        vm.stopPrank();
    }

    /// @dev Executa a arbitragem como `executor` e confere que o lucro foi para o DONO.
    function _runAndCheckProfit(address asset, uint256 amount, FlashArbitragePolygon.ArbParams memory p)
        internal
        returns (uint256 profit)
    {
        uint256 ownerBefore = IERC20(asset).balanceOf(owner);
        uint256 executorBefore = IERC20(asset).balanceOf(executor);

        vm.prank(executor);
        uint256 gasBefore = gasleft();
        profit = arb.executeArbitrage(asset, amount, p);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("lucro (wei do ativo):", profit);
        console2.log("gas usado pela arbitragem:", gasUsed);

        assertGt(profit, 0, "deveria ter lucro");
        assertEq(IERC20(asset).balanceOf(owner) - ownerBefore, profit, "lucro precisa ir para o dono");
        assertEq(IERC20(asset).balanceOf(executor), executorBefore, "executor nao recebe nada");
        assertEq(IERC20(asset).balanceOf(address(arb)), 0, "contrato nao deve reter saldo");
        assertEq(arb.totalTrades(), 1);
        assertEq(arb.totalProfitByAsset(asset), profit);
    }

    // ───────────────────────── configuração ─────────────────────────

    function test_DeployConfig() public view {
        assertEq(arb.owner(), owner);
        assertEq(address(arb.POOL()), arb.AAVE_V3_POOL());
        assertTrue(arb.routerAllowed(UNI_V3));
        assertTrue(arb.routerAllowed(QUICK_V2));
        assertTrue(arb.routerAllowed(QUICK_V3));
        assertTrue(arb.routerAllowed(SUSHI_V2));
        assertGt(UNI_V3.code.length, 0, "Uniswap V3 router sem codigo");
        assertGt(QUICK_V2.code.length, 0, "QuickSwap V2 router sem codigo");
        assertGt(QUICK_V3.code.length, 0, "QuickSwap V3 router sem codigo");
        assertGt(SUSHI_V2.code.length, 0, "SushiSwap V2 router sem codigo");

        uint256 feeBps = arb.flashLoanFeeBps();
        console2.log("taxa do flash loan Aave (bps):", feeBps);
        assertLe(feeBps, 100, "taxa da Aave inesperadamente alta");
        assertTrue(arb.isExecutor(executor));
    }

    // ───────────────────────── trava de lucro ─────────────────────────

    /// Ida e volta no MESMO pool sempre perde as taxas -> precisa reverter.
    function test_RevertsWithoutProfit_UniV3RoundTrip() public {
        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, _uni(500), _uni(500), 0);
        vm.prank(owner);
        vm.expectRevert(bytes("Sem lucro liquido"));
        arb.executeArbitrage(WPOL, 1_000 ether, p);
    }

    function test_RevertsWithoutProfit_QuickV2RoundTrip() public {
        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, _quickV2(), _quickV2(), 0);
        vm.prank(owner);
        vm.expectRevert(bytes("Sem lucro liquido"));
        arb.executeArbitrage(WPOL, 1_000 ether, p);
    }

    /// Saldo parado no contrato NÃO pode ser usado para fingir lucro.
    function test_PreexistingBalanceIsNotProfit() public {
        _giveWpol(address(this), 1_000_000 ether);
        IWPOL(WPOL).transfer(address(arb), 1_000_000 ether);

        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, _quickV2(), _quickV2(), 0);
        vm.prank(owner);
        vm.expectRevert(bytes("Sem lucro liquido"));
        arb.executeArbitrage(WPOL, 1_000 ether, p);
    }

    // ───────────────────────── arbitragens lucrativas ─────────────────────────

    /// Baleia despeja WPOL na QuickSwap V2 (WPOL fica barato lá).
    /// Rota: empresta WPOL -> vende WPOL na Uniswap V3 (preço justo) -> recompra WPOL barato na QuickSwap V2.
    function test_Profit_UniV3_to_QuickV2() public {
        uint256 reserve = _v2Reserve(WPOL, USDCE);
        uint256 dump = reserve / 4;
        _giveWpol(whale, dump);
        _swapV2(whale, WPOL, USDCE, dump);

        uint256 amount = _cap(reserve / 200);
        uint24 fee = _bestUniFee(WPOL, USDCE, amount);
        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, _uni(fee), _quickV2(), 1);
        _runAndCheckProfit(WPOL, amount, p);
    }

    /// Caminho inverso: baleia compra muito WPOL na QuickSwap V2 (WPOL fica caro lá).
    /// Rota: empresta WPOL -> vende WPOL caro na QuickSwap V2 -> recompra na Uniswap V3.
    function test_Profit_QuickV2_to_UniV3() public {
        uint256 reserve = _v2Reserve(WPOL, USDCE);
        uint256 wpolToSpend = reserve / 6;
        _giveWpol(whale, wpolToSpend);
        // baleia consegue USDC.e na Uniswap V3 e usa tudo para comprar WPOL na QuickSwap V2
        uint256 usdce = _swapUni(whale, WPOL, USDCE, 500, wpolToSpend);
        _swapV2(whale, USDCE, WPOL, usdce);

        uint256 amount = _cap(reserve / 50);
        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, _quickV2(), _uni(500), 1);
        _runAndCheckProfit(WPOL, amount, p);
    }

    /// Mesma ideia com a QuickSwap V3 (Algebra) na perna de venda.
    function test_Profit_UniV3_to_QuickV3Algebra() public {
        address algebraPool = ITestAlgebraFactory(ITestAlgebraRouter(QUICK_V3).factory()).poolByPair(WPOL, USDCE);
        require(algebraPool != address(0), "Pool Algebra WPOL/USDC.e inexistente");
        uint256 poolWpol = IERC20(WPOL).balanceOf(algebraPool);
        console2.log("WPOL no pool Algebra:", poolWpol);

        uint256 dump = poolWpol / 3;
        _giveWpol(whale, dump);
        _swapAlgebra(whale, WPOL, USDCE, dump);

        uint256 amount = _cap(poolWpol / 60);
        uint24 fee = _bestUniFee(WPOL, USDCE, amount);
        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, _uni(fee), _quickV3(), 1);
        _runAndCheckProfit(WPOL, amount, p);
    }

    // ───────────────────────── controle de acesso ─────────────────────────

    function test_OnlyOwnerOrExecutorCanArbitrage() public {
        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, _uni(500), _quickV2(), 0);
        vm.prank(stranger);
        vm.expectRevert(bytes("Nao autorizado"));
        arb.executeArbitrage(WPOL, 1 ether, p);
    }

    function test_ExecuteOperationOnlyFromPool() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("Somente Aave Pool"));
        arb.executeOperation(WPOL, 1 ether, 0, address(arb), "");
    }

    /// Alguém de fora pede flash loan na Aave apontando para o nosso contrato: precisa reverter.
    function test_ForeignFlashLoanIsRejected() public {
        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, _uni(500), _quickV2(), 0);
        address pool = arb.AAVE_V3_POOL();
        vm.prank(stranger);
        vm.expectRevert(bytes("Iniciador invalido"));
        ITestAavePool(pool).flashLoanSimple(address(arb), WPOL, 1 ether, abi.encode(p), 0);
    }

    function test_RouterMustBeWhitelisted() public {
        FlashArbitragePolygon.Leg memory evil = _leg(FlashArbitragePolygon.DexKind.UNISWAP_V2, stranger, 0);
        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, evil, _quickV2(), 0);
        vm.prank(owner);
        vm.expectRevert(bytes("Router nao permitido"));
        arb.executeArbitrage(WPOL, 1 ether, p);
    }

    function test_ExpiredDeadline() public {
        FlashArbitragePolygon.ArbParams memory p = _params(USDCE, _uni(500), _quickV2(), 0);
        p.deadline = block.timestamp - 1;
        vm.prank(owner);
        vm.expectRevert(bytes("Expirado"));
        arb.executeArbitrage(WPOL, 1 ether, p);
    }

    function test_InvalidPair() public {
        FlashArbitragePolygon.ArbParams memory p = _params(WPOL, _uni(500), _quickV2(), 0);
        vm.prank(owner);
        vm.expectRevert(bytes("Par invalido"));
        arb.executeArbitrage(WPOL, 1 ether, p);
    }

    function test_AdminFunctionsOnlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(bytes("Somente dono"));
        arb.setExecutor(stranger, true);
        vm.expectRevert(bytes("Somente dono"));
        arb.setRouter(stranger, true);
        vm.expectRevert(bytes("Somente dono"));
        arb.withdrawToken(WPOL, 0);
        vm.expectRevert(bytes("Somente dono"));
        arb.withdrawNative(0);
        vm.expectRevert(bytes("Somente dono"));
        arb.transferOwnership(stranger);
        vm.stopPrank();

        // executor também não pode sacar
        vm.prank(executor);
        vm.expectRevert(bytes("Somente dono"));
        arb.withdrawToken(WPOL, 0);
    }

    // ───────────────────────── saques de emergência ─────────────────────────

    function test_WithdrawTokenAndNative() public {
        _giveWpol(address(this), 50 ether);
        IWPOL(WPOL).transfer(address(arb), 50 ether);
        vm.deal(address(arb), 3 ether);

        uint256 ownerWpolBefore = IERC20(WPOL).balanceOf(owner);
        uint256 ownerPolBefore = owner.balance;

        vm.startPrank(owner);
        arb.withdrawToken(WPOL, 10 ether);
        arb.withdrawToken(WPOL, 0); // 0 = tudo
        arb.withdrawNative(0);
        vm.stopPrank();

        assertEq(IERC20(WPOL).balanceOf(owner) - ownerWpolBefore, 50 ether);
        assertEq(owner.balance - ownerPolBefore, 3 ether);
        assertEq(IERC20(WPOL).balanceOf(address(arb)), 0);
        assertEq(address(arb).balance, 0);
    }

    function test_OwnershipIsTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        arb.transferOwnership(newOwner);
        assertEq(arb.owner(), owner, "ainda e o dono antigo");

        vm.prank(stranger);
        vm.expectRevert(bytes("Somente novo dono"));
        arb.acceptOwnership();

        vm.prank(newOwner);
        arb.acceptOwnership();
        assertEq(arb.owner(), newOwner);
        assertEq(arb.pendingOwner(), address(0));
    }
}
