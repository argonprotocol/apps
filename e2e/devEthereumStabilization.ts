import {
  prepareStabilizationPool,
  publishStabilizationPool,
  uniswapV4FixtureArtifacts,
  type EthereumMintingGatewayFixture,
  type PurchaseDependencies,
  type StabilizationPoolDeployment,
} from '@argonprotocol/testing';
import {
  concat,
  Contract,
  ContractFactory,
  getCreateAddress,
  keccak256,
  MaxUint256,
  toBeHex,
  ZeroAddress,
  ZeroHash,
  type InterfaceAbi,
  type Signer,
} from 'ethers';
import { createRequire } from 'node:module';
import { erc20Abi, getAddress, parseUnits, type Address } from 'viem';
import { EvmContracts } from '@argonprotocol/mainchain';
import JSBI from 'jsbi';
import type { IStartDevEthereumResult } from './devEthereum.ts';

// The SDKs' CommonJS exports support Node; their published ESM entries use extensionless imports.
const require = createRequire(import.meta.url);
const { encodeSqrtRatioX96, SqrtPriceMath } = require('@uniswap/v3-sdk') as typeof import('@uniswap/v3-sdk');
const { Actions, URVersion, V4Planner } = require('@uniswap/v4-sdk') as typeof import('@uniswap/v4-sdk');
const { CommandType, RoutePlanner, UniversalRouterVersion } =
  require('@uniswap/universal-router-sdk') as typeof import('@uniswap/universal-router-sdk');

const MaxUint128 = (1n << 128n) - 1n;
const MaxUint160 = (1n << 160n) - 1n;
const MaxUint48 = (1n << 48n) - 1n;

export interface IDevEthereumStabilization {
  poolManager?: Address;
  permit2?: Address;
  positionManager?: Address;
  router?: Address;
  deployment?: StabilizationPoolDeployment;
  liquidityTokenId?: string;
}

export async function deployDevEthereumPurchaseDependencies({
  signer,
  usdc,
  state,
  saveProgress,
}: {
  signer: Signer;
  usdc: Address;
  state: IDevEthereumStabilization;
  saveProgress: () => Promise<void>;
}): Promise<PurchaseDependencies> {
  const owner = await signer.getAddress();
  const provider = signer.provider!;

  await deploy('poolManager', [owner]);
  await deploy('permit2', []);
  await deploy('positionManager', [state.poolManager, state.permit2, 100_000, ZeroAddress, usdc]);
  await deploy('router', [
    {
      permit2: state.permit2,
      weth9: usdc,
      v2Factory: ZeroAddress,
      v3Factory: ZeroAddress,
      pairInitCodeHash: ZeroHash,
      poolInitCodeHash: ZeroHash,
      v4PoolManager: state.poolManager,
      v3NFTPositionManager: ZeroAddress,
      v4PositionManager: state.positionManager,
      spokePool: ZeroAddress,
    },
  ]);
  return { usdc, router: state.router!, permit2: state.permit2! };

  async function deploy(name: 'poolManager' | 'permit2' | 'positionManager' | 'router', args: unknown[]) {
    const savedAddress = state[name];
    if (savedAddress && (await provider.getCode(savedAddress)) !== '0x') return;

    const nonce = await signer.getNonce('pending');
    const address = getAddress(getCreateAddress({ from: owner, nonce }));
    if (savedAddress && savedAddress !== address) {
      throw new Error(
        `The ${name} deployment is pending or failed. Wait for confirmation and retry; reset the local stack if it failed.`,
      );
    }
    state[name] = address;
    await saveProgress();

    const artifact = uniswapV4FixtureArtifacts[name];
    const contract = await new ContractFactory(artifact.abi as InterfaceAbi, artifact.bytecode, signer).deploy(
      ...args,
      { nonce },
    );
    await contract.waitForDeployment();
    await saveProgress();
  }
}

