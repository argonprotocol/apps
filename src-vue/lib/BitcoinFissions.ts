import {
  BitcoinFission,
  type ArgonClient,
  type ArgonQueryClient,
  bigIntMin,
  type BlockWatch,
  createDeferred,
  type Currency,
  groupEventsByExtrinsic,
  type IDeferred,
  type IBitcoinFission,
  type IBitcoinPendingMint,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
  SingleFileQueue,
} from '@argonprotocol/apps-core';

import { getMainchainClient } from '../stores/mainchain.ts';
import type { IBitcoinFissionRatchetRecord, IBitcoinFissionRecord } from '../interfaces/IBitcoinFissionRecord.ts';
import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { BitcoinLiquid } from './BitcoinLiquid.ts';
import type { Db } from './Db.ts';
import { BitcoinFissionRecovery } from './recovery/BitcoinFissions.ts';
import type { TransactionInfo } from './TransactionInfo.ts';

export class BitcoinFissions {
  public data: {
    fissionsById: Record<number, BitcoinFission>;
    activeFissionIds: Set<number>;
    minimumRatchetPercent: bigint;
    readiness: 'idle' | 'loading' | 'ready' | 'error';
    loadError?: Error;
    financialRevision: number;
  };

  public readonly recovery: BitcoinFissionRecovery;
  private waitForLoad?: IDeferred<void>;
  private readonly pendingMintSubscriptions = new Map<number, VoidFunction>();
  private readonly currentStateQueue = new SingleFileQueue();
  private pendingRefreshClient?: ArgonQueryClient;
  private coalescedRefreshPromise?: Promise<void>;

  constructor(
    private readonly dbPromise: Promise<Db>,
    public readonly ownerAccount: string,
    private readonly blockWatch?: BlockWatch,
    private readonly currency?: Pick<Currency, 'fetchMainchainRatesAtBlock'>,
  ) {
    this.data = {
      fissionsById: {},
      activeFissionIds: new Set(),
      minimumRatchetPercent: 0n,
      readiness: 'idle',
      financialRevision: 0,
    };
    this.recovery = new BitcoinFissionRecovery(
      dbPromise,
      ownerAccount,
      () => this.getAll(),
      blockWatch && this.currency ? { blockWatch, currency: this.currency } : undefined,
      records => this.updateRecoveredState(records),
    );
  }

  public async load(): Promise<void> {
    if (this.waitForLoad?.isRunning || this.waitForLoad?.isResolved) return this.waitForLoad.promise;

    this.waitForLoad = createDeferred<void>();
    this.data.readiness = 'loading';
    this.data.loadError = undefined;
    try {
      await this.loadState();
      this.data.readiness = 'ready';
      this.data.financialRevision += 1;
      this.waitForLoad.resolve();
    } catch (error) {
      this.data.readiness = 'error';
      this.data.loadError = error instanceof Error ? error : new Error(String(error));
      this.waitForLoad.reject(error);
    }
    return this.waitForLoad.promise;
  }

  public get currentLoadPromise(): Promise<void> {
    if (!this.waitForLoad) throw new Error('Bitcoin Fission loading has not started.');
    return this.waitForLoad.promise;
  }

  public async refreshCurrent(client?: ArgonQueryClient): Promise<BitcoinFission[]> {
    return await this.currentStateQueue.add(async () => {
      const queryClient = client ?? this.blockWatch?.subscriptionClient ?? (await getMainchainClient(false));
      const active = await this.loadActive(queryClient);

      this.data.minimumRatchetPercent = queryClient.consts.bitcoinFissions.minimumRatchetPercent.toBigInt();
      this.updateCurrentState(active);
      if (this.blockWatch?.subscriptionClient) {
        try {
          await this.syncPendingMintSubscriptions(this.blockWatch.subscriptionClient);
        } catch (error) {
          console.warn('[BitcoinFissions] Unable to subscribe to pending mints', error);
        }
      }
      return active;
    }).promise;
  }

