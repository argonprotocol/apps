import {
  BitcoinFission,
  type ArgonClient,
  type ArgonQueryClient,
  type BlockWatch,
  createDeferred,
  type Currency,
  type IDeferred,
  type IBitcoinPendingMint,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';

import { getMainchainClient } from '../stores/mainchain.ts';
import type { IBitcoinFissionRecord } from '../interfaces/IBitcoinFissionRecord.ts';
import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { BitcoinLiquid } from './BitcoinLiquid.ts';
import type { Db } from './Db.ts';
import { BitcoinFissionRecovery } from './recovery/BitcoinFissions.ts';
import type { TransactionInfo } from './TransactionInfo.ts';

export class BitcoinFissions {
  public data: {
    fissionsById: Record<number, BitcoinFission>;
    historyById: Record<number, IBitcoinFissionRecord>;
    minimumRatchetPercent: bigint;
    isLoaded: boolean;
    financialRevision: number;
  };

  public readonly recovery: BitcoinFissionRecovery;
  private waitForLoad?: IDeferred<void>;
  private readonly pendingMintSubscriptions = new Map<number, VoidFunction>();

  constructor(
    private readonly dbPromise: Promise<Db>,
    public readonly ownerAccount: string,
    private readonly blockWatch?: BlockWatch,
    currency?: Pick<Currency, 'fetchMainchainRatesAtBlock'>,
  ) {
    this.data = {
      fissionsById: {},
      historyById: {},
      minimumRatchetPercent: 0n,
      isLoaded: false,
      financialRevision: 0,
    };
    this.recovery = new BitcoinFissionRecovery(
      dbPromise,
      ownerAccount,
      () => this.getAll(),
      blockWatch && currency ? { blockWatch, currency } : undefined,
      records => this.publishFinancialState({ history: records }),
    );
  }

  public async load(): Promise<void> {
    if (this.waitForLoad?.isRunning || this.waitForLoad?.isResolved) return this.waitForLoad.promise;

    this.waitForLoad = createDeferred<void>();
    try {
      await this.loadState();
      this.waitForLoad.resolve();
    } catch (error) {
      this.waitForLoad.reject(error);
    }
    return this.waitForLoad.promise;
  }

  public async refreshCurrent(client?: ArgonQueryClient): Promise<BitcoinFission[]> {
    const queryClient = client ?? this.blockWatch?.subscriptionClient ?? (await getMainchainClient(false));
    const active = await this.loadActive(queryClient);

    this.data.minimumRatchetPercent = queryClient.consts.bitcoinFissions.minimumRatchetPercent.toBigInt();
    this.publishFinancialState({ fissions: active });
    if (this.blockWatch?.subscriptionClient) {
      try {
        await this.syncPendingMintSubscriptions(this.blockWatch.subscriptionClient);
      } catch (error) {
        console.warn('[BitcoinFissions] Unable to subscribe to pending mints', error);
      }
    }
    return active;
  }

  public async recordFinalizedTransaction(txInfo: TransactionInfo): Promise<void> {
    const blockNumber = txInfo.tx.blockHeight ?? txInfo.txResult.blockNumber;
    const blockHash = txInfo.tx.blockHash;
    const extrinsicIndex = txInfo.tx.blockExtrinsicIndex ?? txInfo.txResult.extrinsicIndex;
    if (!this.blockWatch || blockNumber === undefined || !blockHash || extrinsicIndex === undefined) {
      throw new Error(`Finalized transaction #${txInfo.tx.id} is missing its Fission history location`);
    }

    const block = await this.blockWatch.getHeader(blockNumber);
    if (block.blockHash.toLowerCase() !== blockHash.toLowerCase()) {
      throw new Error(`Finalized transaction #${txInfo.tx.id} does not match block ${blockNumber}`);
    }
    const records = txInfo.txResult.events.map(
      event =>
        ({
          event,
          phase: { type: 'ApplyExtrinsic', value: extrinsicIndex },
        }) as RuntimeSystemEventRecord,
    );
    const [history, active] = await Promise.all([
      this.recovery.recordFinalizedBlock(block, records),
      this.loadActive(this.blockWatch.subscriptionClient ?? (await getMainchainClient(false))),
    ]);
    this.publishFinancialState({ fissions: active, history });
    if (this.blockWatch.subscriptionClient) {
      try {
        await this.syncPendingMintSubscriptions(this.blockWatch.subscriptionClient);
      } catch (error) {
        console.warn('[BitcoinFissions] Unable to subscribe to pending mints', error);
      }
    }
  }

  public async loadActive(client: ArgonQueryClient): Promise<BitcoinFission[]> {
    const active = await BitcoinFission.getAllByOwner(client, this.ownerAccount);
    const utxoIds = [...new Set(active.map(fission => fission.utxoId))];
    const pendingMints = (
      await Promise.all(utxoIds.map(utxoId => BitcoinFission.pendingMintsForLock(client, utxoId)))
    ).flat();
    const activeByFissionId = new Map(active.map(fission => [fission.fissionId, fission]));

    for (const mint of pendingMints) {
      if (mint.ownerAccount !== this.ownerAccount) continue;
      activeByFissionId.get(mint.fissionId)?.pendingMints.push(mint);
    }

    return active;
  }

  public getAll(): BitcoinFission[] {
    return Object.values(this.data.fissionsById);
  }

  public getHistory(): IBitcoinFissionRecord[] {
    return Object.values(this.data.historyById);
  }

  private async loadHistory(): Promise<IBitcoinFissionRecord[]> {
    const records = await this.dbPromise.then(db => db.bitcoinFissionsTable.fetchAll(this.ownerAccount));
    this.publishFinancialState({ history: records });
    return records;
  }

  public getLiquids(): BitcoinLiquid[] {
    const fissionsById = new Map(this.getHistory().map(history => [history.fissionId, new BitcoinFission(history)]));
    for (const active of this.getAll()) {
      const history = fissionsById.get(active.fissionId);
      fissionsById.set(active.fissionId, history ? BitcoinFission.fromCurrentAndHistory(active, history) : active);
    }
    return createBitcoinLiquids({ fissions: [...fissionsById.values()] });
  }

  public getLiquidIdsForLock(utxoId: number): number[] {
    return [
      ...new Set(
        this.getAll()
          .filter(fission => fission.utxoId === utxoId)
          .map(fission => fission.liquidId),
      ),
    ];
  }

  private async loadState(): Promise<void> {
    await this.loadHistory();
    if (this.blockWatch) await this.blockWatch.start();
    await this.refreshCurrent(this.blockWatch?.subscriptionClient);
    this.data.isLoaded = true;
    this.data.financialRevision += 1;
  }

  private publishFinancialState(args: {
    fissions?: readonly BitcoinFission[];
    history?: readonly IBitcoinFissionRecord[];
  }): void {
    if (args.fissions) {
      this.data.fissionsById = Object.fromEntries(args.fissions.map(fission => [fission.fissionId, fission]));
    }
    if (args.history) {
      this.data.historyById = Object.fromEntries(args.history.map(record => [record.fissionId, record]));
    }
    if (this.data.isLoaded) this.data.financialRevision += 1;
  }

  private async syncPendingMintSubscriptions(client: ArgonClient): Promise<void> {
    const pendingByQueueIndex = new Map(
      this.getAll().flatMap(fission => fission.pendingMints.map(mint => [mint.queueIndex, mint] as const)),
    );

    for (const [queueIndex, unsubscribe] of this.pendingMintSubscriptions) {
      if (pendingByQueueIndex.has(queueIndex)) continue;

      this.pendingMintSubscriptions.delete(queueIndex);
      unsubscribe();
    }

    const additions: Promise<void>[] = [];
    for (const [queueIndex, mint] of pendingByQueueIndex) {
      if (this.pendingMintSubscriptions.has(queueIndex)) continue;

      additions.push(this.subscribeToPendingMint(client, mint));
    }

    await Promise.all(additions);
  }

  private async subscribeToPendingMint(client: ArgonClient, mint: IBitcoinPendingMint): Promise<void> {
    const { queueIndex, fissionId } = mint;
    let unsubscribe: VoidFunction | undefined;
    const stop = () => unsubscribe?.();
    this.pendingMintSubscriptions.set(queueIndex, stop);

    try {
      unsubscribe = await client.query.mint.pendingMintUtxosByIndex(BigInt(queueIndex), pendingMint => {
        const fission = this.data.fissionsById[fissionId];
        const currentMint = fission?.pendingMints.find(current => current.queueIndex === queueIndex);
        if (!pendingMint || !currentMint) {
          if (currentMint) {
            fission.pendingMints = fission.pendingMints.filter(current => current !== currentMint);
            this.data.financialRevision += 1;
          }
          if (this.pendingMintSubscriptions.get(queueIndex) === stop) {
            this.pendingMintSubscriptions.delete(queueIndex);
          }
          stop();
          return;
        }

        if (
          currentMint.remainingAmount !== pendingMint.remainingAmount ||
          currentMint.maxAmountPerFrame !== pendingMint.maxAmountPerFrame
        ) {
          currentMint.remainingAmount = pendingMint.remainingAmount;
          currentMint.maxAmountPerFrame = pendingMint.maxAmountPerFrame;
          this.data.financialRevision += 1;
        }
      });
    } catch (error) {
      if (this.pendingMintSubscriptions.get(queueIndex) === stop) this.pendingMintSubscriptions.delete(queueIndex);
      throw error;
    }

    if (this.pendingMintSubscriptions.get(queueIndex) !== stop) stop();
  }
}

export function createBitcoinLiquids(args: {
  fissions: readonly BitcoinFission[];
  terms?: readonly IBitcoinSecuritizationTerm[];
}): BitcoinLiquid[] {
  const { fissions, terms } = args;
  const fissionsByLiquidId = new Map<number, BitcoinFission[]>();
  for (const fission of fissions) {
    const liquidFissions = fissionsByLiquidId.get(fission.liquidId) ?? [];
    liquidFissions.push(fission);
    fissionsByLiquidId.set(fission.liquidId, liquidFissions);
  }

  return [...fissionsByLiquidId]
    .sort(([left], [right]) => left - right)
    .map(([liquidId, liquidFissions]) => BitcoinLiquid.create({ liquidId, fissions: liquidFissions, terms }));
}