export async function deployDevEthereumStabilizationPool({
  signer,
  chainId,
  usdc,
  gateway,
  state,
  saveProgress,
  initialPriceUsdc,
}: {
  signer: Signer;
  chainId: string;
  usdc: Address;
  gateway: EthereumMintingGatewayFixture;
  state: IDevEthereumStabilization;
  saveProgress: () => Promise<void>;
  initialPriceUsdc?: string;
}): Promise<StabilizationPoolDeployment> {
  if (!state.deployment) {
    if (!initialPriceUsdc) throw new Error('An initial USDC per ARGN price is required to create the pool.');
    const argonIsToken0 = BigInt(gateway.argonTokenAddress) < BigInt(usdc);
    const sqrtPriceX96 = getDevPoolSqrtPriceX96(initialPriceUsdc, argonIsToken0);
    const prepared = await prepareStabilizationPool(signer, {
      chainId: BigInt(chainId).toString(),
      argonToken: gateway.argonTokenAddress,
      usdc,
      positionManager: state.positionManager!,
      tickSpacing: 60,
      sqrtPriceX96: sqrtPriceX96.toString(),
    });
    state.deployment = { ...prepared, transactions: {} };
    await saveProgress();
  }
  const deployment = state.deployment;
  await publishStabilizationPool(signer, deployment, saveProgress);

  const positionManager = new Contract(
    deployment.pool.positionManager,
    uniswapV4FixtureArtifacts.positionManager.abi as InterfaceAbi,
    signer,
  );
  const nextTokenId = BigInt(await positionManager.nextTokenId());
  if (!state.liquidityTokenId) {
    state.liquidityTokenId = nextTokenId.toString();
    await saveProgress();
  }
  const tokenId = BigInt(state.liquidityTokenId);
  const owner = getAddress(await signer.getAddress());
  const liquidity = 5_000n * 10n ** 12n;
  let currentLiquidity = 0n;
  if (nextTokenId < tokenId) throw new Error('The saved dev liquidity position is ahead of Ethereum state.');

  if (nextTokenId > tokenId) {
    const positionOwner = getAddress(await positionManager.ownerOf(tokenId));
    const [poolKey] = await positionManager.getPoolAndPositionInfo(tokenId);
    if (positionOwner !== owner || getAddress(poolKey.hooks) !== getAddress(deployment.pool.key.hooks)) {
      throw new Error('The saved dev liquidity position belongs to a different deployment. Reset the local stack.');
    }
    currentLiquidity = await positionManager.getPositionLiquidity(tokenId);
    if (currentLiquidity === 0n) {
      throw new Error('The dev pool liquidity was removed. Reset the owning dev stack to reseed it.');
    }
    if (currentLiquidity >= liquidity) return deployment;
  }

  const permit2 = new Contract(state.permit2!, ['function approve(address,address,uint160,uint48)'], signer);
  for (const token of [gateway.argonTokenAddress, usdc]) {
    const erc20 = new Contract(token, erc20Abi, signer);
    await (await erc20.approve(state.permit2, MaxUint256)).wait();
    await (await permit2.approve(token, state.positionManager, MaxUint160, MaxUint48)).wait();
  }

  const plan = new V4Planner();
  if (currentLiquidity > 0n) {
    plan.addAction(Actions.INCREASE_LIQUIDITY, [tokenId, liquidity - currentLiquidity, MaxUint128, MaxUint128, '0x']);
  } else {
    plan.addAction(Actions.MINT_POSITION, [
      deployment.pool.key,
      -887_220,
      887_220,
      liquidity,
      MaxUint128,
      MaxUint128,
      owner,
      '0x',
    ]);
  }
  for (const token of [deployment.pool.key.currency0, deployment.pool.key.currency1]) {
    plan.addAction(Actions.SETTLE, [token, 0, true]);
  }
  const actions = plan.finalize();
  // Adding liquidity also writes a time-dependent hook observation.
  const estimatedGas = await positionManager.modifyLiquidities.estimateGas(actions, MaxUint256);
  await (
    await positionManager.modifyLiquidities(actions, MaxUint256, {
      gasLimit: (estimatedGas * 12n) / 10n + 50_000n,
    })
  ).wait();
  await saveProgress();
  return deployment;
}

