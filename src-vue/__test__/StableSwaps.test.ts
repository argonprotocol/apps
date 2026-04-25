import { describe, expect, it } from 'vitest';
import { buildStableSwapUniswapUrl, hydrateStableSwapWallet } from '../lib/StableSwaps.ts';
import { StableSwapProofStatus, type IStableSwapPurchaseRecord } from '../lib/db/StableSwapPurchasesTable.ts';
import { type IStableSwapSyncStateRecord } from '../lib/db/StableSwapSyncStateTable.ts';

const NOW = new Date('2026-04-06T12:00:00Z');

function createSyncState(overrides: Partial<IStableSwapSyncStateRecord> = {}): IStableSwapSyncStateRecord {
  return {
    walletAddress: overrides.walletAddress ?? '0x1234567890123456789012345678901234567890',
    startBlockNumber: overrides.startBlockNumber ?? 101,
    lastScannedBlockNumber: overrides.lastScannedBlockNumber ?? 101,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function createPurchase(overrides: Partial<IStableSwapPurchaseRecord> = {}): IStableSwapPurchaseRecord {
  return {
    id: overrides.id ?? 1,
    walletAddress: overrides.walletAddress ?? '0x1234567890123456789012345678901234567890',
    txHash: overrides.txHash ?? '0xabc',
    blockNumber: overrides.blockNumber ?? 15,
    blockHash: overrides.blockHash ?? '0xblock',
    transactionIndex: overrides.transactionIndex ?? 2,
    receiptRoot: overrides.receiptRoot ?? '0xreceipts',
    ethereumTimestamp: overrides.ethereumTimestamp ?? NOW,
    poolAddress: overrides.poolAddress ?? '0xpool',
    poolFee: overrides.poolFee ?? 500,
    ethereumArgonAmount: overrides.ethereumArgonAmount ?? 1_000_000_000_000_000_000n,
    costBasisUsdc: overrides.costBasisUsdc ?? 970_000n,
    costBasisMicrogons: overrides.costBasisMicrogons ?? 970_000n,
    effectiveBuyPriceMicrogons: overrides.effectiveBuyPriceMicrogons ?? 970_000n,
    uniswapPriceMicrogons: overrides.uniswapPriceMicrogons ?? 980_000n,
    argonBlockNumber: overrides.argonBlockNumber ?? 77,
    argonBlockHash: overrides.argonBlockHash ?? '0xargon',
    argonOraclePriceMicrogons: overrides.argonOraclePriceMicrogons ?? 1_000_000n,
    argonOracleTargetPriceMicrogons: overrides.argonOracleTargetPriceMicrogons ?? 1_000_000n,
    proofStatus: overrides.proofStatus ?? StableSwapProofStatus.Pending,
    proofPayload: overrides.proofPayload,
    proofError: overrides.proofError,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

describe('StableSwaps', () => {
  it('hydrates wallet summary and per-purchase P/L from the current market price', () => {
    const syncState = createSyncState();
    const purchases = [
      createPurchase(),
      createPurchase({
        id: 2,
        txHash: '0xdef',
        ethereumArgonAmount: 2_000_000_000_000_000_000n,
        costBasisUsdc: 1_900_000n,
        costBasisMicrogons: 1_900_000n,
        effectiveBuyPriceMicrogons: 950_000n,
      }),
    ];

    const wallet = hydrateStableSwapWallet(syncState.walletAddress, purchases, 1_000_000n, syncState)!;

    expect(wallet.summary.capitalAppliedMicrogons).toBe(2_870_000n);
    expect(wallet.summary.currentValueMicrogons).toBe(3_000_000n);
    expect(wallet.summary.currentProfitMicrogons).toBe(130_000n);
    expect(wallet.summary.returnPct).toBeCloseTo(4.53, 2);
    expect(wallet.purchases[0].currentProfitMicrogons).toBe(30_000n);
    expect(wallet.purchases[1].currentProfitMicrogons).toBe(100_000n);
  });

  it('builds a Uniswap exact-output link with Argon prefilled and no input token override', () => {
    const url = buildStableSwapUniswapUrl(12_340_000_000_000_000_000n)!;

    expect(url).toContain('https://app.uniswap.org/#/swap?');
    expect(url).toContain('chain=mainnet');
    expect(url).toContain('exactField=output');
    expect(url).toContain('outputCurrency=0x6A9143639D8b70D50b031fFaD55d4CC65EA55155');
    expect(url).toContain('exactAmount=12.34');
    expect(url).not.toContain('inputCurrency=');
  });
});
