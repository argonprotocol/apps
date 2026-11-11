import type {
  IStabilizerBuyRecord,
  IStabilizerBuysRecord,
  IStabilizerBuyFrameRewards,
} from '../../interfaces/IStabilizerBuyPurchase.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';

export class StabilizerBuysTable extends BaseTable {
  private readonly buyFieldTypes: IFieldTypes = {
    bigint: [
      'principal',
      'matchingBasis',
      'releasedPrincipal',
      'ethereumMaxFeeWei',
      'usdcApprovalFeeWei',
      'ethereumFeeWei',
      'spentMicrogons',
      'ethereumFeeMicrogons',
      'usdcApprovalFeeMicrogons',
    ],
    json: [
      'ethereumQuote',
      'ethereumGatewayActivity',
      'usdcApprovalPrices',
      'ethereumPrices',
      'argonPurchaseEvent',
      'liquidRepaymentEvent',
      'purchaseAdmissionFailure',
      'argonFees',
    ],
    date: [
      'createdAt',
      'updatedAt',
      'purchasedAt',
      'usdcApprovalSubmittedAt',
      'ethereumSubmittedAt',
      'ethereumConfirmedAt',
      'purchaseArgonRecognitionBlockTime',
      'purchaseArgonReleaseBlockTime',
    ],
  };

  private readonly rewardFieldTypes: IFieldTypes = {
    bigint: ['requestedReward', 'awardedReward', 'paidReward'],
    json: ['bidEvent', 'rewardAward', 'payout', 'bidFees', 'repaymentRewards'],
    date: ['createdAt', 'updatedAt'],
  };

  public async fetchAll(ownerAccount: string): Promise<IStabilizerBuysRecord> {
    const [buys, rewards] = await Promise.all([
      this.db.select<IStabilizerBuyRecord[]>(
        'SELECT * FROM StabilizerBuys WHERE ownerAccount = ? ORDER BY createdAt DESC, id',
        toSqlParams([ownerAccount]),
      ),
      this.db.select<IStabilizerBuyFrameRewards[]>(
        'SELECT * FROM StabilizerBuyFrameRewards WHERE ownerAccount = ? ORDER BY admissionFrame',
        toSqlParams([ownerAccount]),
      ),
    ]);
    return {
      buys: convertFromSqliteFields<IStabilizerBuyRecord[]>(buys, this.buyFieldTypes).map(omitNulls),
      frameRewards: convertFromSqliteFields<IStabilizerBuyFrameRewards[]>(rewards, this.rewardFieldTypes).map(
        omitNulls,
      ),
    };
  }