/** Move the real pool through a swap; the Rust oracle observes the resulting price normally. */
export async function setDevEthereumPoolPrice({
  signer,
  ethereum,
  priceUsdc,
}: {
  signer: Signer;
  ethereum: IStartDevEthereumResult;
  priceUsdc: string;
}): Promise<{ sqrtPriceX96: bigint; transactionHash?: string }> {
  const { deployment, router, permit2 } = ethereum.stabilization ?? {};
  if (!deployment || !router || !permit2) {
    throw new Error('The local stabilization pool is unavailable. Start the owning environment with yarn dev start.');
  }
  const { pool, contracts } = deployment;
  const argonIsToken0 = getAddress(pool.key.currency1) === getAddress(ethereum.usdcTokenAddress);
  const requestedSqrtPrice = getDevPoolSqrtPriceX96(priceUsdc, argonIsToken0);
  const provider = signer.provider!;
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(ethereum.chainId)) throw new Error('The saved local Ethereum network changed.');
  const [confirmedNonce, pendingNonce] = await Promise.all([signer.getNonce('latest'), signer.getNonce('pending')]);
  if (pendingNonce > confirmedNonce) {
    throw new Error('The local admin has a pending Ethereum transaction. Wait for confirmation and retry.');
  }

  const manager = new Contract(pool.poolManager, uniswapV4FixtureArtifacts.poolManager.abi as InterfaceAbi, signer);
  // StateLibrary stores pools in mapping slot 6; slot0 and active liquidity are offsets 0 and 3.
  const poolSlot = keccak256(concat([pool.poolId, toBeHex(6, 32)]));
  const slots = await manager['extsload(bytes32,uint256)'](poolSlot, 4);
  const currentSqrtPrice = BigInt(slots[0]) & MaxUint160;
  const liquidity = BigInt(slots[3]) & MaxUint128;
  if (liquidity === 0n) throw new Error('The local stabilization pool has no active liquidity.');
  if (isPriceClose(currentSqrtPrice, requestedSqrtPrice)) return { sqrtPriceX96: currentSqrtPrice };

  const zeroForOne = requestedSqrtPrice < currentSqrtPrice;
  const sellingArgon = zeroForOne === argonIsToken0;
  const hook = new Contract(pool.key.hooks, EvmContracts.stabilizationPoolHookAbi, signer);
  const fee = BigInt(await hook[sellingArgon ? 'SELL_FEE' : 'BUY_FEE']());

  const amountIn = calculateSwapInput(currentSqrtPrice, requestedSqrtPrice, liquidity, fee);
  if (amountIn > MaxUint128) throw new Error('The requested price needs more input than the router supports.');

  const quoter = new Contract(contracts.uniswapV4PriceQuoter.address, EvmContracts.uniswapV4PriceQuoterAbi, signer);
  const [amountOut, , quotedSqrtPrice] = await quoter.quoteExactInputSingle.staticCall({
    poolKey: pool.key,
    zeroForOne,
    exactAmount: amountIn,
    hookData: '0x',
  });
  if (!isPriceClose(quotedSqrtPrice, requestedSqrtPrice)) {
    throw new Error('Liquidity changes across this price move. Choose a closer price and retry.');
  }

  const tokenIn = zeroForOne ? pool.key.currency0 : pool.key.currency1;
  const tokenOut = zeroForOne ? pool.key.currency1 : pool.key.currency0;
  const token = new Contract(tokenIn, erc20Abi, signer);
  if ((await token.balanceOf(await signer.getAddress())) < amountIn) {
    throw new Error('The local admin has insufficient tokens for this price move. Choose a closer price or fund it.');
  }
  await (await token.approve(permit2, amountIn)).wait();
  const block = await provider.getBlock('latest');
  const deadline = block!.timestamp + 300;
  const allowance = new Contract(permit2, ['function approve(address,address,uint160,uint48)'], signer);
  await (await allowance.approve(tokenIn, router, amountIn, deadline)).wait();

  const plan = new V4Planner();
  // This fixture's Router 2.1.2 swap struct includes minHopPriceX36.
  plan.addAction(
    Actions.SWAP_EXACT_IN_SINGLE,
    [{ poolKey: pool.key, zeroForOne, amountIn, amountOutMinimum: amountOut, minHopPriceX36: 0n, hookData: '0x' }],
    URVersion.V2_1_2,
  );
  plan.addAction(Actions.SETTLE_ALL, [tokenIn, amountIn]);
  plan.addAction(Actions.TAKE_ALL, [tokenOut, amountOut]);

  const route = new RoutePlanner();
  route.addCommand(CommandType.V4_SWAP, [plan.finalize()], false, UniversalRouterVersion.V2_1_2);
  const universalRouter = new Contract(router, ['function execute(bytes,bytes[],uint256) payable'], signer);
  // The mined block can add a hook observation that the estimate did not need.
  const estimatedGas = await universalRouter.execute.estimateGas(route.commands, route.inputs, deadline);
  const transaction = await universalRouter.execute(route.commands, route.inputs, deadline, {
    gasLimit: (estimatedGas * 12n) / 10n + 50_000n,
  });
  await transaction.wait();

  const after = await manager['extsload(bytes32)'](poolSlot);
  const sqrtPriceX96 = BigInt(after) & MaxUint160;
  if (!isPriceClose(sqrtPriceX96, requestedSqrtPrice)) {
    throw new Error(`Swap ${transaction.hash} confirmed, but the pool moved again. Retry with the current price.`);
  }
  return { sqrtPriceX96, transactionHash: transaction.hash };
}

