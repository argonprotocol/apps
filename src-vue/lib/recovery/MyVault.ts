import { FIXED_U128_DECIMALS, type FrameSystemEventRecord, type GenericEvent } from '@argonprotocol/mainchain';
import { readEventField, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import type { IVaultCapitalHistoryRecord } from '../db/VaultCapitalHistoryTable.ts';
import type { IVaultRevenueEventsRecord } from '../db/VaultRevenueEventsTable.ts';
import { readRequiredEventBigInt, readRequiredEventField, readRequiredEventNumber } from './index.ts';

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

    for (const { event, phase } of events) {
      if (event.section !== 'vaults') continue;

      const extrinsicIndex = phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : undefined;
      await this.importEvent(db, block, event, extrinsicIndex, accountId);
    }
  }

  private async importEvent(
    db: Db,
    block: IBlockHeaderInfo,
    event: GenericEvent,
    extrinsicIndex: number | undefined,
    accountId: string,
  ): Promise<void> {
    if (!vaultHistoryEventMethods.has(event.method)) return;

    const vaultId = readRequiredEventNumber(event, 'vaultId', block);
    if (event.method === 'VaultCreated') {
      const operatorAccountId = readRequiredEventField(event, 'operatorAccountId', block);
      if (operatorAccountId.toString() !== accountId) return;

      this.vaultIds.add(vaultId);
      await db.vaultCapitalHistoryTable.insert({
        eventType: 'created',
        walletAddress: accountId,
        vaultId,
        securitization: readVaultSecuritization(event, block),
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
      const securitization = readVaultSecuritization(event, block);
      // Older events only contain securitization; newer events also expose the
      // long-term target while already-committed funds roll off.
      const target = readEventField(event, 'securitizationTarget');
      const securitizationTarget = target === undefined ? securitization : BigInt(target.toString());
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
        securitization: readRequiredEventBigInt(event, ['securitization', 'amount'], block),
        releaseHeight: readRequiredEventBigInt(event, ['releaseHeight'], block),
      });
    } else if (event.method === 'FundsReleased') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'released',
        securitization: readRequiredEventBigInt(event, ['securitization', 'amount'], block),
      });
    } else if (event.method === 'VaultClosed') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'closed',
        securitizationRemaining: readRequiredEventBigInt(
          event,
          ['securitizationRemaining', 'remainingSecuritization'],
          block,
        ),
        securitizationReleased: readRequiredEventBigInt(event, ['securitizationReleased', 'released'], block),
      });
    } else if (event.method === 'LostBitcoinCompensated') {
      await db.vaultCapitalHistoryTable.insert({
        ...eventIdentity,
        eventType: 'capitalLost',
        amount:
          readRequiredEventBigInt(event, ['toBeneficiary'], block) + readRequiredEventBigInt(event, ['burned'], block),
      });
    } else if (event.method === 'VaultCollected') {
      await db.vaultRevenueEventsTable.insert({
        amount: readRequiredEventBigInt(event, ['revenue'], block),
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

function readVaultSecuritization(event: GenericEvent, block: IBlockHeaderInfo): bigint {
  const securitization = readEventField(event, 'securitization');
  if (securitization !== undefined) return BigInt(securitization.toString());

  // The first spec-116 runtime still reported the three components held under
  // EnterVault. Its added percentage applied only to locked Bitcoin capital.
  const locked = readRequiredEventBigInt(event, ['lockedBitcoinArgons'], block);
  const bonded = readRequiredEventBigInt(event, ['bondedBitcoinArgons'], block);
  const addedPercent = readRequiredEventBigInt(event, ['addedSecuritizationPercent'], block);
  const addedSecuritization = (locked * addedPercent) / 10n ** BigInt(FIXED_U128_DECIMALS);
  return locked + bonded + addedSecuritization;
}

const vaultHistoryEventMethods = new Set([
  'VaultCreated',
  'VaultModified',
  'FundsScheduledForRelease',
  'FundsReleased',
  'VaultClosed',
  'LostBitcoinCompensated',
  'VaultCollected',
]);
