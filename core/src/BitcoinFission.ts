import type { PriceIndex } from '@argonprotocol/mainchain';
import type { BitcoinFissionsFissionByOwnerAndIdResultSpec159 } from '@argonprotocol/runtime-client';
import type { HistoricalEvent } from '@argonprotocol/runtime-client/events';
import { BitcoinLock, SATS_PER_BTC } from './BitcoinLock.js';
import type { IBlockHeaderInfo } from './BlockWatch.js';
import type { ArgonClient, ArgonQueryClient } from './MainchainClients.js';
import { bigIntAbs, bigIntMin } from './utils.js';

type IQueryableClient = ArgonQueryClient;
type BitcoinMintFissionHistoryEvent = Extract<HistoricalEvent, { section: 'mint'; method: 'BitcoinMint' }> & {
  data: { fissionId: number };
};
export type BitcoinFissionHistoryEvent =
  | Extract<HistoricalEvent, { section: 'bitcoinFissions' }>
  | BitcoinMintFissionHistoryEvent;
type BitcoinFissionCreatedEvent = Extract<BitcoinFissionHistoryEvent, { method: 'FissionCreated' }>;
type BitcoinFissionUpdateEvent = Exclude<BitcoinFissionHistoryEvent, BitcoinFissionCreatedEvent>;

export class BitcoinFission implements IBitcoinFission {
  public ownerAccount: string;
  public fissionId: number;
  public liquidId: number;
  public utxoId: number;
  public satoshis: bigint;
  public microgonsAtTargetPerBtc: bigint;
  public liquidityPromised: bigint;
  public createdAtArgonBlock: number;
  public ratchetNumber: number;
  public lastRatchetTick?: number;
  public lastUpdatedArgonBlock: number;
  public origin?: 'created' | 'lock-migration';
  public ratchets: IBitcoinFissionRatchet[];
  public createdAtTick?: number;
  public createdBlockHash?: string;
  public createdBlockTime?: Date;
  public createdExtrinsicIndex?: number;
  public closedAtArgonBlock?: number;
  public closedAtTick?: number;
  public closedBlockHash?: string;
  public closedBlockTime?: Date;
  public closedExtrinsicIndex?: number;
  public closeReason?: 'closed' | 'lock-spent';
  public redemptionAmount?: bigint;
  public closeTxFee?: bigint;
  public btcPriceAtCloseMicrogons?: bigint;
  public feeHistoryCompleteThroughBlock?: number;
  public createdAt?: Date;
  public updatedAt?: Date;
  public pendingMints: IBitcoinPendingMint[];

  constructor(data: IBitcoinFission) {
    this.ownerAccount = data.ownerAccount;
    this.fissionId = data.fissionId;
    this.liquidId = data.liquidId;
    this.utxoId = data.utxoId;
    this.satoshis = data.satoshis;
    this.microgonsAtTargetPerBtc = data.microgonsAtTargetPerBtc;
    this.liquidityPromised = data.liquidityPromised;
    this.createdAtArgonBlock = data.createdAtArgonBlock;
    this.ratchetNumber = data.ratchetNumber;
    this.lastRatchetTick = data.lastRatchetTick;
    this.lastUpdatedArgonBlock = data.lastUpdatedArgonBlock;
    this.origin = data.origin;
    this.ratchets = data.ratchets ?? [];
    this.createdAtTick = data.createdAtTick;
    this.createdBlockHash = data.createdBlockHash;
    this.createdBlockTime = data.createdBlockTime;
    this.createdExtrinsicIndex = data.createdExtrinsicIndex;
    this.closedAtArgonBlock = data.closedAtArgonBlock;
    this.closedAtTick = data.closedAtTick;
    this.closedBlockHash = data.closedBlockHash;
    this.closedBlockTime = data.closedBlockTime;
    this.closedExtrinsicIndex = data.closedExtrinsicIndex;
    this.closeReason = data.closeReason;
    this.redemptionAmount = data.redemptionAmount;
    this.closeTxFee = data.closeTxFee;
    this.btcPriceAtCloseMicrogons = data.btcPriceAtCloseMicrogons;
    this.feeHistoryCompleteThroughBlock = data.feeHistoryCompleteThroughBlock;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.pendingMints = [];
  }