/** SqrtPriceMath input delta, rounded up, including the hook's directional LP fee. */
function calculateSwapInput(fromSqrtPrice: bigint, toSqrtPrice: bigint, liquidity: bigint, fee: bigint): bigint {
  const from = JSBI.BigInt(fromSqrtPrice.toString());
  const to = JSBI.BigInt(toSqrtPrice.toString());
  const activeLiquidity = JSBI.BigInt(liquidity.toString());

  let delta: JSBI;
  if (toSqrtPrice < fromSqrtPrice) {
    delta = SqrtPriceMath.getAmount0Delta(from, to, activeLiquidity, true);
  } else {
    delta = SqrtPriceMath.getAmount1Delta(from, to, activeLiquidity, true);
  }

  const netInput = BigInt(delta.toString());
  const feeDenominator = 1_000_000n - fee;
  return (netInput * 1_000_000n + feeDenominator - 1n) / feeDenominator;
}

function getDevPoolSqrtPriceX96(priceUsdc: string, argonIsToken0: boolean): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(priceUsdc) || parseUnits(priceUsdc, 6) === 0n) {
    throw new Error('ARGN price must be a positive USDC amount with at most 6 decimal places.');
  }
  // ARGN has 18 decimals and USDC has 6; encode their base-unit ratio in Q96.
  let numerator = parseUnits(priceUsdc, 6);
  let denominator = 10n ** 18n;
  if (!argonIsToken0) [numerator, denominator] = [denominator, numerator];
  return BigInt(encodeSqrtRatioX96(numerator.toString(), denominator.toString()).toString());
}

function isPriceClose(sqrtPriceX96: bigint, requestedSqrtPrice: bigint): boolean {
  const difference = sqrtPriceX96 ** 2n - requestedSqrtPrice ** 2n;
  const absoluteDifference = difference < 0n ? -difference : difference;
  return absoluteDifference * 1_000_000n <= requestedSqrtPrice ** 2n;
}
