import { bigNumberToBigInt, type IBlockHeaderInfo, type RuntimeSystemEventRecord } from '@argonprotocol/apps-core';
import type { HistoricalEvent } from '@argonprotocol/runtime-client/events';
import type { Db } from '../Db.ts';
import type { IVaultCapitalHistoryRecord } from '../db/VaultCapitalHistoryTable.ts';
import type { IVaultRevenueEventsRecord } from '../db/VaultRevenueEventsTable.ts';

type HistoricalVaultEvent = Extract<HistoricalEvent, { section: 'vaults' }>;

export class VaultHistory {
  private readonly vaultIds = new Set<number>();
  private isLoaded = false;
  private loadedAccountId?: string;
  private capitalCache?: {
    revision: number;
    records: Promise<IVaultCapitalHistoryRecord[]>;
  };
  private revenueCache?: {
    revision: number;
    records: Promise<IVaultRevenueEventsRecord[]>;
  };

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly accountId: string | (() => string),
    private readonly onHistoryChanged?: () => void,
  ) {}

  public async importBlock(block: IBlockHeaderInfo, events: readonly RuntimeSystemEventRecord[]): Promise<void> {
    const accountId = this.useCurrentAccount();
    const db = await this.dbPromise;
    if (!this.isLoaded) {
      const storedVaultIds = await db.vaultCapitalHistoryTable.fetchVaultIds(accountId);
      for (const vaultId of storedVaultIds) this.vaultIds.add(vaultId);
      this.isLoaded = true;
    }

    let didChange = false;
    for (const { event, phase } of events) {
      if (event.section !== 'vaults') continue;

      const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
      if (await this.importEvent(db, block, event, extrinsicIndex, accountId)) didChange = true;
    }
    if (didChange) this.onHistoryChanged?.();
  }

  private async importEvent(
    db: Db,
    block: IBlockHeaderInfo,
    event: HistoricalVaultEvent,
    extrinsicIndex: number | undefined,
    accountId: string,
  ): Promise<boolean> {
    if (
      event.section !== 'vaults' ||
      (event.method !== 'VaultCreated' &&
        event.method !== 'VaultModified' &&
        event.method !== 'FundsScheduledForRelease' &&
        event.method !== 'FundsReleased' &&
        event.method !== 'VaultClosed' &&
        event.method !== 'LostBitcoinCompensated' &&
        event.method !== 'VaultCollected')
    ) {
      return false;
    }

    const vaultId = event.data.vaultId;
    if (event.method === 'VaultCreated') {
      if (event.data.operatorAccountId !== accountId) return false;

      this.vaultIds.add(vaultId);
      await db.vaultCapitalHistoryTable.insert({
        eventType: 'created',
        walletAddress: accountId,
        vaultId,
        securitization: readVaultSecuritization(event),
        blockNumber: block.blockNumber,
        blockHash: block.blockHash,
        blockTime: new Date(block.blockTime),
        extrinsicIndex,
      });
      return true;
    }
    if (!this.vaultIds.has(vaultId)) return false;

    const eventIdentity = {
      walletAddress: accountId,
      vaultId,
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      blockTime: new Date(block.blockTime),
      extrinsicIndex,
    };
    if (event.method === 'VaultModified') {
      const securitization = readVaultSecuritization(event);
      // Older events only contain securitization; newer events also expose the
      // long-term target while already-committed funds roll off.
      const securitizationTarget = event.data.securitizationTarget ?? securitization;
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'modified',
        securitization,
        securitizationTarget,
      });
    } else if (event.method === 'FundsScheduledForRelease') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'releaseScheduled',
        securitization: event.data.securitization ?? event.data.amount ?? 0n,
        releaseHeight: event.data.releaseHeight,
      });
    } else if (event.method === 'FundsReleased') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'released',
        securitization: event.data.securitization ?? event.data.amount ?? 0n,
      });
    } else if (event.method === 'VaultClosed') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'closed',
        securitizationRemaining: event.data.securitizationRemaining ?? event.data.remainingSecuritization ?? 0n,
        securitizationReleased: event.data.securitizationReleased ?? event.data.released ?? 0n,
      });
    } else if (event.method === 'LostBitcoinCompensated') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'capitalLost',
        amount: event.data.toBeneficiary + event.data.burned,
      });
    } else if (event.method === 'VaultCollected') {
      await db.vaultRevenueEventsTable.insert({
        amount: event.data.revenue,
        source: 'vaultCollect',
        extrinsicIndex,
        blockNumber: block.blockNumber,
        blockHash: block.blockHash,
        blockTime: new Date(block.blockTime),
      });
    }
    return true;
  }

  public async loadPositionHistory(): Promise<{
    capital: IVaultCapitalHistoryRecord[];
    revenue: IVaultRevenueEventsRecord[];
  }> {
    const accountId = this.useCurrentAccount();
    const db = await this.dbPromise;
    const capitalRevision = db.vaultCapitalHistoryTable.revision;
    const revenueRevision = db.vaultRevenueEventsTable.revision;
    if (this.capitalCache?.revision !== capitalRevision) {
      this.capitalCache = {
        revision: capitalRevision,
        records: db.vaultCapitalHistoryTable.fetchAllByWallet(accountId),
      };
    }
    if (this.revenueCache?.revision !== revenueRevision) {
      this.revenueCache = {
        revision: revenueRevision,
        records: db.vaultRevenueEventsTable.fetchAll(),
      };
    }
    const [capital, revenue] = await Promise.all([this.capitalCache.records, this.revenueCache.records]);
    return { capital, revenue };
  }

  private useCurrentAccount(): string {
    const accountId = typeof this.accountId === 'function' ? this.accountId() : this.accountId;
    if (this.loadedAccountId === accountId) return accountId;

    this.loadedAccountId = accountId;
    this.vaultIds.clear();
    this.isLoaded = false;
    this.capitalCache = undefined;
    this.revenueCache = undefined;
    return accountId;
  }
}

function readVaultSecuritization(
  event: Extract<HistoricalEvent, { section: 'vaults'; method: 'VaultCreated' | 'VaultModified' }>,
): bigint {
  const securitization = event.data.securitization;
  if (securitization !== undefined) return securitization;

  // The first spec-116 runtime still reported the three components held under
  // EnterVault. Its added percentage applied only to locked Bitcoin capital.
  const locked = event.data.lockedBitcoinArgons ?? 0n;
  const bonded = event.data.bondedBitcoinArgons ?? 0n;
  const addedPercent = event.data.addedSecuritizationPercent;
  const addedSecuritization = addedPercent ? bigNumberToBigInt(addedPercent.multipliedBy(locked)) : 0n;
  return locked + bonded + addedSecuritization;
}
