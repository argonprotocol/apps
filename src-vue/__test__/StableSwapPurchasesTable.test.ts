import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { StableSwapProofStatus } from '../lib/db/StableSwapPurchasesTable.ts';

describe('StableSwapPurchasesTable', () => {
  it('round-trips large Ethereum-sized amounts and proof payloads', async () => {
    const db = await createTestDb();
    const purchase = {
      walletAddress: '0x1234567890123456789012345678901234567890',
      txHash: '0xtransaction',
      blockNumber: 999,
      blockHash: '0xblock',
      transactionIndex: 5,
      receiptRoot: '0xreceipts',
      ethereumTimestamp: new Date('2026-04-06T12:00:00Z'),
      poolAddress: '0xpool',
      poolFee: 500,
      ethereumArgonAmount: 12_345_678_901_234_567_890n,
      costBasisUsdc: 9_876_543_210_123_456_789n,
      costBasisMicrogons: 9_876_543_210_123_456_789n,
      effectiveBuyPriceMicrogons: 999_000_000_000_000_000n,
      uniswapPriceMicrogons: 998_000_000_000_000_000n,
      argonBlockNumber: 321,
      argonBlockHash: '0xargon',
      argonOraclePriceMicrogons: 1_000_000_000_000_000_000n,
      argonOracleTargetPriceMicrogons: 1_000_000_000_000_000_000n,
      proofStatus: StableSwapProofStatus.Pending,
      proofPayload: {
        txHash: '0xtransaction',
        keyRlp: '0x05',
        proof: ['0x01', '0x02'],
      },
      proofError: undefined,
    };
    const inserted = await db.stableSwapPurchasesTable.upsert(purchase);

    expect(inserted?.ethereumArgonAmount).toBe(12_345_678_901_234_567_890n);
    expect(inserted?.costBasisUsdc).toBe(9_876_543_210_123_456_789n);
    expect(inserted?.costBasisMicrogons).toBe(9_876_543_210_123_456_789n);

    const records = await db.stableSwapPurchasesTable.fetchByWallet('0x1234567890123456789012345678901234567890');
    expect(records).toHaveLength(1);
    expect(records[0].ethereumArgonAmount).toBe(12_345_678_901_234_567_890n);
    expect(records[0].costBasisUsdc).toBe(9_876_543_210_123_456_789n);
    expect(records[0].costBasisMicrogons).toBe(9_876_543_210_123_456_789n);
    expect(records[0].proofPayload).toEqual({
      txHash: '0xtransaction',
      keyRlp: '0x05',
      proof: ['0x01', '0x02'],
    });

    await db.stableSwapPurchasesTable.updateProof('0x1234567890123456789012345678901234567890', '0xtransaction', {
      proofStatus: StableSwapProofStatus.Ready,
      proofPayload: {
        txHash: '0xtransaction',
        keyRlp: '0x05',
        proof: ['0x03'],
      },
    });

    const updated = await db.stableSwapPurchasesTable.fetchByWallet('0x1234567890123456789012345678901234567890');
    expect(updated[0].proofStatus).toBe(StableSwapProofStatus.Ready);
    expect(updated[0].proofPayload).toEqual({
      txHash: '0xtransaction',
      keyRlp: '0x05',
      proof: ['0x03'],
    });

    await db.stableSwapPurchasesTable.upsert({
      ...purchase,
      costBasisMicrogons: 8_765_432_101_234_567_890n,
    });

    const refreshed = await db.stableSwapPurchasesTable.fetchByWallet('0x1234567890123456789012345678901234567890');
    expect(refreshed[0].costBasisMicrogons).toBe(8_765_432_101_234_567_890n);
    expect(refreshed[0].proofStatus).toBe(StableSwapProofStatus.Ready);
    expect(refreshed[0].proofPayload).toEqual({
      txHash: '0xtransaction',
      keyRlp: '0x05',
      proof: ['0x03'],
    });
  });

  it('does not restore invalidated purchase basis on later syncs', async () => {
    const db = await createTestDb();
    const walletAddress = '0x1234567890123456789012345678901234567890';

    await db.stableSwapSyncStateTable.upsert({
      walletAddress,
      startBlockNumber: 100,
      lastScannedBlockNumber: 100,
      isPurchaseBasisIntact: true,
    });
    const invalidated = await db.stableSwapSyncStateTable.upsert({
      walletAddress,
      startBlockNumber: 100,
      lastScannedBlockNumber: 110,
      isPurchaseBasisIntact: false,
    });
    const laterSync = await db.stableSwapSyncStateTable.upsert({
      walletAddress,
      startBlockNumber: 100,
      lastScannedBlockNumber: 120,
      isPurchaseBasisIntact: true,
    });

    expect(invalidated?.isPurchaseBasisIntact).toBe(false);
    expect(laterSync?.isPurchaseBasisIntact).toBe(false);
  });
});