  public static allocateSatoshis<T extends { utxoId?: number; vaultId: number }>(args: {
    locks: T[];
    maximumSatoshisByUtxoId: Record<number, bigint>;
    selectedVaultIds: ReadonlySet<number>;
    requestedSatoshis: bigint;
  }): { lock: T; satoshis: bigint }[] {
    const { locks, maximumSatoshisByUtxoId, selectedVaultIds, requestedSatoshis } = args;
    let remaining = requestedSatoshis;
    const allocations: { lock: T; satoshis: bigint }[] = [];

    for (const lock of locks) {
      if (lock.utxoId == null || !selectedVaultIds.has(lock.vaultId) || remaining <= 0n) continue;

      const satoshis = bigIntMin(maximumSatoshisByUtxoId[lock.utxoId] ?? 0n, remaining);
      if (satoshis <= 0n) continue;

      allocations.push({ lock, satoshis });
      remaining -= satoshis;
    }

    return allocations;
  }

  public static isOwnedEvent(event: HistoricalEvent, ownerAccount: string): event is BitcoinFissionHistoryEvent {
    if (event.section === 'bitcoinFissions') return event.data.accountId === ownerAccount;
    return (
      event.section === 'mint' &&
      event.method === 'BitcoinMint' &&
      event.data.accountId === ownerAccount &&
      event.data.fissionId != null
    );
  }

