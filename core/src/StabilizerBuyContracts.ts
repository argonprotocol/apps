import { EvmContracts, MICROGONS_PER_ARGON, decodeEthereumGatewayActivityLog } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import {
  type Address,
  type Block,
  type ContractFunctionArgs,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  getContract,
  encodeAbiParameters,
  keccak256,
  maxUint160,
  formatUnits,
  toHex,
} from 'viem';
import type { LiveQueryRecord } from '@argonprotocol/runtime-client';
import type { ArgonCurrentQueryClient } from './MainchainClients.js';
import { toArgonAccountIdHex } from './Ethereum.js';
import { bigNumberToBigInt } from './utils.js';
import { FIXED_U128_ONE } from './FixedU128.js';

export interface IStabilizerBuyQuote {
  chainId: number;
  gatewayAddress: Address;
  adapterAddress: Address;
  quoterAddress: Address;
  sourceAddress: Address;
  poolId: Hex;
  poolManager: Address;
  usdcToken: Address;
  poolKey: ContractFunctionArgs<typeof EvmContracts.argonBuyAndTransferAbi, 'nonpayable', 'buyAndTransfer'>[1];
  request: EvmContracts.ArgonBuyAndTransferRequest;
  quotedMicrogonsOut: bigint;
  minimumRewardPrincipal: bigint;
  qualifiesForRewards: boolean;
  sqrtPriceX96After: bigint;
  swapGasEstimate: bigint;
  prices?: IStabilizerBuyPriceReference;
}

type OracleIndex = Extract<NonNullable<LiveQueryRecord<'priceIndex', 'current'>>, { usdcUsdPrice: BigNumber | null }>;
export type IStabilizerBuyPriceReference = Pick<OracleIndex, 'tick' | 'argonUsdTargetPrice'> & {
  usdcUsdPrice: NonNullable<OracleIndex['usdcUsdPrice']>;
} & Partial<Pick<NonNullable<LiveQueryRecord<'priceIndex', 'currentEthereumPrice'>>, 'ethereumUsdPrice'>>;

type ApprovedPool = NonNullable<LiveQueryRecord<'stabilizerBuys', 'approvedPool'>>;
type EthereumConfig = Extract<
  NonNullable<LiveQueryRecord<'crosschainTransfer', 'chainConfigBySourceChain'>>,
  { type: 'Evm' }
>['value'];

export class StabilizerBuyValidationError extends Error {}
export class StabilizerBuyQuoteUnavailableError extends StabilizerBuyValidationError {}
export class StabilizerBuyAmountTooSmallError extends StabilizerBuyValidationError {}
export class StabilizerBuyReceiptError extends Error {}

/** Current Ethereum purchase protocol; application workflows own signing and persistence. */
export class StabilizerBuyContracts {
  private deployment?: {
    client: PublicClient;
    key: string;
    promise: ReturnType<StabilizerBuyContracts['readDeployment']>;
  };

  constructor(private readonly getPublicClient: () => PublicClient) {}

  /** Exact amounts preserve the requested spend; optional target sizing finds a below-target purchase. */
  public async quote({
    client: snapshot,
    maxUsdcIn,
    slippageBps,
    deadline,
    destinationAddress,
    sourceAddress,
    quoterAddress,
    sizeToTarget = false,
    ethereumBlock,
  }: {
    client: ArgonCurrentQueryClient;
    maxUsdcIn?: bigint;
    slippageBps: number;
    deadline: bigint;
    destinationAddress: string;
    sourceAddress: string;
    quoterAddress: Address;
    sizeToTarget?: boolean;
    ethereumBlock?: Block<bigint, false, 'latest'>;
  }): Promise<IStabilizerBuyQuote> {
    if (maxUsdcIn !== undefined && (maxUsdcIn <= 0n || maxUsdcIn >= 1n << 128n))
      throw new StabilizerBuyValidationError('Choose a positive USDC purchase amount.');
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000)
      throw new StabilizerBuyValidationError('Choose slippage from 0 to 9999 basis points.');

