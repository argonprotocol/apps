import {
  SingleFileQueue,
  StabilizerBuyContracts,
  StabilizerBuy,
  StabilizerBuyValidationError,
  StabilizerBuyReceiptError,
  type IStabilizerBuyPriceReference,
  MICROGONS_PER_ARGON,
  WEI_PER_ETH,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { FIXED_U128_DECIMALS, toFixedNumber } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { type PublicClient, type Hash, keccak256, serializeTransaction } from 'viem';
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

export type StabilizerBuyPurchaseInput = Pick<
  IStabilizerBuyPurchaseRecord,
  'id' | 'ethereumQuote' | 'ethereumMaxFeeWei'
> & {
  ethereumWallet: WalletForEthereum;
};

/** Resumes desktop approval and purchase workflows; StabilizerBuys owns the durable records. */
export class StabilizerBuyPurchases {
  public data = { transactionProgressByHash: {} as Record<Hash, IEthereumTransactionProgress> };

  private readonly submissionsById = new Set<string>();
  private readonly walletQueues = new Map<string, SingleFileQueue>();
  private isClosed = false;
  private readonly contracts: StabilizerBuyContracts;
  private startupPromise?: Promise<void>;

  constructor(
    private readonly buys: StabilizerBuys,
    private readonly walletKeys: Pick<WalletKeys, 'signEthereumTransaction' | 'ethereumHdPath'>,
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
      if (buy.ethereumQuote && buy.ethereumMaxFeeWei !== undefined) this.resume(buy as IStabilizerBuyPurchaseRecord);
    }
  }

  public async previewPurchase({
    ethereumQuote,
    ethereumWallet,
    ethereumMaxFeeWei,
  }: Pick<StabilizerBuyPurchaseInput, 'ethereumQuote'> &
    Partial<Pick<StabilizerBuyPurchaseInput, 'ethereumWallet' | 'ethereumMaxFeeWei'>>) {
    if (ethereumWallet) await this.build({ ethereumQuote, ethereumMaxFeeWei }, ethereumWallet);

    const client = this.ethereumClient.publicClient;
    const [{ gasEstimate, needsApproval }, fees] = await Promise.all([
      this.contracts.estimatePurchaseGas(ethereumQuote),
      client.estimateFeesPerGas(),
    ]);
    const feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? (await client.getGasPrice());
    const feeEstimateWei = gasEstimate * feePerGas;
    if (ethereumMaxFeeWei !== undefined && feeEstimateWei > ethereumMaxFeeWei)
      throw new StabilizerBuyValidationError('The Ethereum network fee exceeds your purchase fee limit.');

    return { feeEstimateWei, needsApproval };
  }

  public async purchase(input: StabilizerBuyPurchaseInput): Promise<IStabilizerBuyPurchaseRecord> {
    const { ethereumWallet } = input;
    if (input.ethereumQuote.request.deadline <= BigInt(Math.floor(Date.now() / 1000)))
      throw new StabilizerBuyValidationError('This quote has expired. Get a new quote before buying.');

    const buy = await this.buys.createPurchase(input);
    this.resume(buy, ethereumWallet);
    return buy;
  }

  public async estimateHistoricalFees(
    input: Omit<Parameters<StabilizerBuyContracts['estimateMarketPurchaseGas']>[0], 'client'>,
  ) {
    const mainchain = await getMainchainClient(false);
    const snapshot = await this.getFinalizedSnapshot();
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

  public async close(): Promise<void> {
    this.isClosed = true;
    await Promise.all([...this.walletQueues.values()].map(queue => queue.stop()));
  }

  public async quote(
    input: Omit<Parameters<StabilizerBuyContracts['quote']>[0], 'client'>,
  ): Promise<IStabilizerBuyQuote> {
    return this.contracts.quote({ ...input, client: await this.getFinalizedSnapshot() });
  }

  /** Compare estimated net purchase profit; auction rewards are not guaranteed. */
  public async quoteMaxProfit(
    input: Omit<
      Parameters<StabilizerBuyContracts['quote']>[0],
      'client' | 'ethereumBlock' | 'sizeToTarget' | 'maxUsdcIn'
    > & {
      maxUsdcIn: bigint;
    },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const client = this.ethereumClient.publicClient;
    const contracts = this.contracts;
    const [snapshot, ethereumBlock, fees] = await Promise.all([
      this.getFinalizedSnapshot(),
      client.getBlock(),
      client.estimateFeesPerGas(),
    ]);
    const feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? (await client.getGasPrice());
    signal?.throwIfAborted();

    const request = { ...input, client: snapshot, ethereumBlock };
    const minimumQuote = await contracts.quote({ ...request, maxUsdcIn: undefined, sizeToTarget: true });
    const minimumGas = await contracts.estimatePurchaseGas(minimumQuote, ethereumBlock.number);
    const candidates = new Map<bigint, Awaited<ReturnType<typeof evaluate>>>();
    let best = await evaluate(minimumQuote, minimumGas);

    const budget = input.maxUsdcIn < minimumGas.usdcBalance ? input.maxUsdcIn : minimumGas.usdcBalance;
    if (budget < minimumQuote.request.maxUsdcIn) {
      // Keep the minimum as a funding preview; no executable purchase fits this wallet yet.
      return { minimumQuote, quote: best.quote, preview: best.preview };
    }

    signal?.throwIfAborted();
    const maximum = await contracts.quote({ ...request, maxUsdcIn: budget, sizeToTarget: true });
    await evaluate(maximum);

    // Approval adds a separate fee. Check both sides even when coarse samples miss this boundary.
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
    return { minimumQuote, quote: best.quote, preview: best.preview };

    async function evaluate(
      quote: IStabilizerBuyQuote,
      gas?: Awaited<ReturnType<StabilizerBuyContracts['estimatePurchaseGas']>>,
    ) {
      signal?.throwIfAborted();
      gas ??= await contracts.estimatePurchaseGas(quote, ethereumBlock.number);
      const preview = { feeEstimateWei: gas.gasEstimate * feePerGas, needsApproval: gas.needsApproval };
      const cost = calculateStabilizerBuyCost({ quote, feeEstimateWei: preview.feeEstimateWei });
      if (!cost) throw new StabilizerBuyValidationError('An Ethereum oracle price is required to estimate profit.');

      const candidate = { quote, preview, profit: quote.quotedMicrogonsOut - cost.investedCost };
      candidates.set(quote.request.maxUsdcIn, candidate);
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
      let hash = buy.ethereumTxHash;
      if (
        buy.status === StabilizerBuyStatus.SubmittingUsdcApprovalOnEthereum ||
        buy.status === StabilizerBuyStatus.ConfirmingUsdcApprovalOnEthereum
      )
        hash = buy.usdcApprovalTxHash;

      const observed = hash && transactionProgressByHash[hash];
      const blocksPerTransaction =
        observed?.expectedConfirmations ?? NetworkConfig.get().ethereumNetwork.finalityBlocks;
      const hasApproval =
        !!buy.usdcApprovalTxHash || buy.status === StabilizerBuyStatus.SubmittingUsdcApprovalOnEthereum;
      const approvalBlocks = hasApproval && buy.usdcApprovalFeeWei !== undefined ? blocksPerTransaction : 0;
      const expectedBlocks = blocksPerTransaction * (hasApproval ? 2 : 1);
      const confirmations = approvalBlocks + Math.min(blocksPerTransaction, Math.max(0, observed?.confirmations ?? 0));

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
        if (
          buy.status === StabilizerBuyStatus.SubmittingPurchaseOnEthereum ||
          buy.status === StabilizerBuyStatus.SubmittingUsdcApprovalOnEthereum
        ) {
          const wallet = selectedWallet ?? (await this.wallets.resolve(buy.ethereumQuote.sourceAddress));
          if (!wallet)
            throw new StabilizerBuyValidationError('Reconnect the Ethereum wallet selected for this purchase.');

          await this.ethereumClient.withSubmissionLock(
            { chainId: buy.ethereumQuote.chainId, from: buy.ethereumQuote.sourceAddress },
            async () => {
              if (this.isClosed) return;

              // Rebuild at submission, including after approval or a queued wait, against the accepted limits.
              const prepared = await this.build(buy, wallet);
              if (prepared.needsApproval && buy.usdcApprovalTxHash)
                throw new StabilizerBuyValidationError(
                  'The USDC allowance changed after approval. Review the wallet before starting another purchase.',
                );

              if (prepared.needsApproval && buy.status !== StabilizerBuyStatus.SubmittingUsdcApprovalOnEthereum) {
                await this.buys.recordPurchase(buy.id, {
                  status: StabilizerBuyStatus.SubmittingUsdcApprovalOnEthereum,
                });
              }

              await this.submitTransaction({ buy, prepared, ethereumWallet: wallet });
            },
          );
        } else {
          let hash = buy.ethereumTxHash;
          let submittedAt = buy.ethereumSubmittedAt;
          if (buy.status === StabilizerBuyStatus.ConfirmingUsdcApprovalOnEthereum) {
            hash = buy.usdcApprovalTxHash;
            submittedAt = buy.usdcApprovalSubmittedAt;
          }

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

    const { needsApproval, prices } = prepared;
    if (needsApproval) {
      const patch: Partial<IStabilizerBuyRecord> = {
        status: StabilizerBuyStatus.ConfirmingUsdcApprovalOnEthereum,
        usdcApprovalTxHash: hash,
        usdcApprovalSubmittedAt: new Date(),
      };
      if (prices) patch.usdcApprovalPrices = prices;

      await this.buys.recordPurchase(buy.id, patch);
    } else {
      const patch: Partial<IStabilizerBuyRecord> = {
        status: StabilizerBuyStatus.ConfirmingPurchaseOnEthereum,
        ethereumTxHash: hash,
        ethereumSubmittedAt: new Date(),
        usdcApprovalFeeWei: buy.usdcApprovalFeeWei ?? 0n,
      };
      if (prices) patch.ethereumPrices = prices;
      if (!buy.usdcApprovalTxHash) patch.usdcApprovalFeeMicrogons = 0n;

      await this.buys.recordPurchase(buy.id, patch);
    }
  }

  private async onFinalized(
    buy: IStabilizerBuyPurchaseRecord,
    receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>,
  ): Promise<void> {
    const fee = getReceiptFeeWei(receipt);
    if (buy.status === StabilizerBuyStatus.ConfirmingUsdcApprovalOnEthereum) {
      const patch: Partial<IStabilizerBuyRecord> = {
        status: StabilizerBuyStatus.SubmittingPurchaseOnEthereum,
        usdcApprovalFeeWei: fee,
      };
      const cost = getFeeMicrogons(fee, buy.usdcApprovalPrices);
      if (cost !== undefined) patch.usdcApprovalFeeMicrogons = cost;

      await this.buys.recordPurchase(buy.id, patch);
    } else {
      const result = this.contracts.readPurchase(buy.ethereumQuote, receipt);
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
      let hash = buy.ethereumTxHash;
      if (buy.status === StabilizerBuyStatus.ConfirmingUsdcApprovalOnEthereum) hash = buy.usdcApprovalTxHash;
      if (hash) {
        const receipt = await this.ethereumClient.publicClient.getTransactionReceipt({ hash });
        const fee = getReceiptFeeWei(receipt);
        if (buy.status === StabilizerBuyStatus.ConfirmingUsdcApprovalOnEthereum) {
          patch.usdcApprovalFeeWei = fee;
          const cost = getFeeMicrogons(fee, buy.usdcApprovalPrices);
          if (cost !== undefined) patch.usdcApprovalFeeMicrogons = cost;
        } else {
          patch.ethereumFeeWei = fee;
          const cost = getFeeMicrogons(fee, buy.ethereumPrices);
          if (cost !== undefined) patch.ethereumFeeMicrogons = cost;
        }
      }
    }

    await this.buys.recordPurchase(buy.id, patch);
  }

  private async build(
    purchase: Pick<IStabilizerBuyPurchaseRecord, 'ethereumQuote'> &
      Partial<Pick<IStabilizerBuyPurchaseRecord, 'ethereumMaxFeeWei' | 'usdcApprovalFeeWei'>>,
    ethereumWallet: WalletForEthereum,
  ) {
    const { ethereumQuote: quote, ethereumMaxFeeWei, usdcApprovalFeeWei = 0n } = purchase;
    const { to, data, needsApproval, prices } = await this.contracts.buildNextTransaction({
      client: await this.getFinalizedSnapshot(),
      quote,
      sourceAddress: ethereumWallet.address,
    });

    const publicClient = this.ethereumClient.publicClient;
    const prepared = await buildEthereumUnsignedTransaction({
      publicClient,
      from: quote.sourceAddress,
      chainId: quote.chainId,
      to,
      data,
    });
    if (ethereumMaxFeeWei !== undefined && prepared.feeEstimateWei + usdcApprovalFeeWei > ethereumMaxFeeWei)
      throw new StabilizerBuyValidationError('The Ethereum network fee exceeds your purchase fee limit.');
    if ((await publicClient.getBalance({ address: quote.sourceAddress })) < prepared.feeEstimateWei)
      throw new StabilizerBuyValidationError('Add ETH to this wallet to pay the Ethereum network fee.');

    await this.ethereumClient.configureSignerPolicy();

    return { ...prepared, needsApproval, prices };
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
  StabilizerBuyStatus.SubmittingUsdcApprovalOnEthereum,
  StabilizerBuyStatus.ConfirmingUsdcApprovalOnEthereum,
  StabilizerBuyStatus.ConfirmingPurchaseOnEthereum,
]);
