import type { FrameSystemEventRecord } from '@argonprotocol/mainchain';
import { BondLot, type Currency, type IBlockHeaderInfo, type MiningFrames } from '@argonprotocol/apps-core';
import type { Db } from '../Db.ts';
import { readRequiredEventField, readRequiredEventNumber } from './index.ts';
import type { WalletKeys } from '../WalletKeys.ts';

export class ArgonBondsRecovery {
  private readonly dbPromise: Promise<Db>;
  private readonly currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>;
  private readonly miningFrames: MiningFrames;
  private readonly walletKeys: WalletKeys;

  constructor({
    dbPromise,
    currency,
    miningFrames,
    walletKeys,
  }: {
    dbPromise: Promise<Db>;
    currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>;
    miningFrames: MiningFrames;
    walletKeys: WalletKeys;
  }) {
    this.dbPromise = dbPromise;
    this.currency = currency;
    this.miningFrames = miningFrames;
    this.walletKeys = walletKeys;
  }

  public async importBlock(block: IBlockHeaderInfo, events: readonly FrameSystemEventRecord[]): Promise<void> {
    for (const { event, phase } of events) {
      if (event.section !== 'treasury' || !['BondLotPurchased', 'BondLotReleased'].includes(event.method)) continue;

      const accountId = readRequiredEventField(event, 'accountId', block);
      if (accountId.toString() !== this.walletKeys.defaultArgonAddress) continue;

      const bondLotId = readRequiredEventNumber(event, 'bondLotId', block);
      const extrinsicIndex = phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : undefined;
      if (event.method === 'BondLotPurchased') {
        await this.recordPurchase(block, bondLotId, extrinsicIndex);
      } else {
        await this.recordRelease(block, bondLotId, extrinsicIndex);
      }
    }
  }

  public async recordPurchase(block: IBlockHeaderInfo, bondLotId: number, extrinsicIndex?: number): Promise<void> {
    const api = await this.miningFrames.blockWatch.getApi(block);
    const lotOption = await api.query.treasury.bondLotById(bondLotId);
    if (lotOption.isNone) {
      throw new Error(`Purchased bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);
    }

    const lot = this.decodeStoredBondLot(bondLotId, lotOption.unwrap());
    await (
      await this.dbPromise
    ).bondLotHistoryTable.recordObservation({
      lot,
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      purchase: {
        blockTime: new Date(block.blockTime),
        extrinsicIndex,
        entryArgonotRateMicrogons: lot.programType === 'Argonot' ? await this.getArgonotPrice(block) : undefined,
      },
    });
  }

  private async recordRelease(block: IBlockHeaderInfo, bondLotId: number, extrinsicIndex?: number): Promise<void> {
    let parent: IBlockHeaderInfo;
    try {
      parent = await this.miningFrames.blockWatch.getParentHeader(block);
    } catch (error) {
      if (!block.isFinalized || block.blockNumber === 0) throw error;

      console.warn(
        `[ArgonBonds] Parent hash lookup failed for finalized block ${block.blockNumber}; retrying by block number`,
        error,
      );
      parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
    }
    const parentApi = await this.miningFrames.blockWatch.getApi(parent);
    const lotOption = await parentApi.query.treasury.bondLotById(bondLotId);
    if (lotOption.isNone) {
      throw new Error(`Released bond lot ${bondLotId} is unavailable before block ${block.blockNumber}`);
    }

    const lot = this.decodeStoredBondLot(bondLotId, lotOption.unwrap());
    await (
      await this.dbPromise
    ).bondLotHistoryTable.recordRelease({
      lot,
      parentBlockNumber: parent.blockNumber,
      parentBlockHash: parent.blockHash,
      release: {
        blockNumber: block.blockNumber,
        blockHash: block.blockHash,
        blockTime: new Date(block.blockTime),
        extrinsicIndex,
        closingArgonotRateMicrogons: lot.programType === 'Argonot' ? await this.getArgonotPrice(block) : undefined,
      },
    });
  }

  private decodeStoredBondLot(id: number, lot: Parameters<typeof BondLot.fromRuntime>[1]): BondLot {
    if (lot.get('program')) {
      return BondLot.fromRuntime(id, lot, this.walletKeys.defaultArgonAddress);
    }

    // Older archive storage predates the program field and has no
    // sharing/bonus fields. Current and immediately previous runtime codecs
    // continue through BondLot.fromRuntime.
    const vaultId = lot.get('vaultId');
    if (!vaultId) throw new Error(`Historical vault bond lot ${id} is missing its vault`);

    const accountId = lot.owner.toString();
    const bonds = lot.bonds.toNumber();
    const participatedFrames = lot.participatedFrames.toNumber();
    return new BondLot({
      id,
      programType: 'Vault',
      accountId,
      vaultId: Number(vaultId.toString()),
      bonds,
      createdFrame: lot.createdFrameId.toNumber(),
      participatedFrames,
      lastEarningsFrame: lot.lastFrameEarningsFrameId.isSome ? lot.lastFrameEarningsFrameId.unwrap().toNumber() : null,
      lastEarnings: lot.lastFrameEarnings.isSome ? lot.lastFrameEarnings.unwrap().toBigInt() : 0n,
      lifetimeEarnings: lot.cumulativeEarnings.toBigInt(),
      lifetimeBondedFrameMicrogons: BondLot.bondsToMicrogons(bonds) * BigInt(participatedFrames),
      bonusPercent: 0,
      releaseFrame: lot.releaseFrameId.isSome ? lot.releaseFrameId.unwrap().toNumber() : null,
      releaseReason: lot.releaseReason.isSome ? lot.releaseReason.unwrap().type : undefined,
      isReleasing: lot.releaseReason.isSome,
      isOwn: accountId === this.walletKeys.defaultArgonAddress,
      canRelease: accountId === this.walletKeys.defaultArgonAddress,
    });
  }

  private async getArgonotPrice(block: IBlockHeaderInfo): Promise<bigint | undefined> {
    const api = await this.miningFrames.blockWatch.getApi(block);
    return (await this.currency.fetchMainchainRatesAtBlock({ api, block })).ARGNOT;
  }
}
