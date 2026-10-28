import { runtimeClient, type BitcoinLocksLocksByIdResult } from '@argonprotocol/runtime-client';
import { Vault, type BlockWatch, type ArgonClient, type TxSigningAccount, type Vaults } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { BitcoinFissions } from '../lib/BitcoinFissions.ts';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { BitcoinLiquidCreate, BitcoinLiquidCreateStateChangedError } from '../lib/txs/BitcoinLiquid.create.ts';
import type { BitcoinLockResecuritize } from '../lib/txs/BitcoinLock.resecuritize.ts';

describe('Liquid Bitcoin rate freshness', () => {
  let operation: BitcoinLiquidCreate;
  let client: ArgonClient;
  let currentTick: number;
  let priceIndexTick: number;
  let rateHistory: [bigint, bigint][];
  const guaranteeRate = 120_000_000_000n;
  const currentRate = 110_000_000_000n;
  const ownerAccount = 'synthetic-liquid-owner';
  const txSigner = { address: ownerAccount } as TxSigningAccount;
  const lock = { lockId: 7 } as IBitcoinLockRecord;

  beforeEach(() => {
    currentTick = 100;
    priceIndexTick = 100;
    rateHistory = [
      [80n, guaranteeRate],
      [90n, 180_000_000_000n],
      [100n, currentRate],
    ];
    const runtimeLock = {
      vaultId: 1,
      securitizationBasis: { satoshis: 1_000n, microgonsAtTargetPerBtc: guaranteeRate },
      securitizationCoverageMicrogons: 1_200_000n,
      securitizationTick: 70,
      fundedSatoshis: 2_000n,
      fundingUtxos: [],
      fissionedSatoshis: 900n,
      ownerAccount,
      securitizationRatio: new BigNumber(1),
      securityFees: 0n,
      couponPaidFees: 0n,
      vaultPubkey: '0x02',
      vaultClaimPubkey: '0x03',
      ownerPubkey: '0x02',
      vaultXpubSources: ['0x01020304', 1, 2],
      vaultClaimHeight: 10_000,
      openClaimHeight: 10_100,
      createdAtHeight: 1,
      securitizationHoldExpirationBitcoinHeight: 10,
      utxoScriptPubkey: { type: 'P2WSH', value: { wscriptHash: '0x' + '00'.repeat(32) } },
      isFlexible: false,
      fundHoldExtensions: {},
      createdAtArgonBlock: 1,
    } satisfies NonNullable<BitcoinLocksLocksByIdResult>;
    const registry = getOfflineRegistry();
    const snapshot = {
      registry,
      query: {
        ticks: { currentTick: async () => currentTick },
        priceIndex: {
          current: async () => ({
            btcUsdPrice: new BigNumber(110_000),
            argonUsdPrice: new BigNumber(1),
            argonUsdTargetPrice: new BigNumber(1),
            tick: priceIndexTick,
          }),
        },
        bitcoinLocks: {
          locksById: { multi: async () => [runtimeLock] },
          lockReleaseRequestsById: async () => null,
          microgonPerBtcHistory: async () => rateHistory,
        },
        bitcoinUtxos: { confirmedBitcoinBlockTip: async () => ({ blockHeight: 100 }) },
        bitcoinFissions: {
          nextFissionIdByOwner: async () => 1,
          fissionByOwnerAndId: {
            entries: async () => [
              [
                { args: [ownerAccount, 0] },
                {
                  liquidId: 0,
                  lockId: 7,
                  satoshis: 900n,
                  microgonsAtTargetPerBtc: guaranteeRate,
                  liquidityPromised: 1_080_000n,
                  createdAtArgonBlock: 1,
                  ratchetNumber: 0,
                  lastRatchetTick: 70,
                  lastUpdatedArgonBlock: 1,
                },
              ],
            ],
          },
        },
      },
    };
    client = runtimeClient({
      query: {},
      rpc: { chain: { getFinalizedHead: async () => ({ toHex: () => '0x01' }) } },
      at: async () => snapshot,
    }) as unknown as ArgonClient;

    // Only the external vault read is replaced; coverage, collateral and rate selection stay real.
    vi.spyOn(Vault, 'get').mockResolvedValue(
      Object.assign(Object.create(Vault.prototype) as Vault, {
        vaultId: 1,
        operatorAccountId: 'synthetic-vault-operator',
        securitization: 2_400_000n,
        securitizationLocked: 1_200_000n,
        flexibleSecuritizationLocked: 0n,
        reservedSecuritizationSpace: 0n,
        securitizationRatio: new BigNumber(1),
        terms: { bitcoinBaseFee: 0n, bitcoinAnnualPercentRate: new BigNumber(0.01) },
      }),
    );
    const blockWatch = {
      getLatestFinalizedSnapshot: async () => ({
        block: { blockHash: `0x${'01'.repeat(32)}` },
        api: runtimeClient(snapshot),
      }),
    } as unknown as BlockWatch;
    operation = new BitcoinLiquidCreate(
      { ownerAccount } as BitcoinFissions,
      {} as TransactionTracker,
      {} as BitcoinLocks,
      { vaultsById: {}, operatorNamesByVaultId: { 1: 'Synthetic Vault' } } as unknown as Vaults,
      {} as BitcoinLockResecuritize,
      {} as UpstreamOperatorClient,
      blockWatch,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('includes a 20-tick-old guarantee rate and excludes it at 21 ticks from Max and replacement', async () => {
    const retained = { allocations: [{ lock, satoshis: 100n }], txSigner, client };
    const growth = { allocations: [{ lock, satoshis: 500n }], txSigner, client };

    expect((await operation.preview(retained)).maximumSatoshisByLockId[7]).toBe(1_100n);
    expect((await operation.preview(growth)).microgonsAtTargetPerBtc).toBe(currentRate);

    currentTick = 101;
    expect((await operation.preview(retained)).maximumSatoshisByLockId[7]).toBe(433n);
    await expect(operation.preview(growth)).rejects.toMatchObject({
      maximumSatoshisByLockId: { 7: 433n },
    });

    currentTick = priceIndexTick = 111;
    rateHistory = [[111n, currentRate]];
    await expect(operation.preview(growth)).rejects.toThrow(
      'Synthetic Vault: Existing Liquids need a Bitcoin price that is no longer available.',
    );
  });

  it('uses a fresh current index without changing an unchanged rate’s historical tick', async () => {
    rateHistory = [[100n, currentRate]];
    currentTick = 120;
    priceIndexTick = 120;
    const input = { allocations: [{ lock, satoshis: 100n }], txSigner, client };
    expect((await operation.preview(input)).liquidityMicrogons).toBe(110_000n);

    currentTick = 121;
    priceIndexTick = 121;
    expect(await operation.preview(input)).toMatchObject({
      liquidityMicrogons: 110_000n,
      microgonsAtTargetPerBtc: currentRate,
      microgonsAtTargetPerBtcTick: 100,
    });

    // An old index cannot keep an old rate eligible merely because their values match.
    priceIndexTick = 100;
    await expect(operation.preview(input)).rejects.toThrow(BitcoinLiquidCreateStateChangedError);
    await expect(operation.preview(input)).rejects.toThrow('Wait for a fresh Bitcoin price and retry.');
    await expect(operation.prepare(input)).rejects.toThrow('Wait for a fresh Bitcoin price and retry.');

    priceIndexTick = 121;
    expect((await operation.preview(input)).liquidityMicrogons).toBe(110_000n);
  });
});
