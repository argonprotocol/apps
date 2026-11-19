import {
  SingleFileQueue,
  StabilizerBuyContracts,
  StabilizerBuyPool,
  StabilizerBuy,
  StabilizerBuyValidationError,
  StabilizerBuyQuoteUnavailableError,
  StabilizerBuyReceiptError,
  type IStabilizerBuyPriceReference,
  MICROGONS_PER_ARGON,
  WEI_PER_ETH,
  NetworkConfig,
  type TxSigner,
} from '@argonprotocol/apps-core';
import { FIXED_U128_DECIMALS, toFixedNumber } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import {
  type PublicClient,
  type Hash,
  getAddress,
  keccak256,
  serializeTransaction,
  BaseError,
  ExecutionRevertedError,
} from 'viem';
import {
  EthereumClient,
  EthereumTransactionRevertedError,
  EthereumTransactionUnavailableError,
  buildEthereumUnsignedTransaction,
  submitEthereumTransaction,
  type IEthereumTransactionProgress,
} from './EthereumClient.ts';
import {
  createCrosschainTransferProgress,
  hydrateCrosschainTransferProgress,
  formatCrosschainBlockStepDetail,
  INBOUND_TRANSFER_STEP_TITLES,
} from './CrosschainTransferProgress.ts';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyPurchaseRecord,
  type IStabilizerBuyRecord,
  type IStabilizerBuyQuote,
} from '../interfaces/IStabilizerBuyPurchase.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { WalletForEthereum } from './WalletForEthereum.ts';
import type { StabilizerBuys } from './StabilizerBuys.ts';
import type { WalletsForEthereum } from './WalletsForEthereum.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { sleep } from './Utils.ts';
import { calculateStabilizerBuyCost } from './financials/StabilizerBuys.ts';
import {
  FinancialCacheTypes,
  type FinancialCacheTable,
  type IFinancialCacheSchemas,
} from './db/FinancialCacheTable.ts';

type PoolEstimateCache = IFinancialCacheSchemas[FinancialCacheTypes.StabilizerBuyPool];

export type StabilizerBuyPurchaseInput = Pick<
  IStabilizerBuyPurchaseRecord,
  'id' | 'ethereumQuote' | 'ethereumMaxFeeWei'
> & {
  ethereumWallet: WalletForEthereum;
  txSigner?: TxSigner;
};

/** Resumes desktop purchases; StabilizerBuys owns the durable records. */
export class StabilizerBuyPurchases {
  public data = { transactionProgressByHash: {} as Record<Hash, IEthereumTransactionProgress> };

  private readonly submissionsById = new Set<string>();
  private readonly walletQueues = new Map<string, SingleFileQueue>();
  private isClosed = false;
  private readonly contracts: StabilizerBuyContracts;
  private startupPromise?: Promise<void>;
  private historicalFees?: {
    key: string;
    client: PublicClient;
    expiresAtTick: number;
    promise: ReturnType<StabilizerBuyPurchases['readHistoricalFees']>;
  };
  private poolBands?: {
    key: string;
    poolId: string;
    client: PublicClient;
    record?: PoolEstimateCache;
    pending?: Promise<PoolEstimateCache>;
    retryAtTick: number;
  };

  constructor(
    private readonly buys: StabilizerBuys,
    private readonly walletKeys: WalletKeys,
    public readonly ethereumClient: EthereumClient,
    private readonly wallets: WalletsForEthereum,
  ) {
    this.contracts = new StabilizerBuyContracts(() => this.ethereumClient.publicClient);
  }

