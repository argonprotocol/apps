import { BitcoinFission, SATOSHIS_PER_BITCOIN } from '@argonprotocol/apps-core';
import { PriceIndex } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { describe, expect, it } from 'vitest';

import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';

describe('Bitcoin Liquid structure', () => {
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
          utxoId: 101,
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
          utxoId: 202,
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
        utxoId: 101,
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
        utxoId: 202,
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
        utxoId: 101,
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
        utxoId: 202,
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
      queueIndex: 1,
      fissionId: 1,
      utxoId: 101,
      ownerAccount: 'owner-account',
      remainingAmount: 10n,
      maxAmountPerFrame: 10n,
    });

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

  it('reports the total close cost from durable close history', () => {
    const closedBlockTime = new Date('2026-08-08T16:00:00Z');
    const fissions = [
      new BitcoinFission({
        ownerAccount: 'owner-account',
        fissionId: 1,
        liquidId: 10,
        utxoId: 101,
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
        utxoId: 202,
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

    const liquid = BitcoinLiquid.create({ liquidId: 10, fissions });

    expect(liquid.isClosed).toBe(true);
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
      utxoId: 101,
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