  public async saveBuy(record: IStabilizerBuyRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO StabilizerBuys (
        ownerAccount, id, gatewayTransferId, status,
        admissionFrame, principal, matchingBasis, ethereumQuote,
        ethereumMaxFeeWei, usdcApprovalTxHash, usdcApprovalSubmittedAt, usdcApprovalFeeWei,
        usdcApprovalPrices, ethereumTxHash, ethereumSubmittedAt, ethereumFeeWei,
        ethereumPrices, ethereumGatewayActivity, purchaseEthereumBlockNumber, purchaseEthereumBlockHash,
        purchaseEthereumLogIndex, ethereumConfirmedAt, argonPurchaseEvent, purchaseArgonRecognitionBlockNumber,
        purchaseArgonRecognitionBlockHash, purchaseArgonRecognitionBlockTime, purchaseArgonRecognitionEventIndex, ineligibleReason,
        purchaseArgonReleaseBlockNumber, purchaseArgonReleaseBlockHash, purchaseArgonReleaseBlockTime, purchaseArgonReleaseEventIndex,
        purchasedAt, spentMicrogons, ethereumFeeMicrogons, usdcApprovalFeeMicrogons,
        argonFees, statusError, createdAt, updatedAt,
        repayLiquidId, liquidRepaymentEvent, purchaseAdmissionFailure, releasedPrincipal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (ownerAccount, id) DO UPDATE SET
        repayLiquidId = excluded.repayLiquidId,
        liquidRepaymentEvent = excluded.liquidRepaymentEvent,
        purchaseAdmissionFailure = excluded.purchaseAdmissionFailure,
        releasedPrincipal = excluded.releasedPrincipal,
        gatewayTransferId = excluded.gatewayTransferId,
        status = excluded.status,
        admissionFrame = excluded.admissionFrame,
        principal = excluded.principal,
        matchingBasis = excluded.matchingBasis,
        ethereumQuote = excluded.ethereumQuote,
        ethereumMaxFeeWei = excluded.ethereumMaxFeeWei,
        usdcApprovalTxHash = excluded.usdcApprovalTxHash,
        usdcApprovalSubmittedAt = excluded.usdcApprovalSubmittedAt,
        usdcApprovalFeeWei = excluded.usdcApprovalFeeWei,
        usdcApprovalPrices = excluded.usdcApprovalPrices,
        ethereumTxHash = excluded.ethereumTxHash,
        ethereumSubmittedAt = excluded.ethereumSubmittedAt,
        ethereumFeeWei = excluded.ethereumFeeWei,
        ethereumPrices = excluded.ethereumPrices,
        ethereumGatewayActivity = excluded.ethereumGatewayActivity,
        purchaseEthereumBlockNumber = excluded.purchaseEthereumBlockNumber,
        purchaseEthereumBlockHash = excluded.purchaseEthereumBlockHash,
        purchaseEthereumLogIndex = excluded.purchaseEthereumLogIndex,
        ethereumConfirmedAt = excluded.ethereumConfirmedAt,
        argonPurchaseEvent = excluded.argonPurchaseEvent,
        purchaseArgonRecognitionBlockNumber = excluded.purchaseArgonRecognitionBlockNumber,
        purchaseArgonRecognitionBlockHash = excluded.purchaseArgonRecognitionBlockHash,
        purchaseArgonRecognitionBlockTime = excluded.purchaseArgonRecognitionBlockTime,
        purchaseArgonRecognitionEventIndex = excluded.purchaseArgonRecognitionEventIndex,
        ineligibleReason = excluded.ineligibleReason,
        purchaseArgonReleaseBlockNumber = excluded.purchaseArgonReleaseBlockNumber,
        purchaseArgonReleaseBlockHash = excluded.purchaseArgonReleaseBlockHash,
        purchaseArgonReleaseBlockTime = excluded.purchaseArgonReleaseBlockTime,
        purchaseArgonReleaseEventIndex = excluded.purchaseArgonReleaseEventIndex,
        purchasedAt = excluded.purchasedAt,
        spentMicrogons = excluded.spentMicrogons,
        ethereumFeeMicrogons = excluded.ethereumFeeMicrogons,
        usdcApprovalFeeMicrogons = excluded.usdcApprovalFeeMicrogons,
        argonFees = excluded.argonFees,
        statusError = excluded.statusError,
        createdAt = excluded.createdAt,
        updatedAt = excluded.updatedAt`,
      toSqlParams([
        record.ownerAccount,
        record.id,
        record.gatewayTransferId,
        record.status,
        record.admissionFrame,
        record.principal,
        record.matchingBasis,
        record.ethereumQuote,
        record.ethereumMaxFeeWei,
        record.usdcApprovalTxHash,
        record.usdcApprovalSubmittedAt,
        record.usdcApprovalFeeWei,
        record.usdcApprovalPrices,
        record.ethereumTxHash,
        record.ethereumSubmittedAt,
        record.ethereumFeeWei,
        record.ethereumPrices,
        record.ethereumGatewayActivity,
        record.purchaseEthereumBlockNumber,
        record.purchaseEthereumBlockHash,
        record.purchaseEthereumLogIndex,
        record.ethereumConfirmedAt,
        record.argonPurchaseEvent,
        record.purchaseArgonRecognitionBlockNumber,
        record.purchaseArgonRecognitionBlockHash,
        record.purchaseArgonRecognitionBlockTime,
        record.purchaseArgonRecognitionEventIndex,
        record.ineligibleReason,
        record.purchaseArgonReleaseBlockNumber,
        record.purchaseArgonReleaseBlockHash,
        record.purchaseArgonReleaseBlockTime,
        record.purchaseArgonReleaseEventIndex,
        record.purchasedAt,
        record.spentMicrogons,
        record.ethereumFeeMicrogons,
        record.usdcApprovalFeeMicrogons,
        record.argonFees,
        record.statusError,
        record.createdAt,
        record.updatedAt,
        record.repayLiquidId,
        record.liquidRepaymentEvent,
        record.purchaseAdmissionFailure,
        record.releasedPrincipal,
      ]),
    );
  }

  public async saveFrameRewards(record: IStabilizerBuyFrameRewards): Promise<void> {
    await this.db.execute(
      `INSERT INTO StabilizerBuyFrameRewards (
        ownerAccount, admissionFrame, bidCount, latestBid,
        bidEvent, lastUpdatedArgonBlock, requestedReward, rewardAward,
        awardedReward, maturesAtFrame, paidReward, payout,
        bidFees, createdAt, updatedAt, repaymentRewards
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (ownerAccount, admissionFrame) DO UPDATE SET
        repaymentRewards = excluded.repaymentRewards,
        bidCount = excluded.bidCount,
        latestBid = excluded.latestBid,
        bidEvent = excluded.bidEvent,
        lastUpdatedArgonBlock = excluded.lastUpdatedArgonBlock,
        requestedReward = excluded.requestedReward,
        rewardAward = excluded.rewardAward,
        awardedReward = excluded.awardedReward,
        maturesAtFrame = excluded.maturesAtFrame,
        paidReward = excluded.paidReward,
        payout = excluded.payout,
        bidFees = excluded.bidFees,
        createdAt = excluded.createdAt,
        updatedAt = excluded.updatedAt`,
      toSqlParams([
        record.ownerAccount,
        record.admissionFrame,
        record.bidCount,
        record.latestBid,
        record.bidEvent,
        record.lastUpdatedArgonBlock,
        record.requestedReward,
        record.rewardAward,
        record.awardedReward,
        record.maturesAtFrame,
        record.paidReward,
        record.payout,
        record.bidFees,
        record.createdAt,
        record.updatedAt,
        record.repaymentRewards ?? [],
      ]),
    );
  }

  public async deleteBuy(ownerAccount: string, id: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM StabilizerBuys WHERE ownerAccount = ? AND id = ?',
      toSqlParams([ownerAccount, id]),
    );
  }
}

function omitNulls<Record extends object>(record: Record): Record {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null)) as Record;
}