  public static createRecordFromEvent(args: {
    block: IBlockHeaderInfo;
    event: BitcoinFissionCreatedEvent;
    extrinsicIndex?: number;
    transactionFee?: bigint;
  }): IBitcoinFissionRecord {
    const { block, event, extrinsicIndex, transactionFee } = args;
    const { accountId: ownerAccount, ...fission } = event.data;
    const blockTime = new Date(block.blockTime);
    return {
      origin: 'created',
      ownerAccount,
      ...fission,
      createdAtArgonBlock: block.blockNumber,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: block.blockNumber,
      ...(transactionFee === undefined ? {} : { feeHistoryCompleteThroughBlock: block.blockNumber }),
      ratchets: [
        {
          source: 'fission',
          sourceRatchetIndex: 0,
          ratchetNumber: 0,
          microgonsAtTargetPerBtc: fission.microgonsAtTargetPerBtc,
          liquidityPromised: fission.liquidityPromised,
          amountMinted: fission.liquidityPromised,
          amountBurned: 0n,
          mintPending: fission.liquidityPromised,
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
  }

  public static applyEventToRecord(args: {
    record: IBitcoinFissionRecord;
    block: IBlockHeaderInfo;
    event: BitcoinFissionUpdateEvent;
    extrinsicIndex?: number;
    transactionFee?: bigint;
    btcPriceAtCloseMicrogons?: bigint;
  }): IBitcoinFissionRecord {
    const { block, event, extrinsicIndex, transactionFee, btcPriceAtCloseMicrogons } = args;
    const blockTime = new Date(block.blockTime);
    const fissionId = event.data.fissionId;
    const record = { ...args.record, ratchets: args.record.ratchets.map(ratchet => ({ ...ratchet })) };

    if (event.section === 'mint') {
      let remaining = event.data.amount;
      for (const ratchet of record.ratchets) {
        const applied = bigIntMin(remaining, ratchet.mintPending);
        ratchet.mintPending -= applied;
        remaining -= applied;
        if (remaining === 0n) break;
      }
      if (remaining > 0n) throw new Error(`Bitcoin Fission ${fissionId} minted more than its recovered entitlement`);
      return record;
    }

    const priorFeesAreComplete =
      record.feeHistoryCompleteThroughBlock != null &&
      record.feeHistoryCompleteThroughBlock >= record.lastUpdatedArgonBlock;
    if (event.method === 'FissionRatcheted') {
      const { ratchetNumber } = event.data;
      const ratchet: IBitcoinFissionRatchet = {
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
        return candidate.source === ratchet.source && candidate.sourceRatchetIndex === ratchet.sourceRatchetIndex;
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
      return record;
    }

    if (event.method === 'FissionClosed' || event.method === 'FissionClosedByLock') {
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
      record.btcPriceAtCloseMicrogons = btcPriceAtCloseMicrogons;
      if (event.method === 'FissionClosed') record.redemptionAmount = event.data.redemptionAmount;
      return record;
    }

    const unsupportedEvent: never = event;
    throw new Error(`Unsupported Bitcoin Fission event: ${JSON.stringify(unsupportedEvent)}`);
  }

  public applyCurrentSnapshot(current: BitcoinFission): void {
    this.applyCurrentFields(current);
    this.reconcilePendingMints(current.pendingMints);
  }

  public enrichRecoveredHistory(record: IBitcoinFission): void {
    this.origin ??= record.origin;
    const ratchets = new Map(
      this.ratchets.map(ratchet => [`${ratchet.source}:${ratchet.sourceRatchetIndex}`, ratchet]),
    );
    for (const recovered of record.ratchets ?? []) {
      const identity = `${recovered.source}:${recovered.sourceRatchetIndex}`;
      const current = ratchets.get(identity);
      ratchets.set(
        identity,
        current
          ? {
              ...recovered,
              ...current,
              ratchetNumber: current.ratchetNumber ?? recovered.ratchetNumber,
              liquidityPromised: current.liquidityPromised ?? recovered.liquidityPromised,
              securityFee: current.securityFee ?? recovered.securityFee,
              securityFeeCoupon: current.securityFeeCoupon ?? recovered.securityFeeCoupon,
              txFee: current.txFee ?? recovered.txFee,
              tick: current.tick ?? recovered.tick,
              blockHash: current.blockHash ?? recovered.blockHash,
              blockTime: current.blockTime ?? recovered.blockTime,
              extrinsicIndex: current.extrinsicIndex ?? recovered.extrinsicIndex,
            }
          : recovered,
      );
    }
    this.ratchets = [...ratchets.values()].sort(
      (left, right) => left.blockNumber - right.blockNumber || left.sourceRatchetIndex - right.sourceRatchetIndex,
    );
    this.feeHistoryCompleteThroughBlock =
      Math.max(this.feeHistoryCompleteThroughBlock ?? 0, record.feeHistoryCompleteThroughBlock ?? 0) || undefined;
    this.createdAtTick ??= record.createdAtTick;
    this.createdBlockHash ??= record.createdBlockHash;
    this.createdBlockTime ??= record.createdBlockTime;
    this.createdExtrinsicIndex ??= record.createdExtrinsicIndex;
    this.createdAt ??= record.createdAt;
    this.updatedAt ??= record.updatedAt;
  }

  public mergeRecoveredRecord(record: IBitcoinFission): void {
    const recoveredCloseIsAtLaterBlock =
      record.closedAtArgonBlock !== undefined &&
      (this.closedAtArgonBlock === undefined || record.closedAtArgonBlock > this.closedAtArgonBlock);
    const recoveredCloseIsLaterInSameBlock =
      record.closedAtArgonBlock === this.closedAtArgonBlock &&
      (record.closedExtrinsicIndex ?? -1) > (this.closedExtrinsicIndex ?? -1);
    const recoveredCloseIsNewer = recoveredCloseIsAtLaterBlock || recoveredCloseIsLaterInSameBlock;
    const recoveredCurrentIsNewer =
      record.lastUpdatedArgonBlock > this.lastUpdatedArgonBlock ||
      (record.lastUpdatedArgonBlock === this.lastUpdatedArgonBlock && record.ratchetNumber > this.ratchetNumber);
    if (!recoveredCloseIsNewer && !recoveredCurrentIsNewer) {
      this.enrichRecoveredHistory(record);
      return;
    }

    const recovered = new BitcoinFission(record);
    recovered.enrichRecoveredHistory(this);
    this.applyStoredRecord(recovered);
  }

  public applyStoredRecord(record: IBitcoinFission): void {
    Object.assign(this, record, {
      ratchets: record.ratchets ?? [],
      pendingMints: this.pendingMints,
    });
  }

  public reconcilePendingMints(pendingMints: IBitcoinPendingMint[]): void {
    this.pendingMints = pendingMints;
    let remaining = pendingMints.reduce((total, mint) => total + mint.remainingAmount, 0n);
    const recordedEntitlement = this.ratchets.reduce((total, ratchet) => total + ratchet.amountMinted, 0n);
    if (remaining > recordedEntitlement) return;

    for (const ratchet of this.ratchets.toReversed()) {
      ratchet.mintPending = bigIntMin(remaining, ratchet.amountMinted);
      remaining -= ratchet.mintPending;
    }
  }

  public isRatchetAvailable(args: { microgonsAtTargetPerBtc: bigint; minimumRatchetPercent: bigint }): boolean {
    const { microgonsAtTargetPerBtc, minimumRatchetPercent } = args;
    const difference = bigIntAbs(microgonsAtTargetPerBtc - this.microgonsAtTargetPerBtc);
    const minimumChange = (this.microgonsAtTargetPerBtc * minimumRatchetPercent + 99n) / 100n;
    return difference > 0n && difference >= minimumChange;
  }

  public calculateRatchetAmounts(args: {
    priceIndex: PriceIndex;
    microgonsAtTargetPerBtc: bigint;
  }): IBitcoinFissionRatchetAmounts {
    const { priceIndex, microgonsAtTargetPerBtc } = args;
    const sourceLiquidity = this.liquidityPromised;
    const replacementLiquidity = BitcoinLock.calculateLiquidityPromised({
      priceIndex,
      satoshis: this.satoshis,
      microgonsAtTargetPerBtc,
    });

    if (replacementLiquidity >= sourceLiquidity) {
      return {
        sourceLiquidity,
        replacementLiquidity,
        amountMinted: replacementLiquidity - sourceLiquidity,
        amountBurned: 0n,
      };
    }

    return {
      sourceLiquidity,
      replacementLiquidity,
      amountMinted: replacementLiquidity,
      amountBurned: replacementLiquidity,
    };
  }

  public calculateRedemptionAmount(priceIndex: PriceIndex): bigint {
    const maximumMicrogonsAtTarget = (this.satoshis * this.microgonsAtTargetPerBtc) / SATS_PER_BTC;
    return BitcoinLock.calculateRedemptionAmountFromSatoshis(priceIndex, this.satoshis, maximumMicrogonsAtTarget);
  }

  public static createTx(args: {
    client: ArgonClient;
    fissionId: number;
    liquidId: number;
    utxoId: number;
    satoshis: bigint;
    microgonsAtTargetPerBtc: bigint;
  }) {
    const { client, fissionId, liquidId, utxoId, satoshis, microgonsAtTargetPerBtc } = args;
    return client.tx.bitcoinFissions.create(fissionId, liquidId, utxoId, satoshis, microgonsAtTargetPerBtc);
  }

  public static createRatchetTx(args: { client: ArgonClient; fissionId: number; microgonsAtTargetPerBtc: bigint }) {
    const { client, fissionId, microgonsAtTargetPerBtc } = args;
    return client.tx.bitcoinFissions.ratchet(fissionId, microgonsAtTargetPerBtc);
  }

  public static createCloseTx(args: { client: ArgonClient; fissionId: number }) {
    const { client, fissionId } = args;
    return client.tx.bitcoinFissions.close(fissionId);
  }

  public static async getAllByOwner(client: IQueryableClient, ownerAccount: string): Promise<BitcoinFission[]> {
    const entries = await client.query.bitcoinFissions.fissionByOwnerAndId.entries(ownerAccount);

    return (entries ?? []).flatMap(([key, rawFission]) => {
      if (!rawFission) return [];

      const fissionId = key.args[1];
      return [BitcoinFission.fromRuntime(ownerAccount, fissionId, rawFission)];
    });
  }

  public static async get(
    client: IQueryableClient,
    ownerAccount: string,
    fissionId: number,
  ): Promise<BitcoinFission | undefined> {
    const rawFission = await client.query.bitcoinFissions.fissionByOwnerAndId(ownerAccount, fissionId);
    if (!rawFission) return;

    return BitcoinFission.fromRuntime(ownerAccount, fissionId, rawFission);
  }

  public static async idsByLock(client: IQueryableClient, utxoId: number): Promise<number[]> {
    const fissionIds = await client.query.bitcoinFissions.fissionIdsByLockId(utxoId);
    return [...(fissionIds ?? [])];
  }

  public static async nextId(client: IQueryableClient, ownerAccount: string): Promise<number> {
    const fissionId = await client.query.bitcoinFissions.nextFissionIdByOwner(ownerAccount);
    return fissionId ?? 0;
  }

  public static async pendingMintsForLock(client: IQueryableClient, utxoId: number): Promise<IBitcoinPendingMint[]> {
    const pendingIndices = await client.query.mint.pendingMintUtxoIdLookup(utxoId);
    if (!pendingIndices) return [];
    const pendingMints = await client.query.mint.pendingMintUtxosByIndex.multi(pendingIndices.map(BigInt));

    return (pendingMints ?? []).flatMap((rawMint, index) => {
      if (!rawMint || rawMint.fissionId === undefined) return [];

      return [
        {
          queueIndex: pendingIndices[index],
          fissionId: rawMint.fissionId,
          utxoId: rawMint.utxoId,
          ownerAccount: rawMint.accountId,
          remainingAmount: rawMint.remainingAmount,
          maxAmountPerFrame: rawMint.maxAmountPerFrame,
        },
      ];
    });
  }

  private static fromRuntime(
    ownerAccount: string,
    fissionId: number,
    fission: NonNullable<BitcoinFissionsFissionByOwnerAndIdResultSpec159>,
  ): BitcoinFission {
    return new BitcoinFission({
      ...fission,
      ownerAccount,
      fissionId,
    });
  }

  private applyCurrentFields(current: IBitcoinFission): void {
    this.ownerAccount = current.ownerAccount;
    this.fissionId = current.fissionId;
    this.liquidId = current.liquidId;
    this.utxoId = current.utxoId;
    this.satoshis = current.satoshis;
    this.microgonsAtTargetPerBtc = current.microgonsAtTargetPerBtc;
    this.liquidityPromised = current.liquidityPromised;
    this.createdAtArgonBlock = current.createdAtArgonBlock;
    this.ratchetNumber = current.ratchetNumber;
    this.lastRatchetTick = current.lastRatchetTick;
    this.lastUpdatedArgonBlock = current.lastUpdatedArgonBlock;
  }
}

export interface IBitcoinFission {
  ownerAccount: string;
  fissionId: number;
  liquidId: number;
  utxoId: number;
  satoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  liquidityPromised: bigint;
  createdAtArgonBlock: number;
  ratchetNumber: number;
  lastRatchetTick?: number;
  lastUpdatedArgonBlock: number;
  origin?: 'created' | 'lock-migration';
  ratchets?: IBitcoinFissionRatchet[];
  createdAtTick?: number;
  createdBlockHash?: string;
  createdBlockTime?: Date;
  createdExtrinsicIndex?: number;
  closedAtArgonBlock?: number;
  closedAtTick?: number;
  closedBlockHash?: string;
  closedBlockTime?: Date;
  closedExtrinsicIndex?: number;
  closeReason?: 'closed' | 'lock-spent';
  redemptionAmount?: bigint;
  closeTxFee?: bigint;
  btcPriceAtCloseMicrogons?: bigint;
  feeHistoryCompleteThroughBlock?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export type IBitcoinFissionRecord = IBitcoinFission &
  Required<Pick<IBitcoinFission, 'origin' | 'ratchets' | 'createdAt' | 'updatedAt'>>;

export interface IBitcoinFissionRatchet {
  source: 'lock' | 'fission';
  sourceRatchetIndex: number;
  ratchetNumber?: number;
  microgonsAtTargetPerBtc: bigint;
  liquidityPromised?: bigint;
  amountMinted: bigint;
  amountBurned: bigint;
  mintPending: bigint;
  securityFee?: bigint;
  securityFeeCoupon?: bigint;
  txFee?: bigint;
  blockNumber: number;
  tick?: number;
  blockHash?: string;
  blockTime?: Date;
  extrinsicIndex?: number;
}

export interface IBitcoinFissionRatchetAmounts {
  sourceLiquidity: bigint;
  replacementLiquidity: bigint;
  amountMinted: bigint;
  amountBurned: bigint;
}

export interface IBitcoinPendingMint {
  queueIndex: number;
  fissionId: number;
  utxoId: number;
  ownerAccount: string;
  remainingAmount: bigint;
  maxAmountPerFrame: bigint;
}