  public start(): Promise<void> {
    this.startupPromise ??= (async () => {
      let retryDelayMs = 1_000;

      while (!this.isClosed) {
        try {
          await this.load();
          return;
        } catch (error) {
          console.warn('[StabilizerBuyPurchases] Retrying saved purchases', error);
          await sleep(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        }
      }
    })();

    return this.startupPromise;
  }

  public async load(): Promise<void> {
    await this.buys.loadRecords();

    for (const buy of [...this.buys.data.buys].reverse()) {
      if (buy.ethereumQuote) this.resume(buy as IStabilizerBuyPurchaseRecord);
    }
  }

  public async previewPurchase({
    ethereumQuote,
    ethereumWallet,
    ethereumMaxFeeWei,
  }: Pick<StabilizerBuyPurchaseInput, 'ethereumQuote'> &
    Partial<Pick<StabilizerBuyPurchaseInput, 'ethereumWallet' | 'ethereumMaxFeeWei'>>) {
    this.assertCanQuote();
    if (ethereumWallet)
      await this.contracts.validatePurchase({
        client: await this.getFinalizedSnapshot(),
        quote: ethereumQuote,
        sourceAddress: ethereumWallet.address,
      });

    this.assertCanQuote();
    const client = this.ethereumClient.publicClient;
    const [{ gasEstimate, needsPermit }, fees] = await Promise.all([
      this.contracts.estimatePurchaseGas(ethereumQuote),
      client.estimateFeesPerGas(),
    ]);
    const feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? (await client.getGasPrice());
    const feeEstimateWei = gasEstimate * feePerGas;
    if (ethereumMaxFeeWei !== undefined && feeEstimateWei > ethereumMaxFeeWei)
      throw new StabilizerBuyValidationError('The Ethereum network fee exceeds your purchase fee limit.');
    if (ethereumWallet && (await client.getBalance({ address: ethereumQuote.sourceAddress })) < feeEstimateWei)
      throw new StabilizerBuyValidationError('Add ETH to this wallet to pay the Ethereum network fee.');

    return { feeEstimateWei, needsPermit };
  }

  public async purchase(input: StabilizerBuyPurchaseInput): Promise<IStabilizerBuyPurchaseRecord> {
    const { ethereumWallet, txSigner } = input;
    let { ethereumQuote } = input;
    if (ethereumQuote.request.deadline <= BigInt(Math.floor(Date.now() / 1000)))
      throw new StabilizerBuyValidationError('This quote has expired. Get a new quote before buying.');

    if (ethereumQuote.request.repayLiquidId !== 0n && ethereumQuote.request.repaySignature === '0x') {
      if (!txSigner) throw new StabilizerBuyValidationError('Choose the Argon wallet that owns this Liquid.');
      const repaySignature = StabilizerBuyContracts.signLiquidRepaymentAuthorization(ethereumQuote, txSigner);
      ethereumQuote = { ...ethereumQuote, request: { ...ethereumQuote.request, repaySignature } };
    }
    const buy = await this.buys.createPurchase({ ...input, ethereumQuote });
    this.resume(buy, ethereumWallet);
    return buy;
  }

  public async estimateHistoricalFees(
    input: Omit<Parameters<StabilizerBuyContracts['estimateMarketPurchaseGas']>[0], 'client'>,
  ) {
    if (this.isClosed) return;
    const client = this.ethereumClient.publicClient;
    const key = [
      this.buys.data.market?.approvedPool?.poolId,
      input.quoterAddress,
      input.sourceAddress,
      input.maxUsdcIn,
    ].join(':');
    const cached = this.historicalFees;
    if (cached?.client === client && cached.key === key && cached.expiresAtTick > this.buys.data.currentTick)
      return cached.promise;

    const promise = this.readHistoricalFees(input);
    const estimate = { client, key, expiresAtTick: Infinity, promise };
    this.historicalFees = estimate;
    // Share an in-flight read across ticks, then cache success for five ticks or failure for one.
    void promise.then(
      () => {
        estimate.expiresAtTick = this.buys.data.currentTick + 5;
      },
      () => {
        estimate.expiresAtTick = this.buys.data.currentTick + 1;
      },
    );
    return promise;
  }

  public async close(): Promise<void> {
    this.isClosed = true;
    await Promise.all([...this.walletQueues.values()].map(queue => queue.stop()));
  }

  public async quote(
    input: Omit<Parameters<StabilizerBuyContracts['quote']>[0], 'client'>,
  ): Promise<IStabilizerBuyQuote> {
    input.signal?.throwIfAborted();
    this.assertCanQuote();
    const client = await this.getFinalizedSnapshot();
    input.signal?.throwIfAborted();
    this.assertCanQuote();
    const quote = await this.contracts.quote({ ...input, client });
    this.assertCanQuote();
    return quote;
  }

  /** Background discovery reuses one pool snapshot; the buy prompt still requests an executable quote. */
  public async estimateMaxProfit({
    maxUsdcIn,
    sourceAddress,
    quoterAddress,
    cache,
    signal,
  }: {
    maxUsdcIn: bigint;
    sourceAddress: string;
    quoterAddress: IStabilizerBuyQuote['quoterAddress'];
    cache: FinancialCacheTable;
    signal?: AbortSignal;
  }) {
    this.assertCanQuote();
    signal?.throwIfAborted();
    const { approvedPool: approved, prices: index } = this.buys.data.market!;
    const sqrtPriceX96 = index && 'stabilizerPoolSqrtPriceX96' in index && index.stabilizerPoolSqrtPriceX96;
    if (!approved || !sqrtPriceX96) return;
    const key = `${approved.chainId}:${approved.poolManager.toLowerCase()}:${approved.poolId}`;
    const client = this.ethereumClient.publicClient;
    let entry = this.poolBands;
    if (!entry || entry.key !== key || entry.client !== client) {
      entry = { key, poolId: approved.poolId, client, retryAtTick: 0 };
      this.poolBands = entry;
    }
    const tick = this.buys.data.currentTick;
    const snapshot = await this.getFinalizedSnapshot();
    this.assertCanQuote();
    signal?.throwIfAborted();
    const prices = await StabilizerBuyContracts.readPriceReference(snapshot, index.tick);
    if (!prices?.ethereumUsdPrice) return;
    const minimumRewardPrincipal = snapshot.consts.balances.existentialDeposit;
    const estimate = (record: PoolEstimateCache) => {
      let currentSqrtPriceX96 = record.pool.sqrtPriceX96;
      if (index.tick > record.refreshedAtTick) currentSqrtPriceX96 = sqrtPriceX96;
      return new StabilizerBuyPool(record.pool).estimate({
        maxUsdcIn,
        sqrtPriceX96: currentSqrtPriceX96,
        prices,
        sourceAddress: getAddress(sourceAddress),
        minimumMicrogons: record.minimumMicrogons,
        minimumRewardPrincipal,
      });
    };

    const stored = entry.record;
    let refresh = !stored;
    if (stored) {
      const ticksSinceRefresh = tick - stored.refreshedAtTick;
      refresh =
        ticksSinceRefresh < 0 || ticksSinceRefresh >= 60 || Date.now() - stored.refreshedAt.getTime() >= 3_600_000;
    }
    if (refresh) {
      if (!entry.pending && tick < entry.retryAtTick) throw new Error('The pool estimate will retry shortly.');
      entry.pending ??= (async () => {
        let previous = entry.record ?? (await cache.get(FinancialCacheTypes.StabilizerBuyPool, key));
        if (previous?.definitionVersion !== 1) previous = undefined;
        this.assertCanQuote();
        signal?.throwIfAborted();
        const deployment = await this.contracts.getDeployment(snapshot, quoterAddress);
        if (deployment.identity.poolId !== approved.poolId)
          throw new StabilizerBuyQuoteUnavailableError('The approved purchase pool has changed.');
        const pool = await StabilizerBuyPool.read({
          client,
          pool: deployment.identity,
          argonIsToken0: deployment.argonIsToken0,
          previous: previous?.pool,
          signal,
        });
        const minimumMicrogons = await deployment.gateway.read.minimumSwapMicrogons({ blockNumber: pool.blockNumber });
        const record: PoolEstimateCache = {
          definitionVersion: 1,
          pool,
          minimumMicrogons,
          refreshedAt: new Date(),
          refreshedAtTick: this.buys.data.currentTick,
        };
        const candidate = await estimate(record);
        if (candidate) {
          this.assertCanQuote();
          signal?.throwIfAborted();
          const [gasEstimate, fees] = await Promise.all([
            this.contracts.estimateMarketPurchaseGas({
              client: snapshot,
              sourceAddress,
              quoterAddress,
              maxUsdcIn: candidate.request.maxUsdcIn,
            }),
            client.estimateFeesPerGas(),
          ]);
          record.gasEstimate = gasEstimate;
          record.feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? (await client.getGasPrice());
        }
        this.assertCanQuote();
        signal?.throwIfAborted();
        if (this.poolBands !== entry || this.buys.data.market?.approvedPool?.poolId !== approved.poolId)
          throw new StabilizerBuyQuoteUnavailableError('The approved purchase pool has changed.');
        await cache.upsert(FinancialCacheTypes.StabilizerBuyPool, key, record).catch(error => {
          console.warn('[StabilizerBuys] Unable to save the pool estimate cache', error);
        });
        entry.record = record;
        entry.retryAtTick = 0;
        return record;
      })();
      const pending = entry.pending;
      try {
        await pending;
      } catch (error) {
        entry.retryAtTick = this.buys.data.currentTick + 5;
        throw error;
      } finally {
        if (entry.pending === pending) entry.pending = undefined;
      }
    }

    const record = entry.record;
    if (!record) return;
    const quote = await estimate(record);
    if (!quote) return;
    // A previously untradeable pool may become tradeable before the next scheduled refresh.
    if (record.gasEstimate === undefined || record.feePerGas === undefined) {
      record.refreshedAt = new Date(0);
      return;
    }
    this.assertCanQuote();
    signal?.throwIfAborted();
    if (this.poolBands !== entry || this.buys.data.market?.approvedPool?.poolId !== approved.poolId)
      throw new StabilizerBuyQuoteUnavailableError('The approved purchase pool has changed.');
    return { quote, preview: { feeEstimateWei: record.gasEstimate * record.feePerGas } };
  }

  public invalidatePoolEstimate(poolId: string): void {
    if (this.poolBands?.poolId === poolId) this.poolBands = undefined;
  }

  /** Compare estimated net purchase profit; auction rewards are not guaranteed. */
  public async quoteMaxProfit(
    {
      onProgress,
      ...input
    }: Omit<
      Parameters<StabilizerBuyContracts['quote']>[0],
      'client' | 'ethereumBlock' | 'sizeToTarget' | 'maxUsdcIn'
    > & {
      maxUsdcIn: bigint;
      onProgress?: (quotesChecked: number) => void;
    },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    this.assertCanQuote();
    const client = this.ethereumClient.publicClient;
    const contracts = this.contracts;
    const snapshot = await this.getFinalizedSnapshot();
    signal?.throwIfAborted();
    this.assertCanQuote();
    const [ethereumBlock, fees] = await Promise.all([client.getBlock(), client.estimateFeesPerGas()]);
    const feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? (await client.getGasPrice());
    signal?.throwIfAborted();

    this.assertCanQuote();
    const request = { ...input, client: snapshot, ethereumBlock, signal };
    const minimumQuote = await contracts.quote({ ...request, maxUsdcIn: undefined, sizeToTarget: true });
    signal?.throwIfAborted();
    const minimumGas = await contracts.estimatePurchaseGas(minimumQuote, ethereumBlock);
    const assertCanQuote = () => this.assertCanQuote();
    const candidates = new Map<bigint, Awaited<ReturnType<typeof evaluate>>>();
    let quotesChecked = 0;
    let best = await evaluate(minimumQuote, minimumGas);

    const budget = input.maxUsdcIn < minimumGas.usdcBalance ? input.maxUsdcIn : minimumGas.usdcBalance;
    if (budget < minimumQuote.request.maxUsdcIn) {
      // Keep the minimum as a funding preview; no executable purchase fits this wallet yet.
      return { minimumQuote, quote: best.quote, preview: best.preview };
    }

    signal?.throwIfAborted();
    const maximum = await contracts.quote({ ...request, maxUsdcIn: budget, sizeToTarget: true });
    await evaluate(maximum);

    // Permit processing also has a cost. Check both sides of the existing allowance.
    for (const amount of [minimumGas.usdcAllowance, minimumGas.usdcAllowance + 1n]) {
      if (amount < minimumQuote.request.maxUsdcIn || amount > maximum.request.maxUsdcIn) continue;
      signal?.throwIfAborted();
      await evaluate(await contracts.quote({ ...request, maxUsdcIn: amount }));
    }

    let low = minimumQuote.request.maxUsdcIn;
    let high = maximum.request.maxUsdcIn;
    // A bounded coarse scan followed by local refinement avoids quoting every possible amount.
    for (const divisions of [8n, 4n, 4n]) {
      for (let index = 0n; index <= divisions; index++) {
        signal?.throwIfAborted();
        this.assertCanQuote();
        const amount = low + ((high - low) * index) / divisions;
        if (candidates.has(amount)) continue;
        await evaluate(await contracts.quote({ ...request, maxUsdcIn: amount }));
      }

      for (const candidate of candidates.values()) {
        if (candidate.profit < best.profit) continue;
        if (candidate.profit === best.profit && candidate.quote.request.maxUsdcIn >= best.quote.request.maxUsdcIn)
          continue;
        best = candidate;
      }

      const amounts = [...candidates.keys()].sort((a, b) => (a < b ? -1 : 1));
      const bestIndex = amounts.indexOf(best.quote.request.maxUsdcIn);
      low = amounts[Math.max(0, bestIndex - 1)];
      high = amounts[Math.min(amounts.length - 1, bestIndex + 1)];
      if (high - low <= 1n) break;
    }

    signal?.throwIfAborted();
    this.assertCanQuote();
    return { minimumQuote, quote: best.quote, preview: best.preview };

    async function evaluate(
      quote: IStabilizerBuyQuote,
      gas?: Awaited<ReturnType<StabilizerBuyContracts['estimatePurchaseGas']>>,
    ) {
      signal?.throwIfAborted();
      assertCanQuote();
      gas ??= await contracts.estimatePurchaseGas(quote, ethereumBlock);
      const preview = { feeEstimateWei: gas.gasEstimate * feePerGas, needsPermit: gas.needsPermit };
      const cost = calculateStabilizerBuyCost({ quote, feeEstimateWei: preview.feeEstimateWei });
      if (!cost) throw new StabilizerBuyValidationError('An Ethereum oracle price is required to estimate profit.');

      const candidate = { quote, preview, profit: quote.quotedMicrogonsOut - cost.investedCost };
      candidates.set(quote.request.maxUsdcIn, candidate);
      quotesChecked++;
      onProgress?.(quotesChecked);
      return candidate;
    }
  }

  public static getProgress(
    buy: IStabilizerBuyRecord,
    transactionProgressByHash: StabilizerBuyPurchases['data']['transactionProgressByHash'],
    gatewaySync?: StabilizerBuys['data']['ethereumGatewaySync'],
  ) {
    const progress = createCrosschainTransferProgress(INBOUND_TRANSFER_STEP_TITLES);
    const [ethereum, proof, argon] = progress.steps;

    if (buy.status === StabilizerBuyStatus.Failed) return progress;

    if (
      buy.status === StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon ||
      buy.status === StabilizerBuyStatus.Complete
    ) {
      for (const step of progress.steps) {
        step.status = 'complete';
        step.progressPct = 100;
      }
    } else if (buy.status === StabilizerBuyStatus.WaitingForArgonRecognition) {
      ethereum.status = 'complete';
      ethereum.progressPct = 100;
      proof.status = 'active';
      proof.detail = 'Waiting for the gateway proof on Argon.';
      const sourceBlock = buy.purchaseEthereumBlockNumber;
      const retainedBlock = gatewaySync?.ethereumBlockNumber;
      const nonce = buy.ethereumGatewayActivity?.gatewayState.gatewayActivityNonce;

      if (nonce !== undefined && gatewaySync && gatewaySync.bestGatewayActivityNonce >= nonce) {
        proof.status = 'complete';
        proof.progressPct = 100;
        argon.status = 'active';
        argon.detail = 'Waiting for finalized gateway state on Argon.';
      } else if (!gatewaySync || retainedBlock === undefined) {
        proof.detail = 'Waiting for Argon to receive finalized Ethereum state.';
      } else if (sourceBlock !== undefined && retainedBlock < BigInt(sourceBlock)) {
        const remaining = BigInt(sourceBlock) - retainedBlock;
        proof.detail = `Waiting for Argon proof of ${remaining.toLocaleString()} Ethereum blocks`;
      }
    } else {
      const observed = buy.ethereumTxHash && transactionProgressByHash[buy.ethereumTxHash];
      const expectedBlocks = observed?.expectedConfirmations ?? NetworkConfig.get().ethereumNetwork.finalityBlocks;
      const confirmations = Math.min(expectedBlocks, Math.max(0, observed?.confirmations ?? 0));

      ethereum.status = 'active';
      ethereum.progressPct = (confirmations / expectedBlocks) * 100;
      if (observed && observed.confirmations >= 0) {
        ethereum.detail = formatCrosschainBlockStepDetail({
          blockType: 'Ethereum',
          confirmations,
          expectedConfirmations: expectedBlocks,
        });
      } else ethereum.detail = 'Waiting for Ethereum transaction inclusion.';
    }

    return hydrateCrosschainTransferProgress(progress.steps);
  }

  private resume(buy: IStabilizerBuyPurchaseRecord, ethereumWallet?: WalletForEthereum): void {
    if (this.isClosed || this.submissionsById.has(buy.id)) return;
    if (!pendingEthereumStatuses.has(buy.status)) return;

    const sourceAddress = buy.ethereumQuote.sourceAddress.toLowerCase();
    let queue = this.walletQueues.get(sourceAddress);
    if (!queue) {
      queue = new SingleFileQueue();
      this.walletQueues.set(sourceAddress, queue);
    }

    this.submissionsById.add(buy.id);
    void queue
      .add(() => this.processPurchase(buy.id, ethereumWallet))
      .promise.catch(error => console.warn('[StabilizerBuyPurchases] Saved purchase will resume after restart', error))
      .finally(() => this.submissionsById.delete(buy.id));
  }

  private async processPurchase(id: string, selectedWallet?: WalletForEthereum): Promise<void> {
    while (!this.isClosed) {
      const buy = this.buys.data.buys.find(buy => buy.id === id) as IStabilizerBuyPurchaseRecord;
      if (!pendingEthereumStatuses.has(buy.status)) return;

      try {
        if (buy.status === StabilizerBuyStatus.SubmittingPurchaseOnEthereum) {
          const wallet = selectedWallet ?? (await this.wallets.resolve(buy.ethereumQuote.sourceAddress));
          if (!wallet)
            throw new StabilizerBuyValidationError('Reconnect the Ethereum wallet selected for this purchase.');

          await this.ethereumClient.withSubmissionLock(
            { chainId: buy.ethereumQuote.chainId, from: buy.ethereumQuote.sourceAddress },
            async () => {
              if (this.isClosed) return;

              const prepared = await this.build(buy, wallet);
              await this.submitTransaction({ buy, prepared, ethereumWallet: wallet });
            },
          );
        } else {
          const hash = buy.ethereumTxHash;
          const submittedAt = buy.ethereumSubmittedAt;
          if (!hash) throw new StabilizerBuyValidationError('The saved purchase has no transaction identity.');

          await this.ethereumClient.waitForTransactionFinality({
            txHash: hash,
            chainId: buy.ethereumQuote.chainId,
            submittedAtMs: submittedAt?.getTime(),
            onProgress: progress => {
              if (!this.isClosed) this.data.transactionProgressByHash[hash] = progress;
            },
          });
          const receipt = await this.ethereumClient.publicClient.getTransactionReceipt({ hash });
          if (!this.isClosed) await this.onFinalized(buy, receipt);
        }
      } catch (error) {
        if (this.isClosed) return;

        const terminal =
          error instanceof StabilizerBuyValidationError ||
          error instanceof StabilizerBuyReceiptError ||
          error instanceof EthereumTransactionRevertedError ||
          error instanceof EthereumTransactionUnavailableError;
        if (terminal) {
          try {
            await this.onFailed(buy, error);
            return;
          } catch (publicationError) {
            console.warn('[StabilizerBuyPurchases] Retrying failed purchase publication', publicationError);
          }
        } else console.warn('[StabilizerBuyPurchases] Retrying purchase confirmation', error);

        await sleep(this.ethereumClient.getTransactionFinalityPollMs());
      }
    }
  }

  private async onSubmitted(
    buy: IStabilizerBuyPurchaseRecord,
    hash: Hash,
    prepared: Awaited<ReturnType<StabilizerBuyPurchases['build']>>,
  ): Promise<void> {
    if (this.isClosed) throw new Error('The purchase operation is closed.');

    const patch: Partial<IStabilizerBuyRecord> = {
      status: StabilizerBuyStatus.ConfirmingPurchaseOnEthereum,
      ethereumTxHash: hash,
      ethereumSubmittedAt: new Date(),
      usdcApprovalFeeWei: 0n,
      usdcApprovalFeeMicrogons: 0n,
    };
    if (prepared.prices) patch.ethereumPrices = prepared.prices;
    await this.buys.recordPurchase(buy.id, patch);
  }

  private async onFinalized(
    buy: IStabilizerBuyPurchaseRecord,
    receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>,
  ): Promise<void> {
    const result = this.contracts.readPurchase(buy.ethereumQuote, receipt);
    const fee = getReceiptFeeWei(receipt);
    const patch: Partial<IStabilizerBuyRecord> = {
      ...result,
      status: StabilizerBuyStatus.WaitingForArgonRecognition,
      purchasedAt: new Date(Number(result.ethereumGatewayActivity.purchase.timestamp) * 1000),
      ethereumConfirmedAt: new Date(),
      ethereumFeeWei: fee,
    };

    const prices = buy.ethereumPrices;
    if (prices) {
      const numerator =
        result.ethereumGatewayActivity.purchase.usdcSpent * toFixedNumber(prices.usdcUsdPrice, FIXED_U128_DECIMALS);
      const denominator = toFixedNumber(prices.argonUsdTargetPrice, FIXED_U128_DECIMALS);
      patch.spentMicrogons = (numerator + denominator - 1n) / denominator;
    }
    const cost = getFeeMicrogons(fee, prices);
    if (cost !== undefined) patch.ethereumFeeMicrogons = cost;
    await this.buys.recordPurchase(buy.id, patch);
  }

  private async onFailed(buy: IStabilizerBuyPurchaseRecord, error: Error): Promise<void> {
    const patch: Partial<IStabilizerBuyPurchaseRecord> = {
      status: StabilizerBuyStatus.Failed,
      statusError: error.message,
    };
    if (error instanceof StabilizerBuyValidationError || error instanceof EthereumTransactionRevertedError)
      patch.spentMicrogons = 0n;
    if (!buy.ethereumTxHash) patch.ethereumFeeMicrogons = 0n;
    if (!buy.usdcApprovalTxHash) patch.usdcApprovalFeeMicrogons = 0n;

    if (error instanceof EthereumTransactionRevertedError || error instanceof StabilizerBuyReceiptError) {
      if (buy.ethereumTxHash) {
        const receipt = await this.ethereumClient.publicClient.getTransactionReceipt({ hash: buy.ethereumTxHash });
        const fee = getReceiptFeeWei(receipt);
        patch.ethereumFeeWei = fee;
        const cost = getFeeMicrogons(fee, buy.ethereumPrices);
        if (cost !== undefined) patch.ethereumFeeMicrogons = cost;
      }
    }

    await this.buys.recordPurchase(buy.id, patch);
  }

  private async build(purchase: IStabilizerBuyPurchaseRecord, ethereumWallet: WalletForEthereum) {
    const { ethereumQuote: quote, ethereumMaxFeeWei } = purchase;
    const client = await this.getFinalizedSnapshot();
    let permit: Parameters<StabilizerBuyContracts['buildNextTransaction']>[0]['permit'];
    const { needsPermit } = await this.contracts.validatePurchase({
      client,
      quote,
      sourceAddress: ethereumWallet.address,
    });
    if (needsPermit) {
      const { tokenName, tokenVersion, nonce } = await this.contracts.readUsdcPermit(quote);
      await this.ethereumClient.configureSignerPolicy(undefined, {
        tokenAddress: quote.usdcToken,
        spenderAddress: quote.adapterAddress,
      });
      const signature = await this.walletKeys.signEthereumPermit({
        tokenAddress: quote.usdcToken,
        tokenName,
        tokenVersion,
        spenderAddress: quote.adapterAddress,
        value: quote.request.maxUsdcIn,
        nonce,
        deadline: quote.request.deadline,
        wallet: ethereumWallet,
      });
      permit = { ...signature, deadline: quote.request.deadline };
    }
    const { to, data, prices } = await this.contracts.buildNextTransaction({
      client,
      quote,
      sourceAddress: ethereumWallet.address,
      permit,
    });

    const publicClient = this.ethereumClient.publicClient;
    const prepared = await buildEthereumUnsignedTransaction({
      publicClient,
      from: quote.sourceAddress,
      chainId: quote.chainId,
      to,
      data,
    }).catch(error => {
      if (
        permit &&
        error instanceof BaseError &&
        error.walk(cause => cause instanceof ExecutionRevertedError) instanceof ExecutionRevertedError
      )
        throw new StabilizerBuyValidationError(
          'Permit-and-buy could not be prepared. Request a new quote; this network may need an updated purchase adapter.',
        );
      throw error;
    });
    if (ethereumMaxFeeWei !== undefined && prepared.feeEstimateWei > ethereumMaxFeeWei)
      throw new StabilizerBuyValidationError('The Ethereum network fee exceeds your purchase fee limit.');
    if ((await publicClient.getBalance({ address: quote.sourceAddress })) < prepared.feeEstimateWei)
      throw new StabilizerBuyValidationError('Add ETH to this wallet to pay the Ethereum network fee.');

    await this.ethereumClient.configureSignerPolicy();

    return { ...prepared, prices };
  }

  private async submitTransaction({
    buy,
    prepared,
    ethereumWallet,
  }: {
    buy: IStabilizerBuyPurchaseRecord;
    prepared: Awaited<ReturnType<StabilizerBuyPurchases['build']>>;
    ethereumWallet: WalletForEthereum;
  }): Promise<Hash> {
    const signature = await this.walletKeys.signEthereumTransaction(
      prepared.unsignedTransaction,
      this.walletKeys.ethereumHdPath,
      ethereumWallet,
    );
    const serializedTransaction = serializeTransaction(prepared.transaction, signature);

    await this.onSubmitted(buy, keccak256(serializedTransaction), prepared);

    return submitEthereumTransaction({
      publicClient: this.ethereumClient.publicClient,
      serializedTransaction,
      fallbackErrorMessage: 'Unable to submit the Ethereum purchase transaction.',
    });
  }

  private assertCanQuote(): void {
    const poolId = this.buys.data.market?.approvedPool?.poolId;
    if (this.buys.pendingEthereumPurchases.some(buy => buy.ethereumQuote.poolId === poolId))
      throw new StabilizerBuyQuoteUnavailableError('A purchase is still pending on Ethereum for this pool.');
    if (this.isClosed || this.buys.buyDiscountPercent === undefined)
      throw new StabilizerBuyQuoteUnavailableError('There is no purchase available below the target price.');
  }

  private async readHistoricalFees(
    input: Omit<Parameters<StabilizerBuyContracts['estimateMarketPurchaseGas']>[0], 'client'>,
  ) {
    const mainchain = await getMainchainClient(false);
    const snapshot = await this.getFinalizedSnapshot();
    if (this.isClosed) return;
    const [gas, fees, prices, bidFee] = await Promise.all([
      this.contracts.estimateMarketPurchaseGas({ ...input, client: snapshot }),
      this.ethereumClient.publicClient.estimateFeesPerGas(),
      StabilizerBuyContracts.readPriceReference(snapshot),
      StabilizerBuy.estimateBidFee({
        client: mainchain,
        account: this.buys.accountAddress,
        admissionFrame: this.buys.data.currentFrameId,
        rewardPercent: 100,
      }),
    ]);
    if (!prices?.ethereumUsdPrice) return;

    const feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? (await this.ethereumClient.publicClient.getGasPrice());
    return { ethereumFeeWei: gas * feePerGas, bidFee, prices };
  }

  private async getFinalizedSnapshot() {
    const client = await getMainchainClient(false);
    return runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
  }
}

function getReceiptFeeWei(receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>): bigint {
  return receipt.gasUsed * receipt.effectiveGasPrice + (receipt.blobGasUsed ?? 0n) * (receipt.blobGasPrice ?? 0n);
}

function getFeeMicrogons(wei: bigint, prices?: IStabilizerBuyPriceReference): bigint | undefined {
  if (wei === 0n) return 0n;
  if (!prices?.ethereumUsdPrice) return;

  const numerator = wei * toFixedNumber(prices.ethereumUsdPrice, FIXED_U128_DECIMALS) * BigInt(MICROGONS_PER_ARGON);
  const denominator = toFixedNumber(prices.argonUsdTargetPrice, FIXED_U128_DECIMALS) * WEI_PER_ETH;

  return (numerator + denominator - 1n) / denominator;
}

const pendingEthereumStatuses = new Set([
  StabilizerBuyStatus.SubmittingPurchaseOnEthereum,
  StabilizerBuyStatus.ConfirmingPurchaseOnEthereum,
]);
