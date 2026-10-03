import { runtimeClient } from '@argonprotocol/runtime-client';
import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SKIP_E2E, teardown } from '@argonprotocol/testing';
import {
  BitcoinFission,
  BitcoinLock,
  Currency,
  NetworkConfig,
  SATS_PER_BTC,
  Vault,
  type ArgonClient,
} from '@argonprotocol/apps-core';
import { Keyring, toFixedNumber } from '@argonprotocol/mainchain';
import type { IntegrationNetwork } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import {
  createBitcoinAddress,
  generateBlocks,
  sendBitcoinToAddress,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import {
  getTestMainchainClient,
  submitAndFinalize,
  sudoSubmitAndFinalize,
} from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';

import { BitcoinFissions } from '../lib/BitcoinFissions.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { BitcoinLiquidClose } from '../lib/txs/BitcoinLiquid.close.ts';
import { BitcoinLiquidCreate } from '../lib/txs/BitcoinLiquid.create.ts';
import { BitcoinLiquidRatchet } from '../lib/txs/BitcoinLiquid.ratchet.ts';
import { BitcoinLockResecuritize } from '../lib/txs/BitcoinLock.resecuritize.ts';
import {
  cleanupBitcoinLocksHarness,
  createBitcoinLocksHarness,
  type BitcoinLocksHarness,
} from './helpers/bitcoinLocksHarness.ts';
import { AppVaultOperator } from '../../e2e/actors/AppVaultOperator.ts';
import type { MemoryWalletKeys } from '../lib/MemoryWalletKeys.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

const walletFundingMicrogons = 500_000_000n;

let network: IntegrationNetwork;
let minerAddress: string;
const priceOracle = new Keyring({ type: 'sr25519' }).addFromUri('//Eve//oracle');

describe.skipIf(SKIP_E2E).sequential('Bitcoin Liquids integration', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    network = sharedNetwork;
    minerAddress = createBitcoinAddress();

    const client = await getTestMainchainClient(network.archiveUrl);
    try {
      await waitFor(90_000, 'shared Bitcoin pricing', async () => {
        const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
        const [price, history] = await Promise.all([
          snapshot.query.priceIndex.current(),
          snapshot.query.bitcoinLocks.microgonPerBtcHistory(),
        ]);
        return price?.btcUsdPrice.isGreaterThan(0) && history?.length ? true : undefined;
      });
    } finally {
      await client.disconnect();
    }
  }, 240_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await teardown();
  });

  it('creates one Liquid from a funded Lock through the application operation', async () => {
    const harness = await createHarness();

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 5n;
      const client = await harness.clients.get(false);
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const lock = await createFundedLock(harness, targetLiquidity, { verifyRestoredCreation: true });
      const { createLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();

      const preview = await createLiquid.preview({
        allocations: [{ lock, satoshis: lock.securitizedSatoshis }],
        txSigner,
        client,
      });
      expect(preview.maximumSatoshisByLockId).toEqual({ [lock.lockId!]: lock.securitizedSatoshis });
      expect(preview.liquidityMicrogons).toBeGreaterThan(0n);

      const txInfo = await createLiquid.submit({
        allocations: [{ lock, satoshis: lock.securitizedSatoshis }],
        txSigner,
        client,
      });
      await txInfo.txResult.waitForFinalizedBlock;
      await txInfo.waitForPostProcessing;

      const current = await BitcoinFission.getAllByOwner(client, txSigner.address);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({
        ownerAccount: txSigner.address,
        fissionId: 0,
        liquidId: 0,
        lockId: lock.lockId,
        satoshis: lock.securitizedSatoshis,
      });
      expect(current[0].liquidityPromised).toBeGreaterThan(0n);

      const currentLock = await BitcoinLock.get(client, lock.lockId!);
      expect(currentLock?.fissionedSatoshis).toBe(lock.securitizedSatoshis);
      expect(fissions.getLiquids()).toEqual([
        expect.objectContaining({
          liquidId: 0,
          fissions: [expect.objectContaining({ fissionId: 0, lockId: lock.lockId })],
        }),
      ]);
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  // prettier-ignore
  it.each([false, true])('handles an expired higher Lock price with existing Liquids: %s', { tags: ['exclusive-argon-network'] }, async hasExistingLiquid => {
    const harness = await createHarness();
    const client = await harness.clients.get(false);
    let restorePriceHistory: string | undefined;

    try {
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
      const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 10n);
      const { createLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
      const insuredSatoshis = lock.securitizedSatoshis;

      if (hasExistingLiquid) {
        const firstCreation = await createLiquid.submit({
          allocations: [{ lock, satoshis: insuredSatoshis / 2n }],
          txSigner,
          client,
        });
        await firstCreation.waitForPostProcessing;
      }
      const existingFissions = await BitcoinFission.getAllByOwner(client, txSigner.address);
      const fundingAddress = harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
      sendBitcoinToAddress(fundingAddress, insuredSatoshis);
      generateBlocks(8, minerAddress);
      const fundedLock = await waitFor(90_000, 'additional finalized Lock funding', async () => {
        const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
        const current = await BitcoinLock.get(snapshot, lock.lockId!);
        return current?.fundedSatoshis === insuredSatoshis * 2n ? current : undefined;
      });
      await harness.bitcoinLocks.syncCurrentLocks({ requireComplete: true });

      const eligibleRate = await submitBitcoinPrice(client, { btcUsdPrice: 110_000 });
      const history = await client.raw.query.bitcoinLocks.microgonPerBtcHistory();
      restorePriceHistory = history.toHex();
      const expiredHistory = history.registry.createType(
        history.toRawType(),
        history.filter(([, rate]) => rate.toBigInt() === eligibleRate),
      );
      // Advance the external price-history boundary without waiting thirty minutes.
      await sudoSubmitAndFinalize(
        client,
        client.tx.system.setStorage([
          [client.raw.query.bitcoinLocks.microgonPerBtcHistory.key(), expiredHistory.toHex()],
        ]),
      );
      const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
      expect((await snapshot.query.bitcoinLocks.microgonPerBtcHistory())?.some(([, rate]) => rate === fundedLock.microgonsAtTargetPerBtc)).toBe(false);

      let satoshis = fundedLock.fundedSatoshis - fundedLock.fissionedSatoshis;
      if (hasExistingLiquid) {
        await expect(createLiquid.preview({ allocations: [{ lock, satoshis }], txSigner, client })).rejects.toThrow(
          'Existing Liquids need a Bitcoin price that is no longer available',
        );
        expect(await BitcoinFission.getAllByOwner(client, txSigner.address)).toEqual(existingFissions);
        satoshis = insuredSatoshis - fundedLock.fissionedSatoshis;
      }

      const creation = await createLiquid.submit({ allocations: [{ lock, satoshis }], txSigner, client });
      await creation.waitForPostProcessing;
      const currentLock = await BitcoinLock.get(client, lock.lockId!);
      const currentFissions = await BitcoinFission.getAllByOwner(client, txSigner.address);
      expect(currentLock?.fissionedSatoshis).toBe(hasExistingLiquid ? insuredSatoshis : insuredSatoshis * 2n);
      expect(currentFissions).toHaveLength(hasExistingLiquid ? 2 : 1);
      expect(currentFissions.find(fission => fission.liquidId === creation.tx.metadataJson.liquidId)?.microgonsAtTargetPerBtc).toBe(eligibleRate);
      expect(fissions.getLiquids().some(liquid => liquid.liquidId === creation.tx.metadataJson.liquidId)).toBe(true);
      expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toHaveLength(currentFissions.length);
      if (hasExistingLiquid) {
        expect(currentFissions.find(fission => fission.fissionId === existingFissions[0].fissionId)).toEqual(existingFissions[0]);
        expect(creation.tx.metadataJson.resecuritizations).toEqual([]);
      } else {
        expect(currentLock?.microgonsAtTargetPerBtc).toBe(eligibleRate);
        expect(creation.tx.metadataJson.resecuritizations[0].bitcoin.microgonsAtTargetPerBtc).toBe(eligibleRate);
      }
    } finally {
      if (restorePriceHistory) {
        await sudoSubmitAndFinalize(client, client.tx.system.setStorage([
          [client.raw.query.bitcoinLocks.microgonPerBtcHistory.key(), restorePriceHistory],
        ]));
      }
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  // prettier-ignore
  it('selects an eligible higher rate that preserves curve-adjusted existing Liquid coverage', { tags: ['exclusive-argon-network'] }, async () => {
    const harness = await createHarness();
    const client = await harness.clients.get(false);

    try {
      const currentPrice = await client.raw.query.priceIndex.current();
      const agedPrice = currentPrice.registry.createType(currentPrice.toRawType(), {
        ...currentPrice.toJSON() as object,
        tick: (await client.query.ticks.currentTick()) - 60,
      });
      // Model an older oracle observation so the runtime permits the changed Argon spot price.
      await sudoSubmitAndFinalize(client, client.tx.system.setStorage([
        [client.raw.query.priceIndex.current.key(), agedPrice.toHex()],
      ]));
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000, argonUsdPrice: 0.795 });
      const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 10n);
      const { createLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
      const insuredSatoshis = lock.securitizedSatoshis;
      const firstCreation = await createLiquid.submit({
        allocations: [{ lock, satoshis: insuredSatoshis * 9n / 10n }], txSigner, client,
      });
      await firstCreation.waitForPostProcessing;
      const existingFission = (await BitcoinFission.getAllByOwner(client, txSigner.address))[0];
      sendBitcoinToAddress(harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex), insuredSatoshis);
      generateBlocks(8, minerAddress);
      await waitFor(90_000, 'additional finalized Lock funding', async () => {
        const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
        return (await BitcoinLock.get(snapshot, lock.lockId!))?.fundedSatoshis === insuredSatoshis * 2n;
      });
      await harness.bitcoinLocks.syncCurrentLocks({ requireComplete: true });

      const higherRate = await submitBitcoinPrice(client, { btcUsdPrice: 132_000 });
      const currentRate = await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
      const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
      const priceIndex = await Currency.fetchPriceIndex(snapshot);
      const satoshis = insuredSatoshis / 5n;
      const requiredLiquidity = existingFission.liquidityPromised + BitcoinLock.calculateLiquidityPromised({
        priceIndex, satoshis, microgonsAtTargetPerBtc: currentRate,
      });
      const securitizedSatoshis = existingFission.satoshis + satoshis;
      expect(BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis: securitizedSatoshis, microgonsAtTargetPerBtc: currentRate })).toBeLessThan(requiredLiquidity);
      expect(BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis: securitizedSatoshis, microgonsAtTargetPerBtc: higherRate })).toBeGreaterThanOrEqual(requiredLiquidity);

      const creation = await createLiquid.submit({ allocations: [{ lock, satoshis }], txSigner, client });
      await creation.waitForPostProcessing;
      const currentLock = await BitcoinLock.get(client, lock.lockId!);
      const currentFissions = await BitcoinFission.getAllByOwner(client, txSigner.address);
      expect(currentLock?.microgonsAtTargetPerBtc).toBe(higherRate);
      expect(currentLock?.securitizationCoverageMicrogons).toBeGreaterThanOrEqual(requiredLiquidity);
      expect(currentFissions.find(fission => fission.fissionId === existingFission.fissionId)).toEqual(existingFission);
      expect(currentFissions.find(fission => fission.liquidId === creation.tx.metadataJson.liquidId)?.microgonsAtTargetPerBtc).toBe(currentRate);
      expect(fissions.getLiquids().some(liquid => liquid.liquidId === creation.tx.metadataJson.liquidId)).toBe(true);
      expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toHaveLength(2);
    } finally {
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  // prettier-ignore
  it('uses the eligible existing Lock price when a newer higher price exceeds vault capacity', { tags: ['exclusive-argon-network'] }, async () => {
    const harness = await createHarness();
    const client = await harness.clients.get(false);

    try {
      const insuredRate = await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
      const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 2n);
      const { createLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
      const insuredSatoshis = lock.securitizedSatoshis;
      const satoshis = insuredSatoshis * 9n / 10n;
      const firstCreation = await createLiquid.submit({ allocations: [{ lock, satoshis }], txSigner, client });
      await firstCreation.waitForPostProcessing;
      const existingFission = (await BitcoinFission.getAllByOwner(client, txSigner.address))[0];
      sendBitcoinToAddress(harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex), insuredSatoshis);
      generateBlocks(8, minerAddress);
      await waitFor(90_000, 'additional finalized Lock funding', async () => {
        const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
        return (await BitcoinLock.get(snapshot, lock.lockId!))?.fundedSatoshis === insuredSatoshis * 2n;
      });
      await harness.bitcoinLocks.syncCurrentLocks({ requireComplete: true });

      await submitBitcoinPrice(client, { btcUsdPrice: 180_000 });
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
      const higherRate = await submitBitcoinPrice(client, { btcUsdPrice: 180_000 });
      const currentRate = await submitBitcoinPrice(client, { btcUsdPrice: 110_000 });
      const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
      const currentLock = (await BitcoinLock.get(snapshot, lock.lockId!))!;
      const vault = await Vault.get(snapshot, lock.vaultId, NetworkConfig.tickMillis);
      const priceIndex = await Currency.fetchPriceIndex(snapshot);
      const availableCoverage = currentLock.securitizationCoverageMicrogons + vault.availableBitcoinSpace(txSigner.address);
      const securitizedSatoshis = existingFission.satoshis + satoshis;
      expect(BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis: securitizedSatoshis, microgonsAtTargetPerBtc: insuredRate })).toBeLessThanOrEqual(availableCoverage);
      expect(BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis: securitizedSatoshis, microgonsAtTargetPerBtc: higherRate })).toBeGreaterThan(availableCoverage);

      const creation = await createLiquid.submit({ allocations: [{ lock, satoshis }], txSigner, client });
      await creation.waitForPostProcessing;
      expect((await BitcoinLock.get(client, lock.lockId!))?.microgonsAtTargetPerBtc).toBe(insuredRate);
      const currentFissions = await BitcoinFission.getAllByOwner(client, txSigner.address);
      expect(currentFissions.find(fission => fission.fissionId === existingFission.fissionId)).toEqual(existingFission);
      expect(currentFissions.find(fission => fission.liquidId === creation.tx.metadataJson.liquidId)?.microgonsAtTargetPerBtc).toBe(currentRate);
      expect(fissions.getLiquids().some(liquid => liquid.liquidId === creation.tx.metadataJson.liquidId)).toBe(true);
      expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toHaveLength(2);
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  it('creates one Liquid with exact allocations from two funded Locks', async () => {
    const harness = await createHarness();

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 10n;
      const client = await harness.clients.get(false);
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const firstLock = await createFundedLock(harness, targetLiquidity);
      const secondLock = await createFundedLock(harness, targetLiquidity);
      const allocations = [
        { lock: firstLock, satoshis: firstLock.securitizedSatoshis },
        { lock: secondLock, satoshis: secondLock.securitizedSatoshis },
      ];
      const { createLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();

      const txInfo = await createLiquid.submit({ allocations, txSigner, client });
      await txInfo.txResult.waitForFinalizedBlock;
      await txInfo.waitForPostProcessing;

      const current = (await BitcoinFission.getAllByOwner(client, txSigner.address)).sort(
        (left, right) => left.fissionId - right.fissionId,
      );
      expect(current).toHaveLength(2);
      expect(current.map(fission => fission.fissionId)).toEqual([0, 1]);
      expect(current.map(fission => fission.liquidId)).toEqual([0, 0]);
      expect(current.map(fission => ({ lockId: fission.lockId, satoshis: fission.satoshis }))).toEqual([
        { lockId: firstLock.lockId, satoshis: firstLock.securitizedSatoshis },
        { lockId: secondLock.lockId, satoshis: secondLock.securitizedSatoshis },
      ]);

      const [firstCurrentLock, secondCurrentLock] = await BitcoinLock.getMany(client, [
        firstLock.lockId!,
        secondLock.lockId!,
      ]);
      expect(firstCurrentLock?.fissionedSatoshis).toBe(firstLock.securitizedSatoshis);
      expect(secondCurrentLock?.fissionedSatoshis).toBe(secondLock.securitizedSatoshis);
      expect(fissions.getLiquids()).toEqual([
        expect.objectContaining({
          liquidId: 0,
          fissions: [
            expect.objectContaining({ fissionId: 0, lockId: firstLock.lockId }),
            expect.objectContaining({ fissionId: 1, lockId: secondLock.lockId }),
          ],
        }),
      ]);
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  it(
    'resecuritizes a partially funded Lock at the same rate and preserves coverage past its old hold',
    { tags: ['exclusive-argon-network'] },
    async () => {
      const harness = await createHarness();
      const client = await harness.clients.get(false);

      try {
        await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
        const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 10n, {
          fundingPercent: 50,
        });
        const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
        const insured = (await snapshot.query.bitcoinLocks.locksById(lock.lockId!))!;
        const fundedSatoshis = insured.fundedSatoshis;
        const oldHoldHeight = insured.securitizationHoldExpirationBitcoinHeight;
        expect(insured.securitizationBasis.satoshis).toBeGreaterThan(fundedSatoshis);
        const rate = await submitBitcoinPrice(client, { btcUsdPrice: 120_000, argonUsdPrice: 0.795 });
        expect(rate).toBe(insured.securitizationBasis.microgonsAtTargetPerBtc);
        const { createLiquid, fissions } = await createLiquidServices(harness);
        const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
        const allocations = [{ lock, satoshis: fundedSatoshis }];
        const preview = await createLiquid.preview({ allocations, txSigner, client });
        expect(preview.securityFeeMicrogons).toBe(0n);
        expect(preview.totalSecurityFeeMicrogons).toBe(0n);
        const creation = await createLiquid.submit({ allocations, txSigner, client });
        await creation.waitForPostProcessing;

        const finalized = await client.at(await client.rpc.chain.getFinalizedHead());
        const current = (await finalized.query.bitcoinLocks.locksById(lock.lockId!))!;
        const created = await BitcoinFission.getAllByOwner(finalized, txSigner.address);
        expect(current.securitizationBasis).toEqual({ satoshis: fundedSatoshis, microgonsAtTargetPerBtc: rate });
        expect(current.securitizationCoverageMicrogons).toBeGreaterThanOrEqual(created[0].liquidityPromised);
        expect(creation.tx.metadataJson.resecuritizations).toHaveLength(1);
        expect(creation.tx.metadataJson.resecuritizations[0].bitcoin.securityFee).toBe(0n);
        const bitcoinHeight = (await finalized.query.bitcoinUtxos.confirmedBitcoinBlockTip())!.blockHeight;
        generateBlocks(Math.max(1, oldHoldHeight - bitcoinHeight + 8), minerAddress);
        await waitFor(90_000, 'old partial-funding hold boundary', async () => {
          const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
          const tip = await snapshot.query.bitcoinUtxos.confirmedBitcoinBlockTip();
          return tip && tip.blockHeight > oldHoldHeight;
        });
        const afterHold = await client.at(await client.rpc.chain.getFinalizedHead());
        expect((await afterHold.query.bitcoinLocks.locksById(lock.lockId!))?.securitizationCoverageMicrogons).toBe(
          current.securitizationCoverageMicrogons,
        );
        expect((await BitcoinFission.getAllByOwner(afterHold, txSigner.address))[0].liquidityPromised).toBe(
          created[0].liquidityPromised,
        );
        expect(fissions.getLiquids().some(liquid => liquid.liquidId === creation.tx.metadataJson.liquidId)).toBe(true);
        expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toHaveLength(1);
      } finally {
        await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
        await cleanupBitcoinLocksHarness(harness);
      }
    },
  );

  it.each([false, true])(
    'creates a smaller Liquid when all remaining Bitcoin exceeds coverage, with integer rounding: %s',
    { tags: ['exclusive-argon-network'] },
    async hasRoundingBoundary => {
      const harness = await createHarness();
      const client = await harness.clients.get(false);
      let restorePriceHistory: string | undefined;
      try {
        await submitBitcoinPrice(client, {
          btcUsdPrice: hasRoundingBoundary ? 110_327.92353274 : 120_000,
          argonUsdPrice: 0.795,
        });
        if (hasRoundingBoundary) {
          const vaultSigner = await harness.walletKeys.getVaultingKeypair();
          await submitAndFinalize(
            client,
            client.tx.balances.transferKeepAlive(vaultSigner.address, 100_000_000n),
            await harness.walletKeys.getLiquidLockingKeypair(),
            { useLatestNonce: true },
          );
          await submitAndFinalize(
            client,
            client.tx.vaults.modifyFunding(harness.myVault.createdVault!.vaultId, 100_000_000n, toFixedNumber(1, 18)),
            vaultSigner,
            { useLatestNonce: true },
          );
        }
        const initialPrice = await Currency.fetchPriceIndex(await client.at(await client.rpc.chain.getFinalizedHead()));
        const liquidity = hasRoundingBoundary
          ? BitcoinLock.calculateLiquidityPromised({ priceIndex: initialPrice, satoshis: 50_008n })
          : harness.myVault.createdVault!.availableBitcoinSpace() / 10n;
        const lock = await createFundedLock(harness, liquidity);
        const insuredSatoshis = lock.securitizedSatoshis;
        const { createLiquid, fissions } = await createLiquidServices(harness);
        const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
        const firstCreation = await createLiquid.submit({
          allocations: [{ lock, satoshis: insuredSatoshis / 2n }],
          txSigner,
          client,
        });
        await firstCreation.waitForPostProcessing;
        const existingFission = (await BitcoinFission.getAllByOwner(client, txSigner.address))[0];
        const additionalSatoshis = hasRoundingBoundary ? 5_000n : 0n;
        if (additionalSatoshis) {
          expect(insuredSatoshis).toBe(50_008n);
          sendBitcoinToAddress(
            harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex),
            additionalSatoshis,
          );
          generateBlocks(8, minerAddress);
          await waitFor(90_000, 'additional finalized rounding-boundary funding', async () => {
            const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
            return (
              (await BitcoinLock.get(snapshot, lock.lockId!))?.fundedSatoshis === insuredSatoshis + additionalSatoshis
            );
          });
          await harness.bitcoinLocks.syncCurrentLocks({ requireComplete: true });
        }
        const rate = await submitBitcoinPrice(client, { btcUsdPrice: hasRoundingBoundary ? 120_000 : 121_200 });
        const history = await client.raw.query.bitcoinLocks.microgonPerBtcHistory();
        restorePriceHistory = history.toHex();
        const eligible = history.registry.createType(
          history.toRawType(),
          history.filter(([, value]) => value.toBigInt() === rate),
        );
        await sudoSubmitAndFinalize(
          client,
          client.tx.system.setStorage([[client.raw.query.bitcoinLocks.microgonPerBtcHistory.key(), eligible.toHex()]]),
        );
        const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
        const priceIndex = await Currency.fetchPriceIndex(snapshot);
        const satoshis = hasRoundingBoundary ? 25_015n : (insuredSatoshis * 3n) / 10n;
        const coverage = BitcoinLock.calculateLiquidityPromised({
          priceIndex,
          satoshis:
            insuredSatoshis > existingFission.satoshis + satoshis
              ? insuredSatoshis
              : existingFission.satoshis + satoshis,
          microgonsAtTargetPerBtc: rate,
        });
        const requiredLiquidity =
          existingFission.liquidityPromised +
          BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis, microgonsAtTargetPerBtc: rate });
        const allRemainingLiquidity =
          existingFission.liquidityPromised +
          BitcoinLock.calculateLiquidityPromised({
            priceIndex,
            satoshis: insuredSatoshis + additionalSatoshis - existingFission.satoshis,
            microgonsAtTargetPerBtc: rate,
          });
        const allRemainingCoverage = BitcoinLock.calculateLiquidityPromised({
          priceIndex,
          satoshis: insuredSatoshis + additionalSatoshis,
          microgonsAtTargetPerBtc: rate,
        });
        expect(requiredLiquidity).toBeLessThanOrEqual(coverage);
        expect(allRemainingLiquidity).toBeGreaterThan(allRemainingCoverage);
        if (hasRoundingBoundary) {
          expect(requiredLiquidity).toBe(coverage);
          expect(allRemainingLiquidity - allRemainingCoverage).toBe(1n);
        }
        await expect(
          createLiquid.preview({
            allocations: [{ lock, satoshis: insuredSatoshis + additionalSatoshis - existingFission.satoshis }],
            txSigner,
            client,
          }),
        ).rejects.toThrow('This Bitcoin cannot cover the existing and selected Liquids at the current price.');
        const allocations = [{ lock, satoshis }];
        const preview = await createLiquid.preview({ allocations, txSigner, client });
        expect(preview.maximumSatoshisByLockId[lock.lockId!]).toBeGreaterThanOrEqual(satoshis);
        const creation = await createLiquid.submit({ allocations, txSigner, client });
        await creation.waitForPostProcessing;
        const finalized = await client.at(await client.rpc.chain.getFinalizedHead());
        const current = (await BitcoinLock.get(finalized, lock.lockId!))!;
        const currentFissions = await BitcoinFission.getAllByOwner(finalized, txSigner.address);
        expect(current.microgonsAtTargetPerBtc).toBe(rate);
        expect(current.securitizationCoverageMicrogons).toBe(coverage);
        expect(current.fissionedSatoshis).toBe(existingFission.satoshis + satoshis);
        expect(currentFissions.find(fission => fission.fissionId === existingFission.fissionId)).toEqual(
          existingFission,
        );
        expect(currentFissions.reduce((total, fission) => total + fission.liquidityPromised, 0n)).toBe(
          requiredLiquidity,
        );
        expect(fissions.getLiquids().some(liquid => liquid.liquidId === creation.tx.metadataJson.liquidId)).toBe(true);
        expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toHaveLength(2);
      } finally {
        if (restorePriceHistory)
          await sudoSubmitAndFinalize(
            client,
            client.tx.system.setStorage([
              [client.raw.query.bitcoinLocks.microgonPerBtcHistory.key(), restorePriceHistory],
            ]),
          );
        await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
        await cleanupBitcoinLocksHarness(harness);
      }
    },
  );

  it(
    'uses coverage released by an earlier Lock to create a Liquid from two Locks',
    { tags: ['exclusive-argon-network'] },
    async () => {
      const harness = await createHarness();
      const client = await harness.clients.get(false);
      let restorePriceHistory: string | undefined;

      try {
        await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
        const first = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 3n);
        const firstSatoshis = first.securitizedSatoshis;
        const firstCoverage = first.securitizationCoverageMicrogons!;
        const rate = await submitBitcoinPrice(client, { btcUsdPrice: 40_000 });
        const second = await createFundedLock(harness, firstCoverage / 4n);
        const secondSatoshis = second.securitizedSatoshis;
        for (const [lock, satoshis] of [
          [first, firstSatoshis],
          [second, secondSatoshis],
        ] as const) {
          sendBitcoinToAddress(
            harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex),
            satoshis,
          );
        }
        generateBlocks(8, minerAddress);
        await waitFor(90_000, 'two Locks with additional finalized funding', async () => {
          const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
          const locks = await BitcoinLock.getMany(snapshot, [first.lockId!, second.lockId!]);
          return locks[0]?.fundedSatoshis === firstSatoshis * 2n && locks[1]?.fundedSatoshis === secondSatoshis * 2n;
        });
        await harness.bitcoinLocks.syncCurrentLocks({ requireComplete: true });
        const history = await client.raw.query.bitcoinLocks.microgonPerBtcHistory();
        restorePriceHistory = history.toHex();
        const eligible = history.registry.createType(
          history.toRawType(),
          history.filter(([, value]) => value.toBigInt() === rate),
        );
        await sudoSubmitAndFinalize(
          client,
          client.tx.system.setStorage([[client.raw.query.bitcoinLocks.microgonPerBtcHistory.key(), eligible.toHex()]]),
        );
        const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
        const vault = await Vault.get(snapshot, first.vaultId, NetworkConfig.tickMillis);
        await submitAndFinalize(
          client,
          client.tx.vaults.setReservedSecuritizationSpace(vault.availableSecuritizationSpace()),
          await harness.walletKeys.getVaultingKeypair(),
          { useLatestNonce: true },
        );
        const constrained = await client.at(await client.rpc.chain.getFinalizedHead());
        expect((await Vault.get(constrained, first.vaultId, NetworkConfig.tickMillis)).availableBitcoinSpace()).toBe(
          0n,
        );
        const priceIndex = await Currency.fetchPriceIndex(constrained);
        const replacements = [firstSatoshis, secondSatoshis].map(satoshis =>
          BitcoinLock.calculateLiquidityPromised({
            priceIndex,
            satoshis: satoshis * 2n,
            microgonsAtTargetPerBtc: rate,
          }),
        );
        expect(replacements[0]).toBeLessThan(firstCoverage);
        expect(replacements[0] + replacements[1]).toBeLessThanOrEqual(
          firstCoverage + second.securitizationCoverageMicrogons!,
        );
        const { createLiquid, fissions } = await createLiquidServices(harness);
        const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
        const allocations = [
          { lock: first, satoshis: firstSatoshis * 2n },
          { lock: second, satoshis: secondSatoshis * 2n },
        ];
        const creation = await createLiquid.submit({ allocations, txSigner, client });
        await creation.waitForPostProcessing;
        const finalized = await client.at(await client.rpc.chain.getFinalizedHead());
        const current = await BitcoinLock.getMany(finalized, [first.lockId!, second.lockId!]);
        expect(current.map(lock => lock?.fissionedSatoshis)).toEqual(
          allocations.map(allocation => allocation.satoshis),
        );
        expect(current.map(lock => lock?.securitizationCoverageMicrogons)).toEqual(replacements);
        expect(creation.tx.metadataJson.resecuritizations).toHaveLength(2);
        const createdFissions = await BitcoinFission.getAllByOwner(finalized, txSigner.address);
        expect(
          allocations.map(({ lock }) => createdFissions.find(fission => fission.lockId === lock.lockId)?.satoshis),
        ).toEqual(allocations.map(allocation => allocation.satoshis));
        expect(
          fissions.getLiquids().find(liquid => liquid.liquidId === creation.tx.metadataJson.liquidId)?.fissions,
        ).toHaveLength(2);
        expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toHaveLength(2);
      } finally {
        if (restorePriceHistory)
          await sudoSubmitAndFinalize(
            client,
            client.tx.system.setStorage([
              [client.raw.query.bitcoinLocks.microgonPerBtcHistory.key(), restorePriceHistory],
            ]),
          );
        await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
        await cleanupBitcoinLocksHarness(harness);
      }
    },
  );

  it(
    'creates a Liquid within retained insurance when a new purchase would exceed Vault capacity',
    { tags: ['exclusive-argon-network'] },
    async () => {
      const harness = await createHarness();
      const client = await harness.clients.get(false);

      try {
        await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
        const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 10n);
        const storedCoverage = lock.securitizationCoverageMicrogons!;
        await submitBitcoinPrice(client, { btcUsdPrice: 120_000, argonUsdPrice: 0.795 });
        const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
        const vault = await Vault.get(snapshot, lock.vaultId, NetworkConfig.tickMillis);
        await submitAndFinalize(
          client,
          client.tx.vaults.setReservedSecuritizationSpace(vault.availableSecuritizationSpace()),
          await harness.walletKeys.getVaultingKeypair(),
          { useLatestNonce: true },
        );
        const constrained = await client.at(await client.rpc.chain.getFinalizedHead());
        expect((await Vault.get(constrained, lock.vaultId, NetworkConfig.tickMillis)).availableBitcoinSpace()).toBe(0n);
        const priceIndex = await Currency.fetchPriceIndex(constrained);
        const rate = lock.microgonsAtTargetPerBtc!;
        const satoshis = lock.securitizedSatoshis / 10n;
        expect(
          BitcoinLock.calculateLiquidityPromised({
            priceIndex,
            satoshis: lock.securitizedSatoshis,
            microgonsAtTargetPerBtc: rate,
          }),
        ).toBeGreaterThan(storedCoverage);
        expect(
          BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis, microgonsAtTargetPerBtc: rate }),
        ).toBeLessThan(storedCoverage);
        const { createLiquid, fissions } = await createLiquidServices(harness);
        const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
        const allocations = [{ lock, satoshis }];
        const preview = await createLiquid.preview({ allocations, txSigner, client });
        expect(preview.maximumSatoshisByLockId[lock.lockId!]).toBeGreaterThanOrEqual(satoshis);
        expect(preview.securityFeeMicrogons).toBe(0n);
        expect(preview.totalSecurityFeeMicrogons).toBe(0n);
        const creation = await createLiquid.submit({ allocations, txSigner, client });
        await creation.waitForPostProcessing;
        expect(creation.tx.metadataJson.resecuritizations).toEqual([]);
        const finalized = await client.at(await client.rpc.chain.getFinalizedHead());
        expect((await BitcoinLock.get(finalized, lock.lockId!))?.securitizationCoverageMicrogons).toBe(storedCoverage);
        expect((await BitcoinFission.getAllByOwner(finalized, txSigner.address))[0].satoshis).toBe(satoshis);
        expect(fissions.getLiquids().some(liquid => liquid.liquidId === creation.tx.metadataJson.liquidId)).toBe(true);
        expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toHaveLength(1);
      } finally {
        await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
        await cleanupBitcoinLocksHarness(harness);
      }
    },
  );

  it('serializes concurrent Liquid creations against the runtime Fission identity', async () => {
    const harness = await createHarness();

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 10n;
      const client = await harness.clients.get(false);
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const firstLock = await createFundedLock(harness, targetLiquidity);
      const secondLock = await createFundedLock(harness, targetLiquidity);
      const { createLiquid } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();

      const transactions = await Promise.all([
        createLiquid.submit({
          allocations: [{ lock: firstLock, satoshis: firstLock.securitizedSatoshis }],
          txSigner,
          client,
        }),
        createLiquid.submit({
          allocations: [{ lock: secondLock, satoshis: secondLock.securitizedSatoshis }],
          txSigner,
          client,
        }),
      ]);
      await Promise.all(transactions.map(txInfo => txInfo.waitForPostProcessing));

      const current = (await BitcoinFission.getAllByOwner(client, txSigner.address)).sort(
        (left, right) => left.fissionId - right.fissionId,
      );
      expect(current.map(fission => ({ fissionId: fission.fissionId, liquidId: fission.liquidId }))).toEqual([
        { fissionId: 0, liquidId: 0 },
        { fissionId: 1, liquidId: 1 },
      ]);
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  it('waits for finalized funding and recovers the operator Liquid without duplication', async () => {
    const walletKeys = createMockWalletKeys();
    const harness = await createHarness(walletKeys);
    let actor: AppVaultOperator | undefined;

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 5n;
      const client = await harness.clients.get(false);
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const lock = await createFundedLock(harness, targetLiquidity, {
        waitForFinalizedFunding: false,
        onCreated: async () => {
          actor = await AppVaultOperator.load({
            clients: harness.clients,
            walletKeys,
            networkConfigOverride: network.networkConfigOverride,
          });
        },
      });
      if (!actor) throw new Error('Operator actor was not loaded before Bitcoin funding.');

      const beforeFinalization = runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
      expect((await BitcoinLock.get(beforeFinalization, lock.lockId!))?.fundedSatoshis ?? 0n).toBe(0n);

      await actor.ensureOperationalLiquid({ client });
      const finalizedClient = runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
      const fissions = await BitcoinFission.getAllByOwner(finalizedClient, walletKeys.defaultArgonAddress);
      expect(fissions).toHaveLength(1);
      expect(fissions[0]).toMatchObject({
        lockId: lock.lockId,
        satoshis: lock.securitizedSatoshis,
      });

      await actor.dispose();
      actor = undefined;
      actor = await AppVaultOperator.load({
        clients: harness.clients,
        walletKeys,
        networkConfigOverride: network.networkConfigOverride,
      });
      await actor.ensureOperationalLiquid({ client });

      const restoredClient = runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
      expect(await BitcoinFission.getAllByOwner(restoredClient, walletKeys.defaultArgonAddress)).toEqual(fissions);
    } finally {
      await actor?.dispose();
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  // prettier-ignore
  it('ratchets a finalized Liquid through the application operation at an eligible runtime rate', { tags: ['exclusive-argon-network'] }, async () => {
    const harness = await createHarness();

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 5n;
      const client = await harness.clients.get(false);
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const lock = await createFundedLock(harness, targetLiquidity);
      await submitBitcoinPrice(client, { btcUsdPrice: 121_000 });
      const { createLiquid, ratchetLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();

      const createTxInfo = await createLiquid.submit({
        allocations: [{ lock, satoshis: lock.securitizedSatoshis }],
        txSigner,
        client,
      });
      await createTxInfo.txResult.waitForFinalizedBlock;
      await createTxInfo.waitForPostProcessing;

      const initialFission = await BitcoinFission.get(client, txSigner.address, 0);
      if (!initialFission) throw new Error('Finalized Liquid was not published by the runtime.');

      const unsupportedRate = await submitBitcoinPrice(client, {
        btcUsdPrice: 1_500_000,
      });
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      harness.vaults.operatorNamesByVaultId[lock.vaultId] = 'Testing';
      const unsupportedPreview = await ratchetLiquid.previewRatchet(
        initialFission.liquidId,
        unsupportedRate,
        runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead())),
        harness.currency.priceIndex,
      );
      expect(unsupportedPreview.canRatchet).toBe(false);
      expect(unsupportedPreview.errors).toEqual([
        'Testing does not have enough available securitization for this ratchet.',
      ]);

      const ratchetRate = await submitBitcoinPrice(client, {
        btcUsdPrice: 150_000,
      });
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const snapshotClient = runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
      const preview = await ratchetLiquid.previewRatchet(
        initialFission.liquidId,
        ratchetRate,
        snapshotClient,
        harness.currency.priceIndex,
      );
      expect(preview).toMatchObject({
        liquidId: initialFission.liquidId,
        fissionIds: [initialFission.fissionId],
        skippedFissionIds: [],
        sourceLiquidity: initialFission.liquidityPromised,
        amountToBurn: 0n,
        errors: [],
        canRatchet: true,
        lockChanges: [
          {
            lockId: lock.lockId,
            phase: 'before-fissions',
            securitizedSatoshis: lock.securitizedSatoshis,
            microgonsAtTargetPerBtc: ratchetRate,
          },
        ],
      });
      expect(preview.newLiquidity).toBeGreaterThan(preview.sourceLiquidity);
      expect(preview.amountToMint).toBe(preview.newLiquidity - preview.sourceLiquidity);

      const ratchetTxInfo = await ratchetLiquid.submit({
        liquidId: initialFission.liquidId,
        microgonsAtTargetPerBtc: ratchetRate,
        txSigner,
        client,
      });
      await ratchetTxInfo.txResult.waitForFinalizedBlock;
      await ratchetTxInfo.waitForPostProcessing;

      expect(ratchetTxInfo.tx.metadataJson).toMatchObject({
        liquidId: initialFission.liquidId,
        fissionIds: [initialFission.fissionId],
        resecuritizedLockIds: [lock.lockId],
      });
      const ratchetedFission = await BitcoinFission.get(client, txSigner.address, initialFission.fissionId);
      expect(ratchetedFission).toMatchObject({
        liquidId: initialFission.liquidId,
        fissionId: initialFission.fissionId,
        lockId: lock.lockId,
        satoshis: lock.securitizedSatoshis,
        microgonsAtTargetPerBtc: ratchetRate,
        liquidityPromised: preview.newLiquidity,
        ratchetNumber: 1,
      });

      const currentLock = await BitcoinLock.get(client, lock.lockId!);
      expect(currentLock).toMatchObject({
        securitizedSatoshis: lock.securitizedSatoshis,
        fissionedSatoshis: lock.securitizedSatoshis,
        microgonsAtTargetPerBtc: ratchetRate,
      });
      expect(fissions.getLiquids()).toEqual([
        expect.objectContaining({
          liquidId: initialFission.liquidId,
          fissions: [
            expect.objectContaining({
              fissionId: initialFission.fissionId,
              microgonsAtTargetPerBtc: ratchetRate,
              liquidityPromised: preview.newLiquidity,
              ratchetNumber: 1,
            }),
          ],
        }),
      ]);
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  it('closes a finalized Liquid without releasing its funded Lock', async () => {
    const harness = await createHarness();

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 10n;
      const client = await harness.clients.get(false);
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const lock = await createFundedLock(harness, targetLiquidity);
      const { createLiquid, closeLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();

      const createTxInfo = await createLiquid.submit({
        allocations: [{ lock, satoshis: lock.securitizedSatoshis }],
        txSigner,
        client,
      });
      await createTxInfo.txResult.waitForFinalizedBlock;
      await createTxInfo.waitForPostProcessing;

      const fission = await BitcoinFission.get(client, txSigner.address, 0);
      if (!fission) throw new Error('Finalized Liquid was not published by the runtime.');
      const finalizedClient = runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
      const expectedRedemption = fission.calculateRedemptionAmount(
        await harness.currency.fetchPriceIndex(finalizedClient),
      );

      const closeTxInfo = await closeLiquid.submit({ liquidId: fission.liquidId, txSigner, client });
      await closeTxInfo.txResult.waitForFinalizedBlock;
      await closeTxInfo.waitForPostProcessing;

      expect(closeTxInfo.tx.metadataJson).toEqual({
        liquidId: fission.liquidId,
        fissionIds: [fission.fissionId],
        redemptionAmount: expectedRedemption,
      });
      expect(await BitcoinFission.getAllByOwner(client, txSigner.address)).toEqual([]);
      expect(fissions.getAll()).toEqual([]);
      expect(fissions.getLiquids()).toEqual([
        expect.objectContaining({
          liquidId: fission.liquidId,
          fissions: [expect.objectContaining({ fissionId: fission.fissionId })],
        }),
      ]);
      expect(fissions.getLiquids()[0].isClosed).toBe(true);

      const currentLock = await BitcoinLock.get(client, lock.lockId!);
      expect(currentLock).toMatchObject({
        fundedSatoshis: lock.securitizedSatoshis,
        fissionedSatoshis: 0n,
      });
      expect(await BitcoinLock.getReleaseRequest(client, lock.lockId!)).toBeUndefined();

      const wallet = new WalletForBitcoin(
        () => harness.bitcoinLocks,
        () => txSigner.address,
        harness.bitcoinLockCreate,
      );
      await waitFor(30_000, 'closed Liquid Bitcoin to become sendable', async () => {
        if (!wallet.getSendableChannels().includes(lock)) return;
        return true;
      });
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });
});

async function submitBitcoinPrice(
  client: ArgonClient,
  args: { btcUsdPrice: number; argonUsdPrice?: number },
): Promise<bigint> {
  const { btcUsdPrice, argonUsdPrice = 1.06 } = args;
  const initialSnapshot = await client.at(await client.rpc.chain.getFinalizedHead());
  const [currentPrice, rateHistory] = await Promise.all([
    initialSnapshot.query.priceIndex.current(),
    initialSnapshot.query.bitcoinLocks.microgonPerBtcHistory(),
  ]);
  const latestHistory = rateHistory?.at(-1);
  if (
    currentPrice?.btcUsdPrice.isEqualTo(btcUsdPrice) &&
    currentPrice.argonUsdPrice.isEqualTo(argonUsdPrice) &&
    latestHistory
  ) {
    return latestHistory[1];
  }
  if (currentPrice && !currentPrice.argonUsdPrice.isEqualTo(argonUsdPrice)) {
    const rawPrice = await client.raw.query.priceIndex.current();
    const agedPrice = rawPrice.registry.createType(rawPrice.toRawType(), {
      ...(rawPrice.toJSON() as object),
      tick: (await client.query.ticks.currentTick()) - 60,
    });
    // Advance the external oracle observation boundary so a changed spot price is eligible.
    await sudoSubmitAndFinalize(
      client,
      client.tx.system.setStorage([[client.raw.query.priceIndex.current.key(), agedPrice.toHex()]]),
    );
  }
  const tick = await waitFor(30_000, 'fresh price tick', async () => {
    const currentTick = await client.query.ticks.currentTick();
    if (currentTick <= (currentPrice?.tick ?? 0)) return;
    return currentTick;
  });
  await submitAndFinalize(
    client,
    client.tx.priceIndex.submit(
      {
        btcUsdPrice: toFixedNumber(btcUsdPrice, 18),
        argonUsdPrice: toFixedNumber(argonUsdPrice, 18),
        argonotUsdPrice: toFixedNumber(0.05, 18),
        argonUsdTargetPrice: toFixedNumber(1.06, 18),
        argonTimeWeightedAverageLiquidity: toFixedNumber(100_000_000, 18),
        tick: BigInt(tick),
      },
      null,
    ),
    priceOracle,
    { useLatestNonce: true },
  );

  return await waitFor(30_000, `eligible Bitcoin rate after price tick ${tick}`, async () => {
    const snapshotClient = runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
    const [publishedPrice, rateHistory] = await Promise.all([
      Currency.fetchPriceIndex(snapshotClient),
      snapshotClient.query.bitcoinLocks.microgonPerBtcHistory(),
    ]);
    const latestRate = rateHistory?.at(-1);
    if (publishedPrice.lastUpdatedTick !== tick || !latestRate) return;
    const [, rate] = latestRate;
    if (rate !== publishedPrice.getSatoshiPriceInTargetMicrogons(SATS_PER_BTC)) return;
    return rate;
  });
}

async function createHarness(walletKeys?: MemoryWalletKeys): Promise<BitcoinLocksHarness> {
  return await createBitcoinLocksHarness({
    archiveUrl: network.archiveUrl,
    esploraHost: network.networkConfigOverride.esploraHost,
    network: 'dev-docker',
    walletKeys,
    walletFundingMicrogons,
  });
}

async function createFundedLock(
  harness: BitcoinLocksHarness,
  targetLiquidity: bigint,
  args: {
    verifyRestoredCreation?: boolean;
    waitForFinalizedFunding?: boolean;
    onCreated?: (lock: IBitcoinLockRecord) => Promise<void>;
    fundingPercent?: number;
  } = {},
): Promise<IBitcoinLockRecord> {
  const { verifyRestoredCreation = false, waitForFinalizedFunding = true, onCreated, fundingPercent = 100 } = args;
  const vault = harness.myVault.createdVault!;
  const client = await harness.clients.get(false);
  await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
  const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
  let pendingLockUuid: string;
  if (verifyRestoredCreation) {
    const wallet = new WalletForBitcoin(
      () => harness.bitcoinLocks,
      () => txSigner.address,
      harness.bitcoinLockCreate,
    );
    const creation = wallet.createChannel({
      vault,
      liquidityMicrogons: targetLiquidity,
      txSigner,
    });
    const restoredCreation = wallet.createChannel({ vault, liquidityMicrogons: targetLiquidity, txSigner });
    expect(restoredCreation).toBe(creation);
    expect(wallet.isCreatingChannel(vault.vaultId)).toBe(true);
    const pendingLock = await creation;
    await expect(restoredCreation).resolves.toBe(pendingLock);
    expect(wallet.isCreatingChannel(vault.vaultId)).toBe(false);
    pendingLockUuid = pendingLock.uuid;
    const txInfo = harness.bitcoinLockCreate.getPendingLockTxInfo(pendingLockUuid);
    if (!txInfo) throw new Error('Pending Bitcoin channel transaction was not retained.');
    await txInfo.txResult.waitForFinalizedBlock;
    await txInfo.waitForPostProcessing;
  } else {
    const txInfo = await harness.bitcoinLockCreate.submit({
      vault,
      satoshis: await harness.bitcoinLocks.satoshisForArgonLiquidity(targetLiquidity),
      txSigner,
      client,
    });
    pendingLockUuid = txInfo.tx.metadataJson.bitcoin.uuid;
    await txInfo.txResult.waitForFinalizedBlock;
    await txInfo.waitForPostProcessing;
  }

  const lock = Object.values(harness.bitcoinLocks.data.locksByLockId).find(record => record.uuid === pendingLockUuid);
  if (!lock?.lockId) throw new Error('Finalized Bitcoin Lock was not published.');
  await onCreated?.(lock);

  const fundingAddress = harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
  const fundedSatoshis = (lock.securitizedSatoshis * BigInt(fundingPercent)) / 100n;
  sendBitcoinToAddress(fundingAddress, fundedSatoshis);
  generateBlocks(8, minerAddress);

  await waitFor(90_000, `Bitcoin Lock #${lock.lockId} funding`, async () => {
    const current = waitForFinalizedFunding
      ? await BitcoinLock.get(await client.at(await client.rpc.chain.getFinalizedHead()), lock.lockId!)
      : await BitcoinLock.get(client, lock.lockId!);
    if (current?.fundedSatoshis !== fundedSatoshis) return;
    return current;
  });
  return lock;
}

async function createLiquidServices(harness: BitcoinLocksHarness): Promise<{
  createLiquid: BitcoinLiquidCreate;
  ratchetLiquid: BitcoinLiquidRatchet;
  closeLiquid: BitcoinLiquidClose;
  fissions: BitcoinFissions;
}> {
  const fissions = new BitcoinFissions(
    Promise.resolve(harness.db),
    harness.walletKeys.defaultArgonAddress,
    harness.miningFrames.blockWatch,
    harness.currency,
  );
  await fissions.load();
  const upstreamOperatorClient = new UpstreamOperatorClient();
  vi.spyOn(upstreamOperatorClient, 'getBitcoinLockCoupons').mockResolvedValue([]);
  const resecuritize = new BitcoinLockResecuritize(
    harness.bitcoinLocks,
    harness.transactionTracker,
    harness.currency,
    upstreamOperatorClient,
  );
  const createLiquid = new BitcoinLiquidCreate(
    fissions,
    harness.transactionTracker,
    harness.bitcoinLocks,
    harness.vaults,
    resecuritize,
    upstreamOperatorClient,
  );
  const ratchetLiquid = new BitcoinLiquidRatchet(
    fissions,
    harness.transactionTracker,
    harness.currency,
    harness.bitcoinLocks,
    harness.vaults,
    resecuritize,
    upstreamOperatorClient,
  );
  const closeLiquid = new BitcoinLiquidClose(fissions, harness.transactionTracker, harness.currency);
  await Promise.all([createLiquid.load(), ratchetLiquid.load(), closeLiquid.load()]);
  return { createLiquid, ratchetLiquid, closeLiquid, fissions };
}