    const [deployment, prices] = await Promise.all([
      this.getDeployment(snapshot, quoterAddress, ethereumBlock?.number),
      StabilizerBuyContracts.readPriceReference(snapshot),
    ]);
    if (!prices) throw new StabilizerBuyValidationError('The purchase price reference is unavailable or stale.');
    const { usdcUsdPrice, argonUsdTargetPrice } = prices;

    const { gateway, quoter, identity, argonIsToken0 } = deployment;
    const [minimum, block] = await Promise.all([
      gateway.read.minimumSwapMicrogons({ blockNumber: ethereumBlock?.number }),
      ethereumBlock ?? this.getPublicClient().getBlock(),
    ]);
    if (deadline <= block.timestamp)
      throw new StabilizerBuyValidationError('The purchase deadline has expired. Request a new quote.');

    // Uniswap v4 StateLibrary stores PoolManager's pools mapping at slot 6; slot0 holds its starting price.
    const poolSlot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [identity.poolId, 6n]));
    const slot0 = await this.getPublicClient().getStorageAt({
      address: identity.poolManager,
      slot: poolSlot,
      blockNumber: block.number,
    });
    if (!slot0) throw new StabilizerBuyQuoteUnavailableError('The purchase pool price is unavailable. Retry shortly.');
    const sqrtPriceX96Before = BigInt(slot0) & maxUint160;

    if (maxUsdcIn === undefined) {
      const output = bigNumberToBigInt(
        BigNumber.maximum(minimum, 1)
          .times(10_000)
          .div(10_000 - slippageBps),
        true,
      );
      const {
        result: [amountIn],
      } = await quoter.simulate.quoteExactOutputSingle(
        [
          {
            poolKey: identity.poolKey,
            zeroForOne: !argonIsToken0,
            exactAmount: output * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
            hookData: '0x',
          },
        ],
        { account: getAddress(sourceAddress), blockNumber: block.number },
      );
      maxUsdcIn = amountIn;
    }

    let quote = await quoteAmount(maxUsdcIn);
    if (sizeToTarget && !quote.isBelowTarget) {
      let belowTargetUsdc = 0n;
      let atTargetUsdc = maxUsdcIn;
      while (atTargetUsdc - belowTargetUsdc > 1n) {
        const amount = (belowTargetUsdc + atTargetUsdc) / 2n;
        const candidate = await quoteAmount(amount);
        if (candidate.isBelowTarget) {
          belowTargetUsdc = amount;
          quote = candidate;
        } else atTargetUsdc = amount;

        // Stop within 0.5% of capacity, but refine to base units if the gateway minimum is still in doubt.
        const meetsMinimum = quote.minMicrogonsOut > 0n && quote.minMicrogonsOut >= minimum;
        if (quote.isBelowTarget && meetsMinimum && atTargetUsdc - belowTargetUsdc <= belowTargetUsdc / 200n) break;
      }

      if (!quote.isBelowTarget)
        throw new StabilizerBuyQuoteUnavailableError('There is no purchase available below the target price.');
      if (quote.minMicrogonsOut < minimum || quote.minMicrogonsOut === 0n)
        throw new StabilizerBuyQuoteUnavailableError(
          'There is no purchase available that meets the minimum amount below target.',
        );
      maxUsdcIn = belowTargetUsdc;
    }

    const { quotedMicrogonsOut, minMicrogonsOut, sqrtPriceX96After, swapGasEstimate } = quote;
    if (minMicrogonsOut < minimum || minMicrogonsOut === 0n)
      throw new StabilizerBuyAmountTooSmallError(`Minimum purchase amount: ${formatUnits(minimum, 6)} ARGN.`);

    const minimumRewardPrincipal = snapshot.consts.balances.existentialDeposit;
    const targetUsd = bigNumberToBigInt(argonUsdTargetPrice.times(FIXED_U128_ONE));
    const usdcUsd = bigNumberToBigInt(usdcUsdPrice.times(FIXED_U128_ONE));
    const microgonsPerArgon = BigInt(MICROGONS_PER_ARGON);
    const targetValueUsd = (quotedMicrogonsOut * targetUsd) / microgonsPerArgon;
    const spentUsd = (maxUsdcIn * usdcUsd + microgonsPerArgon - 1n) / microgonsPerArgon;
    let capturedDiscount = 0n;
    if (targetValueUsd > spentUsd) capturedDiscount = ((targetValueUsd - spentUsd) * microgonsPerArgon) / targetUsd;

    // Compare the starting-price ratio before division so equality at the one-cent cutoff stays eligible.
    const squaredStartPrice = sqrtPriceX96Before * sqrtPriceX96Before;
    const q192 = 1n << 192n;
    let priceNumerator = squaredStartPrice * 1_000_000_000_000n * usdcUsd;
    let priceDenominator = q192;
    if (!argonIsToken0) {
      priceNumerator = q192 * 1_000_000_000_000n * usdcUsd;
      priceDenominator = squaredStartPrice;
    }
    const maximumStartPrice = targetUsd - FIXED_U128_ONE / 100n;
    const priceIncreased = argonIsToken0
      ? sqrtPriceX96After > sqrtPriceX96Before
      : sqrtPriceX96After < sqrtPriceX96Before;
    const qualifiesForRewards =
      sqrtPriceX96Before > 0n &&
      priceIncreased &&
      quotedMicrogonsOut >= minimumRewardPrincipal &&
      capturedDiscount > 0n &&
      priceNumerator <= maximumStartPrice * priceDenominator;

    return {
      ...identity,
      sourceAddress: getAddress(sourceAddress),
      request: {
        argonAccountId: toArgonAccountIdHex(destinationAddress),
        maxUsdcIn,
        minMicrogonsOut,
        deadline,
        repayLiquidId: 0n,
        repaySignature: '0x',
      },
      quotedMicrogonsOut,
      minimumRewardPrincipal,
      qualifiesForRewards,
      sqrtPriceX96After,
      swapGasEstimate,
      prices,
    };

    async function quoteAmount(amount: bigint) {
      const {
        result: [amountOut, swapGasEstimate, sqrtPriceX96After],
      } = await quoter.simulate.quoteExactInputSingle(
        [{ poolKey: identity.poolKey, zeroForOne: !argonIsToken0, exactAmount: amount, hookData: '0x' }],
        { account: getAddress(sourceAddress), blockNumber: block.number },
      );
      const quotedMicrogonsOut = amountOut / EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
      return {
        quotedMicrogonsOut,
        minMicrogonsOut: (quotedMicrogonsOut * BigInt(10_000 - slippageBps)) / 10_000n,
        sqrtPriceX96After,
        swapGasEstimate,
        isBelowTarget: poolPriceUsd(sqrtPriceX96After).lt(argonUsdTargetPrice),
      };
    }

    function poolPriceUsd(sqrtPriceX96: bigint): BigNumber {
      const ratio = BigNumber(sqrtPriceX96)
        .div((1n << 96n).toString())
        .pow(2);
      let priceUsdc = ratio.times(1e12);
      if (!argonIsToken0) priceUsdc = BigNumber(1e12).div(ratio);
      return priceUsdc.times(usdcUsdPrice);
    }
  }

  /** The quoter supports purchase previews before the wallet is funded or approved. */
  public async estimatePurchaseGas(quote: IStabilizerBuyQuote, blockNumber?: bigint) {
    const { sourceAddress, usdcToken, adapterAddress, request, poolKey, swapGasEstimate } = quote;
    const client = this.getPublicClient();
    const usdc = getContract({ address: usdcToken, abi: erc20Abi, client });
    const [allowance, balance] = await Promise.all([
      usdc.read.allowance([sourceAddress, adapterAddress], { blockNumber }),
      usdc.read.balanceOf([sourceAddress], { blockNumber }),
    ]);
    const needsApproval = allowance < request.maxUsdcIn;
    // Covers adapter transfers, Permit2/router settlement, and the gateway burn/activity locator.
    let purchaseGas = swapGasEstimate + 400_000n;
    let approvalGas = 0n;

    if (needsApproval) {
      approvalGas = await usdc.estimateGas.approve([adapterAddress, request.maxUsdcIn], {
        account: sourceAddress,
        gasPrice: 0n,
        blockNumber,
      });
      approvalGas = (approvalGas * 12n) / 10n + 50_000n;
    } else {
      if (balance >= request.maxUsdcIn) {
        const adapter = getContract({ address: adapterAddress, abi: EvmContracts.argonBuyAndTransferAbi, client });
        purchaseGas = await adapter.estimateGas.buyAndTransfer([request, poolKey, '0x'], {
          account: sourceAddress,
          gasPrice: 0n,
          blockNumber,
        });
      }
    }

    // Each transaction uses the same gas margin as the unsigned transaction builder.
    return {
      gasEstimate: (purchaseGas * 12n) / 10n + 50_000n + approvalGas,
      needsApproval,
      usdcAllowance: allowance,
      usdcBalance: balance,
    };
  }

  /** Provisional fees for historical modeling, including a fresh approval; this does not validate a purchase. */
  public async estimateMarketPurchaseGas({
    client,
    quoterAddress,
    sourceAddress,
    maxUsdcIn,
  }: Required<
    Pick<Parameters<StabilizerBuyContracts['quote']>[0], 'client' | 'quoterAddress' | 'sourceAddress' | 'maxUsdcIn'>
  >) {
    const { quoter, identity, argonIsToken0 } = await this.getDeployment(client, quoterAddress);
    const usdc = getContract({ address: identity.usdcToken, abi: erc20Abi, client: this.getPublicClient() });
    const [
      {
        result: [, swapGas],
      },
      approvalGas,
    ] = await Promise.all([
      quoter.simulate.quoteExactInputSingle(
        [{ poolKey: identity.poolKey, zeroForOne: !argonIsToken0, exactAmount: maxUsdcIn, hookData: '0x' }],
        { account: getAddress(sourceAddress) },
      ),
      usdc.estimateGas.approve([identity.adapterAddress, maxUsdcIn], {
        account: getAddress(sourceAddress),
        gasPrice: 0n,
      }),
    ]);

    const purchaseGas = swapGas + 400_000n;
    return ((purchaseGas + approvalGas) * 12n) / 10n + 100_000n;
  }

  public async buildNextTransaction({
    client,
    quote,
    sourceAddress,
  }: {
    client: ArgonCurrentQueryClient;
    quote: IStabilizerBuyQuote;
    sourceAddress: string;
  }) {
    if (getAddress(sourceAddress) !== quote.sourceAddress)
      throw new StabilizerBuyValidationError('Use the wallet that approved this purchase.');

    const fresh = await this.quote({
      client,
      maxUsdcIn: quote.request.maxUsdcIn,
      slippageBps: 0,
      deadline: quote.request.deadline,
      destinationAddress: quote.request.argonAccountId,
      sourceAddress: quote.sourceAddress,
      quoterAddress: quote.quoterAddress,
    });
    if (
      fresh.adapterAddress !== quote.adapterAddress ||
      fresh.poolId !== quote.poolId ||
      fresh.chainId !== quote.chainId
    )
      throw new StabilizerBuyValidationError('The approved purchase deployment changed. Request a new quote.');
    if (fresh.quotedMicrogonsOut < quote.request.minMicrogonsOut)
      throw new StabilizerBuyValidationError('The purchase no longer meets your minimum output.');

    const usdc = getContract({ address: quote.usdcToken, abi: erc20Abi, client: this.getPublicClient() });
    const [allowance, balance] = await Promise.all([
      usdc.read.allowance([quote.sourceAddress, quote.adapterAddress]),
      usdc.read.balanceOf([quote.sourceAddress]),
    ]);
    if (balance < quote.request.maxUsdcIn)
      throw new StabilizerBuyValidationError('This wallet does not have enough USDC for the purchase.');

    const needsApproval = allowance < quote.request.maxUsdcIn;
    if (needsApproval)
      return {
        to: quote.usdcToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [quote.adapterAddress, quote.request.maxUsdcIn],
        }),
        needsApproval,
        prices: fresh.prices,
      };
    return {
      to: quote.adapterAddress,
      data: encodeFunctionData({
        abi: EvmContracts.argonBuyAndTransferAbi,
        functionName: 'buyAndTransfer',
        args: [quote.request, quote.poolKey, '0x'],
      }),
      needsApproval,
      prices: fresh.prices,
    };
  }

  /** Uses the native purchase pallet's newest accepted observation, including invalid observations. */
  public static async readPriceReference(
    client: ArgonCurrentQueryClient,
    tick?: number,
  ): Promise<IStabilizerBuyPriceReference | undefined> {
    const now = await client.query.ticks.currentTick();
    if (now === null) return;

    tick ??= now;
    const rules = client.consts.stabilizerBuys;
    if (tick > now || !rules) return;

    const ticks = Array.from({ length: Math.min(tick, rules.maxPriceAgeTicks) + 1 }, (_, index) => tick - index);
    const [observations, ethereum] = await Promise.all([
      client.query.stabilizerBuys.priceHistoryByTick.multi(ticks.map(value => toHex(value, { size: 8 }))),
      client.query.priceIndex.currentEthereumPrice(),
    ]);
    const index = observations?.findIndex(observation => observation !== null) ?? -1;
    if (index < 0) return;

    const accepted = observations![index]?.prices;
    if (!accepted) return;

    const prices: IStabilizerBuyPriceReference = {
      tick: ticks[index],
      argonUsdTargetPrice: accepted.argonUsdTargetPrice,
      usdcUsdPrice: accepted.microgonsAtTargetPerUsdc
        .times(accepted.argonUsdTargetPrice)
        .shiftedBy(12)
        .integerValue(BigNumber.ROUND_FLOOR)
        .shiftedBy(-18),
    };
    if (prices.argonUsdTargetPrice.lte(0) || prices.usdcUsdPrice.lte(0)) return;

    if (
      ethereum?.ethereumUsdPrice.gt(0) &&
      BigInt(now) - BigInt(ethereum.tick) <= client.consts.priceIndex.maxDowntimeTicksBeforeReset
    )
      return { ...prices, ethereumUsdPrice: ethereum.ethereumUsdPrice };
    return prices;
  }

  public readPurchase(quote: IStabilizerBuyQuote, receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>) {
    if (
      receipt.from.toLowerCase() !== quote.sourceAddress.toLowerCase() ||
      receipt.to?.toLowerCase() !== quote.adapterAddress.toLowerCase()
    )
      throw new StabilizerBuyReceiptError('The purchase receipt does not match its approved sender and adapter.');

    for (const [sourceLogIndex, log] of receipt.logs.entries()) {
      if (log.address.toLowerCase() !== quote.gatewayAddress.toLowerCase()) continue;
      if (log.topics[0]?.toLowerCase() !== EvmContracts.MintingGatewayEvents.TransferToArgonFromSwapStarted.topic)
        continue;

      const activity = decodeEthereumGatewayActivityLog({ data: log.data, topics: [...log.topics] });
      if (activity.kind !== 'TransferToArgonFromSwapStarted') continue;

      const purchase = activity.purchase;
      if (purchase.buyer.toLowerCase() !== quote.sourceAddress.toLowerCase()) continue;
      if (purchase.argonAccountId.toLowerCase() !== quote.request.argonAccountId.toLowerCase()) continue;
      if (purchase.usdcToken.toLowerCase() !== quote.usdcToken.toLowerCase()) continue;
      if (purchase.poolManager.toLowerCase() !== quote.poolManager.toLowerCase()) continue;
      if (purchase.poolId.toLowerCase() !== quote.poolId.toLowerCase()) continue;
      if (purchase.usdcSpent > quote.request.maxUsdcIn || activity.amount < quote.request.minMicrogonsOut) continue;

      return {
        ethereumGatewayActivity: activity,
        purchaseEthereumBlockNumber: Number(receipt.blockNumber),
        purchaseEthereumBlockHash: receipt.blockHash,
        purchaseEthereumLogIndex: sourceLogIndex,
      };
    }

    throw new StabilizerBuyReceiptError('The purchase receipt has no matching gateway purchase.');
  }

  private async getDeployment(snapshot: ArgonCurrentQueryClient, quoterAddress: Address, blockNumber?: bigint) {
    const [approved, config] = await Promise.all([
      snapshot.query.stabilizerBuys.approvedPool(),
      snapshot.query.crosschainTransfer.chainConfigBySourceChain('Ethereum'),
    ]);
    if (approved === undefined)
      throw new StabilizerBuyValidationError('Upgrade the Argon runtime to use Stabilizer Buys.');
    if (!approved)
      throw new StabilizerBuyValidationError('Stabilizer Buys has no approved purchase pool on this network.');
    if (config?.type !== 'Evm') throw new StabilizerBuyValidationError('The Ethereum gateway is not configured.');

    const client = this.getPublicClient();
    const chainId = await client.getChainId();
    if (approved.chainId !== BigInt(chainId) || config.value.chainId !== BigInt(chainId))
      throw new StabilizerBuyValidationError('The Ethereum RPC does not match the approved purchase network.');
    const gateway = getContract({
      address: getAddress(config.value.gateway),
      abi: EvmContracts.mintingGatewayAbi,
      client,
    });

    // The gateway adapter can change; immutable contract bindings are reused only for this exact deployment and client.
    const adapterAddress = await gateway.read.swapContract({ blockNumber });
    const key = [
      chainId,
      gateway.address,
      adapterAddress,
      quoterAddress,
      approved.poolId,
      approved.poolManager,
      approved.usdcToken,
      approved.argonIsToken0,
      config.value.argonToken,
    ]
      .join(':')
      .toLowerCase();

    if (this.deployment?.key !== key || this.deployment.client !== client) {
      const promise = this.readDeployment({
        client,
        snapshot,
        approved,
        config: config.value,
        adapterAddress,
        quoterAddress,
      });
      this.deployment = { client, key, promise };
      void promise.catch(() => {
        if (this.deployment?.promise === promise) this.deployment = undefined;
      });
    }

    return this.deployment.promise;
  }

  private async readDeployment({
    client,
    snapshot,
    approved,
    config,
    adapterAddress,
    quoterAddress,
  }: {
    client: PublicClient;
    snapshot: ArgonCurrentQueryClient;
    approved: ApprovedPool;
    config: EthereumConfig;
    adapterAddress: Address;
    quoterAddress: Address;
  }) {
    const gateway = getContract({ address: getAddress(config.gateway), abi: EvmContracts.mintingGatewayAbi, client });
    const adapter = getContract({ address: adapterAddress, abi: EvmContracts.argonBuyAndTransferAbi, client });
    const quoter = getContract({ address: quoterAddress, abi: EvmContracts.uniswapV4PriceQuoterAbi, client });
    const [registered, adapterGateway, argon, usdcAddress, poolManager, quoterManager] = await Promise.all([
      snapshot.query.stabilizerPools.pools(approved.poolManager, approved.poolId),
      adapter.read.gateway(),
      adapter.read.argon(),
      adapter.read.usdc(),
      adapter.read.poolManager(),
      quoter.read.poolManager(),
    ]);
    if (!registered) throw new StabilizerBuyValidationError('The approved purchase pool is not registered.');
    if (getAddress(adapterGateway) !== gateway.address || getAddress(argon) !== getAddress(config.argonToken))
      throw new StabilizerBuyValidationError(
        'The purchase adapter does not match the configured gateway and ARGN token.',
      );
    if (getAddress(usdcAddress) !== getAddress(approved.usdcToken))
      throw new StabilizerBuyValidationError('The purchase adapter uses another USDC token.');
    if (
      getAddress(poolManager) !== getAddress(approved.poolManager) ||
      getAddress(quoterManager) !== getAddress(poolManager)
    )
      throw new StabilizerBuyValidationError('The purchase adapter and quoter must use the approved PoolManager.');

    const poolKey = {
      ...registered.key,
      currency0: getAddress(registered.key.currency0),
      currency1: getAddress(registered.key.currency1),
      hooks: getAddress(registered.key.hooks),
      tickSpacing: Number(registered.key.tickSpacing),
    };

    return {
      gateway,
      quoter,
      argonIsToken0: approved.argonIsToken0,
      identity: {
        chainId: Number(config.chainId),
        gatewayAddress: gateway.address,
        adapterAddress,
        quoterAddress,
        poolId: approved.poolId as Hex,
        poolManager: getAddress(poolManager),
        usdcToken: getAddress(usdcAddress),
        poolKey,
      },
    };
  }
}
