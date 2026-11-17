import { BitcoinFission, SATOSHIS_PER_BITCOIN } from '@argonprotocol/apps-core';
import { PriceIndex } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { describe, expect, it, vi } from 'vitest';

import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';
import { createBitcoinLockConfig, createLock, createStore, historyBlock } from './helpers/bitcoin.ts';
import { BitcoinLockStatus } from '../interfaces/IBitcoinLockRecord.ts';
import { createTestDb } from './helpers/db.ts';
import { getStabilizerBuyReturnedSatoshis } from '../lib/financials/StabilizerBuys.ts';
import { StabilizerBuyStatus } from '../interfaces/IStabilizerBuyPurchase.ts';

describe('Bitcoin Liquid structure', () => {
  it('requires every active backing lock to outlast repayment, without expired historical fissions blocking it', () => {
    const config = createBitcoinLockConfig({ lockReleaseCosignDeadlineFrames: 10 });
    const locks = createStore();
    vi.spyOn(locks, 'config', 'get').mockReturnValue(config);
    locks.data.readiness = 'ready';
    locks.data.oracleBitcoinBlockHeight = 1_000;
    for (const lockId of [101, 202]) {
      const lock = createLock({
        uuid: `synthetic-lock-${lockId}`,
        utxoId: lockId,
        status: BitcoinLockStatus.LockFunded,
        createdAt: '2026-11-01T00:00:00Z',
      });
      lock.scriptDetails!.vaultClaimHeight = lockId === 101 ? 10_000 : 5_000;
      locks.data.locksByLockId[lockId] = lock;
    }
    const fissions = [101, 202].map(
      (lockId, index) =>
        new BitcoinFission({
          ownerAccount: 'synthetic-owner',
          fissionId: index + 1,
          liquidId: 10,
          lockId,
          satoshis: 50_000_000n,
          microgonsAtTargetPerBtc: 100n,
          liquidityPromised: 50n,
          createdAtArgonBlock: 100,
          ratchetNumber: 0,
          lastUpdatedArgonBlock: 100,
        }),
    );
    const liquid = BitcoinLiquid.create({ liquidId: 10, fissions });

    expect(liquid.hasRepaymentWindow(locks, 30)).toBe(false);
    const secondLock = locks.data.locksByLockId[202];
    delete locks.data.locksByLockId[202];
    expect(liquid.hasRepaymentWindow(locks, 30)).toBeUndefined();
    locks.data.locksByLockId[202] = secondLock;
    secondLock.scriptDetails!.vaultClaimHeight = 10_000;
    expect(liquid.hasRepaymentWindow(locks, 30)).toBe(true);

    secondLock.scriptDetails!.vaultClaimHeight = 5_000;
    fissions[1].satoshis = 0n;
    expect(liquid.hasRepaymentWindow(locks, 30)).toBe(true);
    fissions[1].satoshis = 50_000_000n;
    fissions[1].closedAtArgonBlock = 200;
    expect(liquid.hasRepaymentWindow(locks, 30)).toBe(true);
  });

  it('projects the next payout and remaining daily payout count from current pending mints', () => {
    const first = new BitcoinFission({
      ownerAccount: 'owner-account',
      fissionId: 1,
      liquidId: 10,
      lockId: 101,
      satoshis: 60_000_000n,
      microgonsAtTargetPerBtc: 100n,
      liquidityPromised: 25n,
      createdAtArgonBlock: 100,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: 100,
    });
    first.pendingMints.push({
      queueIndex: 1n,
      fissionId: 1,
      lockId: 101,
      ownerAccount: 'owner-account',
      remainingAmount: 25n,
      maxAmountPerFrame: 10n,
    });
    const second = new BitcoinFission({
      ownerAccount: 'owner-account',
      fissionId: 2,
      liquidId: 10,
      lockId: 202,
      satoshis: 40_000_000n,
      microgonsAtTargetPerBtc: 100n,
      liquidityPromised: 9n,
      createdAtArgonBlock: 100,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: 100,
    });
    second.pendingMints.push({
      queueIndex: 2n,
      fissionId: 2,
      lockId: 202,
      ownerAccount: 'owner-account',
      remainingAmount: 9n,
      maxAmountPerFrame: 4n,
    });
    first.closedAtArgonBlock = 200;

    const liquid = BitcoinLiquid.create({ liquidId: 10, fissions: [first, second] });

    // Closing collateral does not cancel the remaining mint entitlement.
    expect(liquid.satoshis).toBe(40_000_000n);
    expect(liquid.liquidityPromised).toBe(9n);
    expect(liquid.pendingLiquidity).toBe(34n);
    expect(liquid.receivedLiquidity).toBe(0n);
    expect(liquid.expectedMintPerFrame).toBe(14n);
    expect(liquid.estimatedMintFramesRemaining).toBe(3);

    first.pendingMints[0].remainingAmount = 15n;
    expect(liquid.pendingLiquidity).toBe(24n);
    expect(liquid.receivedLiquidity).toBe(10n);
  });

  it('uses the runtime Fission redemption calculation for the current repayment amount', () => {
    const priceIndex = new PriceIndex();
    priceIndex.btcUsdPrice = new BigNumber(100);
    priceIndex.argonUsdPrice = new BigNumber(1);
    priceIndex.argonUsdTargetPrice = new BigNumber(1);
    const liquid = BitcoinLiquid.create({
      liquidId: 10,
      fissions: [
        new BitcoinFission({
          ownerAccount: 'owner-account',
          fissionId: 1,
          liquidId: 10,
          lockId: 101,
          satoshis: 60_000_000n,
          microgonsAtTargetPerBtc: 100n,
          liquidityPromised: 60n,
          createdAtArgonBlock: 100,
          ratchetNumber: 0,
          lastUpdatedArgonBlock: 100,
        }),
        new BitcoinFission({
          ownerAccount: 'owner-account',
          fissionId: 2,
          liquidId: 10,
          lockId: 202,
          satoshis: 40_000_000n,
          microgonsAtTargetPerBtc: 100n,
          liquidityPromised: 40n,
          createdAtArgonBlock: 100,
          ratchetNumber: 0,
          lastUpdatedArgonBlock: 100,
        }),
      ],
    });

    expect(liquid.getRepaymentAmount(priceIndex)).toBe(100n);
  });

  it('groups an atomic multi-Fission ratchet and preserves both upward and downward outcomes', () => {
    const creationTime = new Date('2026-04-03T15:00:00Z');
    const ratchetTime = new Date('2026-07-18T11:30:00Z');
    const fissions = [
      new BitcoinFission({
        ownerAccount: 'owner-account',
        fissionId: 1,
        liquidId: 10,
        lockId: 101,
        satoshis: SATOSHIS_PER_BITCOIN,
        microgonsAtTargetPerBtc: 130n,
        liquidityPromised: 130n,
        createdAtArgonBlock: 100,
        ratchetNumber: 1,
        lastUpdatedArgonBlock: 200,
        ratchets: [
          {
            source: 'fission',
            sourceRatchetIndex: 0,
            ratchetNumber: 0,
            microgonsAtTargetPerBtc: 100n,
            liquidityPromised: 100n,
            amountMinted: 100n,
            amountBurned: 0n,
            mintPending: 0n,
            txFee: 5n,
            blockNumber: 100,
            blockTime: creationTime,
            extrinsicIndex: 2,
          },
          {
            source: 'fission',
            sourceRatchetIndex: 1,
            ratchetNumber: 1,
            microgonsAtTargetPerBtc: 130n,
            liquidityPromised: 130n,
            amountMinted: 30n,
            amountBurned: 0n,
            mintPending: 10n,
            txFee: 7n,
            blockNumber: 200,
            blockTime: ratchetTime,
            extrinsicIndex: 4,
          },
        ],
      }),
      new BitcoinFission({
        ownerAccount: 'owner-account',
        fissionId: 2,
        liquidId: 10,
        lockId: 202,
        satoshis: SATOSHIS_PER_BITCOIN,
        microgonsAtTargetPerBtc: 130n,
        liquidityPromised: 130n,
        createdAtArgonBlock: 100,
        ratchetNumber: 1,
        lastUpdatedArgonBlock: 200,
        ratchets: [
          {
            source: 'fission',
            sourceRatchetIndex: 0,
            ratchetNumber: 0,
            microgonsAtTargetPerBtc: 160n,
            liquidityPromised: 160n,
            amountMinted: 160n,
            amountBurned: 0n,
            mintPending: 0n,
            txFee: 5n,
            blockNumber: 100,
            blockTime: creationTime,
            extrinsicIndex: 2,
          },
          {
            source: 'fission',
            sourceRatchetIndex: 1,
            ratchetNumber: 1,
            microgonsAtTargetPerBtc: 130n,
            liquidityPromised: 130n,
            amountMinted: 130n,
            amountBurned: 130n,
            mintPending: 130n,
            txFee: 7n,
            blockNumber: 200,
            blockTime: ratchetTime,
            extrinsicIndex: 4,
          },
        ],
      }),
    ];
    const terms: IBitcoinSecuritizationTerm[] = [
      {
        lockId: 101,
        termIndex: 1,
        origin: 'resecuritized',
        startTick: 20,
        startBlockNumber: 200,
        startExtrinsicIndex: 4,
        securitizedSatoshis: SATOSHIS_PER_BITCOIN,
        securitizationCoverageMicrogons: 130n,
        cumulativeNetSecurityFee: 4n,
        addedNetSecurityFee: 4n,
      },
      {
        lockId: 202,
        termIndex: 1,
        origin: 'resecuritized',
        startTick: 20,
        startBlockNumber: 200,
        startExtrinsicIndex: 4,
        securitizedSatoshis: SATOSHIS_PER_BITCOIN,
        securitizationCoverageMicrogons: 130n,
        cumulativeNetSecurityFee: 6n,
        addedNetSecurityFee: 6n,
      },
    ];
    fissions[0].pendingMints.push({
      queueIndex: 1n,
      fissionId: 1,
      lockId: 101,
      ownerAccount: 'owner-account',
      remainingAmount: 10n,
      maxAmountPerFrame: 10n,
    });
    for (const fission of fissions) {
      fission.origin = 'created';
      fission.feeHistoryCompleteThroughBlock = 200;
      fission.createdAt = creationTime;
      fission.updatedAt = ratchetTime;
    }

    const liquid = BitcoinLiquid.create({ liquidId: 10, fissions, terms });

    expect(liquid).toBeInstanceOf(BitcoinLiquid);
    expect(liquid.satoshis).toBe(2n * SATOSHIS_PER_BITCOIN);
    expect(liquid.liquidityPromised).toBe(260n);
    expect(liquid.pendingLiquidity).toBe(10n);
    expect(liquid.receivedLiquidity).toBe(250n);
    expect(liquid.getRatchetStatus({ microgonsAtTargetPerBtc: 140n, minimumRatchetPercent: 5n })).toEqual({
      percent: 7.69,
      isAvailable: true,
    });
    expect(liquid.history).toHaveLength(2);
    expect(liquid.history[0]).toMatchObject({
      kind: 'created',
      liabilityBefore: 0n,
      liabilityAfter: 260n,
      liquidityUnlocked: 260n,
      liquidityPending: 0n,
      pocketed: 0n,
      recycled: 0n,
      transactionFee: 5n,
      securityFee: 0n,
      actionFees: 5n,
      affectedFissionCount: 2,
    });
    expect(liquid.history[1]).toMatchObject({
      kind: 'ratchet',
      previousMicrogonsAtTargetPerBtc: 130n,
      microgonsAtTargetPerBtc: 130n,
      liabilityBefore: 260n,
      liabilityAfter: 260n,
      liquidityUnlocked: 30n,
      liquidityPending: 10n,
      pocketed: 30n,
      recycled: 130n,
      mintPending: 140n,
      transactionFee: 7n,
      securityFee: 10n,
      actionFees: 17n,
      affectedFissionCount: 2,
    });
    expect(liquid.historyTransactionFees).toBe(12n);
  });

  it('uses the remaining allocation for a ratchet after a partial repayment', () => {
    const fission = new BitcoinFission({
      ownerAccount: 'owner-account',
      fissionId: 1,
      liquidId: 10,
      lockId: 101,
      initialSatoshis: 100_000_000n,
      satoshis: 40_000_000n,
      microgonsAtTargetPerBtc: 150n,
      liquidityPromised: 60n,
      ratchetNumber: 1,
      createdAtArgonBlock: 100,
      lastUpdatedArgonBlock: 200,
      repayments: [
        {
          satoshis: 60_000_000n,
          liquidityRepaid: 60n,
          redemptionAmount: 60n,
          blockNumber: 150,
          blockHash: `0x${'15'.repeat(32)}`,
          eventIndex: 0,
          tick: 150,
          blockTime: new Date('2026-01-02T00:00:00Z'),
        },
      ],
      ratchets: [
        {
          source: 'fission',
          sourceRatchetIndex: 0,
          ratchetNumber: 0,
          microgonsAtTargetPerBtc: 100n,
          liquidityPromised: 100n,
          amountMinted: 100n,
          amountBurned: 0n,
          mintPending: 0n,
          blockNumber: 100,
        },
        {
          source: 'fission',
          sourceRatchetIndex: 1,
          ratchetNumber: 1,
          microgonsAtTargetPerBtc: 150n,
          liquidityPromised: 60n,
          amountMinted: 20n,
          amountBurned: 0n,
          mintPending: 0n,
          blockNumber: 200,
        },
      ],
    });
    const liquid = BitcoinLiquid.create({ liquidId: 10, fissions: [fission] });

    expect(liquid.history.reduce((sum, entry) => sum + entry.liquidityUnlocked, 0n)).toBe(120n);
    expect(liquid.getRepaymentState(150)).toEqual({ liabilityBefore: 100n, liquidityRepaid: 60n, liabilityAfter: 40n });
    expect(liquid.getRepaymentState(151)).toEqual({ liabilityBefore: 40n, liquidityRepaid: 0n, liabilityAfter: 40n });
    expect(liquid.getRepaymentState(99)).toBeUndefined();
    const repayment = fission.repayments.pop()!;
    expect(liquid.getRepaymentState(150)).toBeUndefined();
    fission.repayments.push(repayment);
    const ratchet = fission.ratchets.pop()!;
    expect(liquid.getRepaymentState(150)).toBeUndefined();
    fission.ratchets.push(ratchet);

    // A newer live ratchet does not fill an earlier missed ratchet.
    fission.ratchetNumber = 2;
    ratchet.ratchetNumber = 2;
    ratchet.sourceRatchetIndex = 2;
    expect(liquid.getRepaymentState(150)).toBeUndefined();
    fission.ratchetNumber = 1;
    ratchet.ratchetNumber = 1;
    ratchet.sourceRatchetIndex = 1;

    expect(liquid.history[0]).toMatchObject({
      liabilityBefore: 0n,
      liabilityAfter: 100n,
      affectedSatoshis: 100_000_000n,
    });
    expect(liquid.history[1]).toMatchObject({
      liabilityBefore: 40n,
      liabilityAfter: 60n,
      affectedSatoshis: 40_000_000n,
      liquidityUnlocked: 20n,
    });
  });

  it('excludes a fully repaid allocation from current totals and a later survivor ratchet after reload', async () => {
    const db = await createTestDb();
    const ownerAccount = `0x${'33'.repeat(32)}`;
    const creationBlock = {
      ...historyBlock(100),
      blockNumber: 100,
      blockHash: `0x${'10'.repeat(32)}`,
      blockTime: 1_000,
      tick: 100,
    };
    const closeBlock = {
      ...historyBlock(150),
      blockNumber: 150,
      blockHash: `0x${'15'.repeat(32)}`,
      blockTime: 2_000,
      tick: 150,
    };
    const ratchetBlock = {
      ...historyBlock(200),
      blockNumber: 200,
      blockHash: `0x${'20'.repeat(32)}`,
      blockTime: 3_000,
      tick: 200,
    };
    try {
      const records = [60_000_000n, 40_000_000n].map((satoshis, index) =>
        BitcoinFission.createRecordFromEvent({
          block: creationBlock,
          event: {
            section: 'bitcoinFissions',
            method: 'FissionCreated',
            data: {
              accountId: ownerAccount,
              fissionId: index + 1,
              liquidId: 10,
              lockId: index + 101,
              satoshis,
              microgonsAtTargetPerBtc: 100n,
              liquidityPromised: satoshis / 1_000_000n,
            },
          },
        }),
      );
      records[0] = BitcoinFission.applyEventToRecord({
        record: records[0],
        block: closeBlock,
        event: {
          section: 'bitcoinFissions',
          method: 'FissionClosed',
          data: { accountId: ownerAccount, fissionId: 1, redemptionAmount: 55n },
        },
        eventIndex: 0,
      });
      await db.bitcoinFissionsTable.replaceRecords(records);

      let fissions = (await db.bitcoinFissionsTable.fetchAll(ownerAccount)).map(record => new BitcoinFission(record));
      let liquid = BitcoinLiquid.create({ liquidId: 10, fissions });
      expect(liquid.satoshis).toBe(40_000_000n);
      expect(liquid.liquidityPromised).toBe(40n);
      expect(liquid.getRepaymentState(150)).toEqual({
        liabilityBefore: 100n,
        liquidityRepaid: 60n,
        liabilityAfter: 40n,
      });
      fissions[0].closeReason = 'lock-spent';
      expect(liquid.getRepaymentState(150)).toEqual({ liabilityBefore: 40n, liquidityRepaid: 0n, liabilityAfter: 40n });
      fissions[0].closeReason = 'closed';
      expect(liquid.receivedLiquidity).toBe(100n);
      expect(
        getStabilizerBuyReturnedSatoshis(
          {
            id: 'synthetic-full-fission-paydown',
            ownerAccount,
            status: StabilizerBuyStatus.Complete,
            createdAt: new Date(0),
            updatedAt: new Date(0),
            argonFees: [],
            liquidRepaymentEvent: {
              gatewayActivityNonce: 1n,
              liquidId: 10,
              microgonsBurned: 55n,
              blockNumber: closeBlock.blockNumber,
              blockHash: closeBlock.blockHash,
              blockTime: closeBlock.blockTime,
              eventIndex: 1,
            },
          },
          liquid,
        ),
      ).toBe(60_000_000n);

      const survivor = BitcoinFission.applyEventToRecord({
        record: records[1],
        block: ratchetBlock,
        event: {
          section: 'bitcoinFissions',
          method: 'FissionRatcheted',
          data: {
            accountId: ownerAccount,
            fissionId: 2,
            ratchetNumber: 1,
            microgonsAtTargetPerBtc: 150n,
            liquidityPromised: 60n,
            amountMinted: 20n,
            amountBurned: 0n,
          },
        },
        eventIndex: 0,
      });
      await db.bitcoinFissionsTable.replaceRecord(survivor);
      fissions = (await db.bitcoinFissionsTable.fetchAll(ownerAccount)).map(record => new BitcoinFission(record));
      liquid = BitcoinLiquid.create({ liquidId: 10, fissions });
      const priceIndex = new PriceIndex();
      priceIndex.btcUsdPrice = new BigNumber(100);
      priceIndex.argonUsdPrice = new BigNumber(1);
      priceIndex.argonUsdTargetPrice = new BigNumber(1);

      expect(liquid.satoshis).toBe(40_000_000n);
      expect(liquid.liquidityPromised).toBe(60n);
      expect(liquid.getRepaymentAmount(priceIndex)).toBe(60n);
      expect(liquid.getRatchetStatus({ microgonsAtTargetPerBtc: 200n, minimumRatchetPercent: 1n })).toEqual({
        percent: 33.33,
        isAvailable: true,
      });
      expect(liquid.history.at(-1)).toMatchObject({
        liabilityBefore: 40n,
        liabilityAfter: 60n,
        liquidityUnlocked: 20n,
        affectedSatoshis: 40_000_000n,
      });
      // Archived collateral remains available to history; it is not an outstanding balance.
      expect(fissions[0].satoshis).toBe(60_000_000n);
      expect(liquid.originalSatoshis).toBe(100_000_000n);
    } finally {
      await db.close();
    }
  });

  it.each([5, 9])('orders same-block closures around ratchet extrinsic 5 (last closure: %s)', lastClosure => {
    const fissions = [60_000_000n, 10_000_000n, 30_000_000n].map(
      (satoshis, index) =>
        new BitcoinFission({
          ownerAccount: 'synthetic-owner',
          fissionId: index + 1,
          liquidId: 10,
          lockId: index + 101,
          initialSatoshis: satoshis,
          satoshis,
          microgonsAtTargetPerBtc: 100n,
          liquidityPromised: satoshis / 1_000_000n,
          ratchetNumber: 0,
          ratchets: [
            {
              source: 'fission',
              sourceRatchetIndex: 0,
              ratchetNumber: 0,
              microgonsAtTargetPerBtc: 100n,
              liquidityPromised: satoshis / 1_000_000n,
              amountMinted: satoshis / 1_000_000n,
              amountBurned: 0n,
              mintPending: 0n,
              blockNumber: 100,
              extrinsicIndex: 1,
            },
          ],
        }),
    );
    fissions[0].closedAtArgonBlock = 200;
    fissions[0].closedExtrinsicIndex = lastClosure;
    fissions[1].closedAtArgonBlock = 200;
    fissions[1].closedExtrinsicIndex = 2;
    fissions[2].ratchets.push({
      source: 'fission',
      sourceRatchetIndex: 1,
      ratchetNumber: 1,
      microgonsAtTargetPerBtc: 200n,
      liquidityPromised: 60n,
      amountMinted: 30n,
      amountBurned: 0n,
      mintPending: 0n,
      blockNumber: 200,
      extrinsicIndex: 5,
    });
    const liquid = BitcoinLiquid.create({ liquidId: 10, fissions });
    // The 10-unit portion closed before this transaction. The 60-unit portion
    // closes either inside this atomic transaction or later in the same block.
    expect(liquid.history.at(-1)).toMatchObject({
      liabilityBefore: 90n,
      liabilityAfter: lastClosure === 5 ? 60n : 120n,
      liquidityUnlocked: 30n,
    });
    expect(liquid.getRepaymentState(201)).toEqual({ liabilityBefore: 60n, liquidityRepaid: 0n, liabilityAfter: 60n });
  });

  it('reports the total close cost from durable close history', () => {
    const closedBlockTime = new Date('2026-08-08T16:00:00Z');
    const fissions = [
      new BitcoinFission({
        ownerAccount: 'owner-account',
        fissionId: 1,
        liquidId: 10,
        lockId: 101,
        satoshis: 60_000_000n,
        microgonsAtTargetPerBtc: 100n,
        liquidityPromised: 60n,
        createdAtArgonBlock: 100,
        ratchetNumber: 0,
        lastUpdatedArgonBlock: 200,
        closedAtArgonBlock: 200,
        closedBlockTime,
        closedExtrinsicIndex: 3,
        closeReason: 'closed',
        redemptionAmount: 55n,
        closeTxFee: 4n,
      }),
      new BitcoinFission({
        ownerAccount: 'owner-account',
        fissionId: 2,
        liquidId: 10,
        lockId: 202,
        satoshis: 40_000_000n,
        microgonsAtTargetPerBtc: 100n,
        liquidityPromised: 40n,
        createdAtArgonBlock: 100,
        ratchetNumber: 0,
        lastUpdatedArgonBlock: 200,
        closedAtArgonBlock: 200,
        closedBlockTime,
        closedExtrinsicIndex: 3,
        closeReason: 'closed',
        redemptionAmount: 35n,
        closeTxFee: 4n,
      }),
    ];
    for (const fission of fissions) {
      fission.origin = 'created';
      fission.feeHistoryCompleteThroughBlock = 200;
      fission.createdAt = closedBlockTime;
      fission.updatedAt = closedBlockTime;
    }

    const liquid = BitcoinLiquid.create({ liquidId: 10, fissions });

    expect(liquid.isClosed).toBe(true);
    expect(liquid.liquidityPromised).toBe(0n);
    expect(liquid.receivedLiquidity).toBe(100n);
    expect(liquid.closedAt).toEqual(closedBlockTime);
    expect(liquid.redemptionAmount).toBe(90n);
    expect(liquid.historyTransactionFees).toBe(0n);
    expect(liquid.closeTransactionFees).toBe(4n);
    expect(liquid.totalCloseCost).toBe(94n);
    expect(liquid.closeHistoryEntry).toMatchObject({
      kind: 'closed',
      blockNumber: 200,
      blockTime: closedBlockTime,
      repaymentAmount: 90n,
      transactionFee: 4n,
      totalCloseCost: 94n,
    });
  });

  it('keeps a history row key when replay later adds its finalized extrinsic index', () => {
    const fission = new BitcoinFission({
      ownerAccount: 'owner-account',
      fissionId: 1,
      liquidId: 10,
      lockId: 101,
      satoshis: SATOSHIS_PER_BITCOIN,
      microgonsAtTargetPerBtc: 100n,
      liquidityPromised: 100n,
      createdAtArgonBlock: 100,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: 100,
      ratchets: [
        {
          source: 'fission',
          sourceRatchetIndex: 0,
          ratchetNumber: 0,
          microgonsAtTargetPerBtc: 100n,
          liquidityPromised: 100n,
          amountMinted: 100n,
          amountBurned: 0n,
          mintPending: 100n,
          blockNumber: 100,
          blockHash: '0x100',
        },
      ],
    });

    const pendingKey = BitcoinLiquid.create({ liquidId: 10, fissions: [fission] }).history[0].key;
    fission.ratchets[0].extrinsicIndex = 2;
    const finalizedKey = BitcoinLiquid.create({ liquidId: 10, fissions: [fission] }).history[0].key;

    expect(finalizedKey).toBe(pendingKey);
  });
});