  public refreshCurrentCoalesced(client: ArgonQueryClient): Promise<void> {
    this.pendingRefreshClient = client;
    if (this.coalescedRefreshPromise) return this.coalescedRefreshPromise;

    this.coalescedRefreshPromise = (async () => {
      let firstError: Error | undefined;
      while (this.pendingRefreshClient) {
        const nextClient = this.pendingRefreshClient;
        this.pendingRefreshClient = undefined;
        try {
          await this.refreshCurrent(nextClient);
        } catch (error) {
          firstError ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (firstError) throw firstError;
    })().finally(() => {
      this.coalescedRefreshPromise = undefined;
    });
    return this.coalescedRefreshPromise;
  }

  public async recordFinalizedTransaction(txInfo: TransactionInfo): Promise<void> {
    if (this.data.readiness === 'error') await this.load();
    else if (this.data.readiness !== 'ready') await this.currentLoadPromise;

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
    const events = txInfo.txResult.events.map(
      event =>
        ({
          event,
          phase: { type: 'ApplyExtrinsic', value: extrinsicIndex },
        }) as RuntimeSystemEventRecord,
    );
    const finalizedClient = await this.blockWatch.getApi(block);
    await this.recordFinalizedBlock(block, events, finalizedClient);
  }

  public async syncFinalizedBlock(
    block: IBlockHeaderInfo,
    events: readonly RuntimeSystemEventRecord[],
    finalizedClient: ArgonQueryClient,
  ): Promise<void> {
    if (
      !events.some(({ event }) => event.section === 'bitcoinFissions' && event.data.accountId === this.ownerAccount)
    ) {
      await this.refreshCurrentCoalesced(finalizedClient);
      return;
    }

    if (this.data.readiness === 'error') await this.load();
    else if (this.data.readiness !== 'ready') await this.currentLoadPromise;
    await this.recordFinalizedBlock(block, events, finalizedClient);
  }

  private async recordFinalizedBlock(
    block: IBlockHeaderInfo,
    events: readonly RuntimeSystemEventRecord[],
    finalizedClient: ArgonQueryClient,
  ): Promise<void> {
    await this.currentStateQueue.add(async () => {
      const currentPromise = this.loadActive(finalizedClient);
      const records = await this.recordFinalizedEvents(block, events, finalizedClient);
      this.updateFinalizedState(await currentPromise, records);
      if (this.blockWatch?.subscriptionClient) {
        try {
          await this.syncPendingMintSubscriptions(this.blockWatch.subscriptionClient);
        } catch (error) {
          console.warn('[BitcoinFissions] Unable to subscribe to pending mints', error);
        }
      }
    }).promise;
  }

  private async recordFinalizedEvents(
    block: IBlockHeaderInfo,
    events: readonly RuntimeSystemEventRecord[],
    finalizedClient: ArgonQueryClient,
  ): Promise<IBitcoinFissionRecord[]> {
    const table = await this.dbPromise.then(db => db.bitcoinFissionsTable);
    const records = await table.fetchAll(this.ownerAccount);
    const recordsByFissionId = new Map(records.map(record => [record.fissionId, record]));
    const affectedRecords = new Map<number, IBitcoinFissionRecord>();
    const blockTime = new Date(block.blockTime);
    const fissionExtrinsicIndexes = new Set<number>();

    for (const { extrinsicEvents, extrinsicIndex } of groupEventsByExtrinsic(events)) {
      const fissionEvents = extrinsicEvents.filter(event => {
        return event.section === 'bitcoinFissions' && event.data.accountId === this.ownerAccount;
      });
      if (!fissionEvents.length) continue;
      if (extrinsicIndex !== undefined) fissionExtrinsicIndexes.add(extrinsicIndex);

      const feeEvent = extrinsicEvents.find(event => {
        return event.section === 'transactionPayment' && event.method === 'TransactionFeePaid';
      });
      let transactionFee: bigint | undefined;
      if (feeEvent?.section === 'transactionPayment' && feeEvent.method === 'TransactionFeePaid') {
        transactionFee = feeEvent.data.who === this.ownerAccount ? feeEvent.data.actualFee : 0n;
      }

      for (const event of fissionEvents) {
        if (event.section !== 'bitcoinFissions') continue;
        const fissionId = Number(event.data.fissionId);
        if (event.method === 'FissionCreated') {
          const record: IBitcoinFissionRecord = {
            origin: 'created',
            ownerAccount: this.ownerAccount,
            fissionId,
            liquidId: Number(event.data.liquidId),
            utxoId: event.data.utxoId,
            satoshis: event.data.satoshis,
            microgonsAtTargetPerBtc: event.data.microgonsAtTargetPerBtc,
            liquidityPromised: event.data.liquidityPromised,
            createdAtArgonBlock: block.blockNumber,
            ratchetNumber: 0,
            lastUpdatedArgonBlock: block.blockNumber,
            ...(transactionFee === undefined ? {} : { feeHistoryCompleteThroughBlock: block.blockNumber }),
            ratchets: [
              {
                source: 'fission',
                sourceRatchetIndex: 0,
                ratchetNumber: 0,
                microgonsAtTargetPerBtc: event.data.microgonsAtTargetPerBtc,
                liquidityPromised: event.data.liquidityPromised,
                amountMinted: event.data.liquidityPromised,
                amountBurned: 0n,
                mintPending: event.data.liquidityPromised,
                txFee: transactionFee,
                blockNumber: block.blockNumber,
                tick: block.tick,
                blockHash: block.blockHash,
                blockTime,
                extrinsicIndex,
              },
            ],
            createdAtTick: block.tick,
            createdBlockHash: block.blockHash,
            createdBlockTime: blockTime,
            createdExtrinsicIndex: extrinsicIndex,
            createdAt: blockTime,
            updatedAt: blockTime,
          };
          recordsByFissionId.set(fissionId, record);
          affectedRecords.set(fissionId, record);
          continue;
        }

        const record = recordsByFissionId.get(fissionId);
        if (!record) throw new Error(`Finalized Bitcoin Fission ${fissionId} is missing its durable creation`);
        const priorFeesAreComplete =
          record.feeHistoryCompleteThroughBlock != null &&
          record.feeHistoryCompleteThroughBlock >= record.lastUpdatedArgonBlock;

        if (event.method === 'FissionRatcheted') {
          const ratchetNumber = Number(event.data.ratchetNumber);
          const ratchet: IBitcoinFissionRatchetRecord = {
            source: 'fission',
            sourceRatchetIndex: ratchetNumber,
            ratchetNumber,
            microgonsAtTargetPerBtc: event.data.microgonsAtTargetPerBtc,
            liquidityPromised: event.data.liquidityPromised,
            amountMinted: event.data.amountMinted,
            amountBurned: event.data.amountBurned,
            mintPending: event.data.amountMinted,
            txFee: transactionFee,
            blockNumber: block.blockNumber,
            tick: block.tick,
            blockHash: block.blockHash,
            blockTime,
            extrinsicIndex,
          };
          const existingIndex = record.ratchets.findIndex(candidate => {
            return candidate.source === 'fission' && candidate.ratchetNumber === ratchetNumber;
          });
          if (existingIndex === -1) record.ratchets.push(ratchet);
          else record.ratchets.splice(existingIndex, 1, ratchet);
          record.microgonsAtTargetPerBtc = ratchet.microgonsAtTargetPerBtc;
          record.liquidityPromised = event.data.liquidityPromised;
          record.ratchetNumber = ratchetNumber;
          record.lastUpdatedArgonBlock = block.blockNumber;
          record.feeHistoryCompleteThroughBlock =
            priorFeesAreComplete && transactionFee !== undefined ? block.blockNumber : undefined;
          record.updatedAt = blockTime;
          affectedRecords.set(fissionId, record);
          continue;
        }

        if (event.method !== 'FissionClosed' && event.method !== 'FissionClosedByLock') continue;

        record.closedAtArgonBlock = block.blockNumber;
        record.closedAtTick = block.tick;
        record.closedBlockHash = block.blockHash;
        record.closedBlockTime = blockTime;
        record.closedExtrinsicIndex = extrinsicIndex;
        record.closeReason = event.method === 'FissionClosed' ? 'closed' : 'lock-spent';
        record.closeTxFee = transactionFee;
        record.lastUpdatedArgonBlock = block.blockNumber;
        record.feeHistoryCompleteThroughBlock =
          priorFeesAreComplete && transactionFee !== undefined ? block.blockNumber : undefined;
        record.updatedAt = blockTime;
        if (event.method === 'FissionClosed') record.redemptionAmount = event.data.redemptionAmount;
        if (this.currency) {
          const rates = await this.currency.fetchMainchainRatesAtBlock({ api: finalizedClient, block });
          record.btcPriceAtCloseMicrogons = rates.BTC;
        }
        affectedRecords.set(fissionId, record);
      }
    }

    const finalizedRecords = [...affectedRecords.values()];
    if (!finalizedRecords.length) return [];

    const finalizedFissions = finalizedRecords.map(record => new BitcoinFission(record));
    await this.loadPendingMints(finalizedClient, finalizedFissions);
    for (const fission of finalizedFissions) {
      const record = affectedRecords.get(fission.fissionId);
      if (record) record.ratchets = fission.ratchets;
    }

    await this.recovery.preserveFinalizedBlockDuringReplay(
      block,
      events.filter(({ event, phase }) => {
        return (
          phase.type === 'ApplyExtrinsic' &&
          fissionExtrinsicIndexes.has(phase.value) &&
          (event.section === 'bitcoinFissions' || event.section === 'transactionPayment')
        );
      }),
    );
    await table.replaceRecords(finalizedRecords);
    return finalizedRecords;
  }

  public async loadActive(client: ArgonQueryClient): Promise<BitcoinFission[]> {
    const active = await BitcoinFission.getAllByOwner(client, this.ownerAccount);
    await this.loadPendingMints(client, active);
    return active;
  }

  private async loadPendingMints(client: ArgonQueryClient, fissions: readonly BitcoinFission[]): Promise<void> {
    const utxoIds = [...new Set(fissions.map(fission => fission.utxoId))];
    const pendingMints = (
      await Promise.all(utxoIds.map(utxoId => BitcoinFission.pendingMintsForLock(client, utxoId)))
    ).flat();
    const fissionsById = new Map(fissions.map(fission => [fission.fissionId, fission]));

    for (const fission of fissions) fission.pendingMints = [];

    for (const mint of pendingMints) {
      if (mint.ownerAccount !== this.ownerAccount) continue;
      fissionsById.get(mint.fissionId)?.pendingMints.push(mint);
    }

    for (const fission of fissions) updatePendingMintHistory(fission);
  }

  public getAll(): BitcoinFission[] {
    return this.getRecords().filter(fission => this.data.activeFissionIds.has(fission.fissionId));
  }

  public getArchived(): BitcoinFission[] {
    return this.getRecords().filter(fission => !this.data.activeFissionIds.has(fission.fissionId));
  }

  public getRecords(): BitcoinFission[] {
    return Object.values(this.data.fissionsById);
  }

  public getLiquids(): BitcoinLiquid[] {
    return createBitcoinLiquids({ fissions: this.getRecords() });
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
    const recordsPromise = this.dbPromise.then(db => db.bitcoinFissionsTable.fetchAll(this.ownerAccount));
    if (this.blockWatch) await this.blockWatch.start();
    const client = this.blockWatch?.subscriptionClient ?? (await getMainchainClient(false));
    const [records, current] = await Promise.all([recordsPromise, this.loadActive(client)]);
    this.data.minimumRatchetPercent = client.consts.bitcoinFissions.minimumRatchetPercent.toBigInt();
    this.restoreLoadedState(records, current);
    await this.loadPendingMints(client, this.getArchived());
    const subscriptionClient = this.blockWatch?.subscriptionClient;
    if (subscriptionClient) {
      try {
        await this.syncPendingMintSubscriptions(subscriptionClient);
      } catch (error) {
        console.warn('[BitcoinFissions] Unable to subscribe to pending mints', error);
      }
    }
  }

  private restoreLoadedState(records: readonly IBitcoinFissionRecord[], current: readonly BitcoinFission[]): void {
    const retainedIds = new Set(records.map(record => record.fissionId));
    for (const fission of current) retainedIds.add(fission.fissionId);
    for (const fission of this.getRecords()) {
      if (!retainedIds.has(fission.fissionId)) delete this.data.fissionsById[fission.fissionId];
    }
    for (const record of records) this.updateFissionFromRecord(record);
    this.updateFissionsFromCurrent(current);
    this.data.activeFissionIds = new Set(current.map(fission => fission.fissionId));
  }

  private updateCurrentState(current: readonly BitcoinFission[]): void {
    this.updateFissionsFromCurrent(current);
    for (const fission of current) this.data.activeFissionIds.add(fission.fissionId);
    if (this.data.readiness === 'ready') this.data.financialRevision += 1;
  }

  private updateFinalizedState(current: readonly BitcoinFission[], records: readonly IBitcoinFissionRecord[]): void {
    for (const record of records) this.updateFissionFromRecord(record);
    this.updateFissionsFromCurrent(current);
    for (const fission of current) this.data.activeFissionIds.add(fission.fissionId);
    for (const record of records) {
      if (record.closedAtArgonBlock === undefined) this.data.activeFissionIds.add(record.fissionId);
      else this.data.activeFissionIds.delete(record.fissionId);
    }
    if (this.data.readiness === 'ready') this.data.financialRevision += 1;
  }

  private async updateRecoveredState(records: readonly IBitcoinFissionRecord[]): Promise<void> {
    for (const record of records) {
      const fission = this.data.fissionsById[record.fissionId];
      if (fission && fission.lastUpdatedArgonBlock > record.lastUpdatedArgonBlock) continue;
      if (fission && this.data.activeFissionIds.has(record.fissionId)) applyRecoveredHistory(fission, record);
      else this.updateFissionFromRecord(record);
    }

    const client = this.blockWatch?.subscriptionClient;
    if (client) {
      try {
        await this.loadPendingMints(
          client,
          records.flatMap(record => {
            const fission = this.data.fissionsById[record.fissionId];
            return fission ? [fission] : [];
          }),
        );
        await this.syncPendingMintSubscriptions(client);
      } catch (error) {
        console.warn('[BitcoinFissions] Unable to refresh recovered pending mints', error);
      }
    }
    if (this.data.readiness === 'ready') this.data.financialRevision += 1;
  }

  private updateFissionFromRecord(record: IBitcoinFissionRecord): void {
    const fission = this.data.fissionsById[record.fissionId];
    if (!fission) {
      this.data.fissionsById[record.fissionId] = new BitcoinFission(record);
      return;
    }

    const pendingMints = fission.pendingMints;
    Object.assign(fission, record);
    fission.pendingMints = pendingMints;
  }

  private updateFissionsFromCurrent(currentFissions: readonly BitcoinFission[]): void {
    for (const current of currentFissions) {
      const fission = this.data.fissionsById[current.fissionId];
      if (fission) {
        applyCurrentState(fission, current);
        updatePendingMintHistory(fission);
      } else {
        this.data.fissionsById[current.fissionId] = current;
      }
    }
  }

  private async syncPendingMintSubscriptions(client: ArgonClient): Promise<void> {
    const pendingByQueueIndex = new Map(
      this.getRecords().flatMap(fission => fission.pendingMints.map(mint => [mint.queueIndex, mint] as const)),
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
            updatePendingMintHistory(fission);
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
          updatePendingMintHistory(fission);
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

function applyCurrentState(target: BitcoinFission, current: BitcoinFission): void {
  const origin = target.origin;
  const ratchets = target.ratchets;
  const feeHistoryCompleteThroughBlock = target.feeHistoryCompleteThroughBlock;
  const createdAtTick = target.createdAtTick;
  const createdBlockHash = target.createdBlockHash;
  const createdBlockTime = target.createdBlockTime;
  const createdExtrinsicIndex = target.createdExtrinsicIndex;
  const createdAt = target.createdAt;
  const updatedAt = target.updatedAt;

  Object.assign(target, current);
  target.origin = origin;
  target.ratchets = ratchets;
  target.feeHistoryCompleteThroughBlock = feeHistoryCompleteThroughBlock;
  target.createdAtTick = createdAtTick;
  target.createdBlockHash = createdBlockHash;
  target.createdBlockTime = createdBlockTime;
  target.createdExtrinsicIndex = createdExtrinsicIndex;
  target.createdAt = createdAt;
  target.updatedAt = updatedAt;
  target.pendingMints = current.pendingMints;
}

function applyRecoveredHistory(
  target: BitcoinFission,
  record: Pick<
    IBitcoinFission,
    | 'origin'
    | 'ratchets'
    | 'feeHistoryCompleteThroughBlock'
    | 'createdAtTick'
    | 'createdBlockHash'
    | 'createdBlockTime'
    | 'createdExtrinsicIndex'
    | 'createdAt'
    | 'updatedAt'
  >,
): void {
  target.origin = record.origin;
  if (record.ratchets) target.ratchets = record.ratchets;
  target.feeHistoryCompleteThroughBlock = record.feeHistoryCompleteThroughBlock;
  target.createdAtTick = record.createdAtTick;
  target.createdBlockHash = record.createdBlockHash;
  target.createdBlockTime = record.createdBlockTime;
  target.createdExtrinsicIndex = record.createdExtrinsicIndex;
  target.createdAt = record.createdAt;
  target.updatedAt = record.updatedAt;
}

function updatePendingMintHistory(fission: BitcoinFission): void {
  let remaining = fission.pendingMints.reduce((total, mint) => total + mint.remainingAmount, 0n);
  const recordedEntitlement = fission.ratchets.reduce((total, ratchet) => total + ratchet.amountMinted, 0n);
  if (remaining > recordedEntitlement) return;

  for (const ratchet of fission.ratchets.toReversed()) {
    ratchet.mintPending = bigIntMin(remaining, ratchet.amountMinted);
    remaining -= ratchet.mintPending;
  }
}

export function createBitcoinLiquids(args: {
  fissions: readonly BitcoinFission[];
  terms?: readonly IBitcoinSecuritizationTerm[];
  securitizationCostsByLiquidId?: ReadonlyMap<number, bigint>;
}): BitcoinLiquid[] {
  const { fissions, terms, securitizationCostsByLiquidId } = args;
  const fissionsByLiquidId = new Map<number, BitcoinFission[]>();
  for (const fission of fissions) {
    const liquidFissions = fissionsByLiquidId.get(fission.liquidId) ?? [];
    liquidFissions.push(fission);
    fissionsByLiquidId.set(fission.liquidId, liquidFissions);
  }
  return [...fissionsByLiquidId]
    .sort(([left], [right]) => left - right)
    .map(([liquidId, liquidFissions]) =>
      BitcoinLiquid.create({
        liquidId,
        fissions: liquidFissions,
        terms,
        securitizationCost: securitizationCostsByLiquidId?.get(liquidId),
      }),
    );
}
