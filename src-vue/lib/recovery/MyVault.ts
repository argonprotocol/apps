import { FIXED_U128_DECIMALS, type FrameSystemEventRecord } from '@argonprotocol/mainchain';
import type { IBlockHeaderInfo } from '@argonprotocol/apps-core';
import type { HistoricalEvent } from '../../../indexer/src/HistoricalEventSpecs.ts';
import type { Db } from '../Db.ts';
import type { IVaultCapitalHistoryRecord } from '../db/VaultCapitalHistoryTable.ts';
import type { IVaultRevenueEventsRecord } from '../db/VaultRevenueEventsTable.ts';

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
  ) {}

  public async importBlock(block: IBlockHeaderInfo, events: readonly FrameSystemEventRecord[]): Promise<void> {
    const accountId = this.useCurrentAccount();
    const db = await this.dbPromise;
    if (!this.isLoaded) {
      const storedVaultIds = await db.vaultCapitalHistoryTable.fetchVaultIds(accountId);
      for (const vaultId of storedVaultIds) this.vaultIds.add(vaultId);
      this.isLoaded = true;
    }

    for (const { event: rawEvent, phase } of events) {
      const event = rawEvent as HistoricalEvent;
      if (event.section !== 'vaults') continue;

      const extrinsicIndex = phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : undefined;
      await this.importEvent(db, block, event, extrinsicIndex, accountId);
    }
  }

  private async importEvent(
    db: Db,
    block: IBlockHeaderInfo,
    event: HistoricalEvent,
    extrinsicIndex: number | undefined,
    accountId: string,
  ): Promise<void> {
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
      return;
    }

    const vaultId = event.data.vaultId.toNumber();
    if (event.method === 'VaultCreated') {
      if (event.data.operatorAccountId.toString() !== accountId) return;

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
      return;
    }
    if (!this.vaultIds.has(vaultId)) return;

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
      const securitizationTarget = event.data.securitizationTarget?.toBigInt() ?? securitization;
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
        securitization: event.data.securitization?.toBigInt() ?? event.data.amount?.toBigInt() ?? 0n,
        releaseHeight: event.data.releaseHeight.toBigInt(),
      });
    } else if (event.method === 'FundsReleased') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'released',
        securitization: event.data.securitization?.toBigInt() ?? event.data.amount?.toBigInt() ?? 0n,
      });
    } else if (event.method === 'VaultClosed') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'closed',
        securitizationRemaining:
          event.data.securitizationRemaining?.toBigInt() ?? event.data.remainingSecuritization?.toBigInt() ?? 0n,
        securitizationReleased: event.data.securitizationReleased?.toBigInt() ?? event.data.released?.toBigInt() ?? 0n,
      });
    } else if (event.method === 'LostBitcoinCompensated') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'capitalLost',
        amount: event.data.toBeneficiary.toBigInt() + event.data.burned.toBigInt(),
      });
    } else if (event.method === 'VaultCollected') {
      await db.vaultRevenueEventsTable.insert({
        amount: event.data.revenue.toBigInt(),
        source: 'vaultCollect',
        extrinsicIndex,
        blockNumber: block.blockNumber,
        blockHash: block.blockHash,
        blockTime: new Date(block.blockTime),
      });
    }
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
  const securitization = event.data.securitization?.toBigInt();
  if (securitization !== undefined) return securitization;

  // The first spec-116 runtime still reported the three components held under
  // EnterVault. Its added percentage applied only to locked Bitcoin capital.
  const locked = event.data.lockedBitcoinArgons?.toBigInt() ?? 0n;
  const bonded = event.data.bondedBitcoinArgons?.toBigInt() ?? 0n;
  const addedPercent = event.data.addedSecuritizationPercent?.toBigInt() ?? 0n;
  const addedSecuritization = (locked * addedPercent) / 10n ** BigInt(FIXED_U128_DECIMALS);
  return locked + bonded + addedSecuritization;
}
