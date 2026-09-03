import Path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SKIP_E2E, teardown } from '@argonprotocol/testing';
import { BitcoinFission, BitcoinLock, NetworkConfig, type ArgonClient } from '@argonprotocol/apps-core';
import { Keyring, toFixedNumber } from '@argonprotocol/mainchain';
import {
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import {
  createBitcoinAddress,
  generateBlocks,
  sendBitcoinToAddress,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { getTestMainchainClient, submitAndFinalize } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
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
import { MemoryWalletKeys } from '../lib/MemoryWalletKeys.ts';

const walletFundingMicrogons = 500_000_000n;

let network: StartedArgonTestNetwork;
let minerAddress: string;
let previousComposeProjectName: string | undefined;
const priceOracle = new Keyring({ type: 'sr25519' }).addFromUri('//Eve//oracle');

describe.skipIf(SKIP_E2E).sequential('Bitcoin Liquids integration', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    network = await startArgonTestNetwork(Path.basename(import.meta.filename), {
      profiles: ['bob'],
      chainStartTimeoutMs: 120_000,
      chainStartPollMs: 250,
    });
    NetworkConfig.setNetwork('dev-docker');
    previousComposeProjectName = process.env.COMPOSE_PROJECT_NAME;
    process.env.COMPOSE_PROJECT_NAME = network.composeEnv.COMPOSE_PROJECT_NAME;
    minerAddress = createBitcoinAddress();

    const client = await getTestMainchainClient(network.archiveUrl);
    try {
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
    } finally {
      await client.disconnect();
    }
  }, 240_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (previousComposeProjectName === undefined) {
      delete process.env.COMPOSE_PROJECT_NAME;
    } else {
      process.env.COMPOSE_PROJECT_NAME = previousComposeProjectName;
    }
    await teardown();
  });

  it('creates one Liquid from a funded Lock through the application operation', async () => {
    const harness = await createHarness();

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 5n;
      const client = await harness.clients.get(false);
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const lock = await createFundedLock(harness, targetLiquidity, { verifyRestoredCreation: true });
      const { createLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();

      const preview = await createLiquid.preview({
        allocations: [{ lock, satoshis: lock.securitizedSatoshis }],
        txSigner,
        client,
      });
      expect(preview.maximumSatoshisByUtxoId).toEqual({ [lock.utxoId!]: lock.securitizedSatoshis });
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
        utxoId: lock.utxoId,
        satoshis: lock.securitizedSatoshis,
      });
      expect(current[0].liquidityPromised).toBeGreaterThan(0n);

      const currentLock = await BitcoinLock.get(client, lock.utxoId!);
      expect(currentLock?.fissionedSatoshis).toBe(lock.securitizedSatoshis);
      expect(fissions.getLiquids()).toEqual([
        expect.objectContaining({
          liquidId: 0,
          fissions: [expect.objectContaining({ fissionId: 0, utxoId: lock.utxoId })],
        }),
      ]);
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  it('creates one Liquid with exact allocations from two funded Locks', async () => {
    const harness = await createHarness();

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 10n;
      const client = await harness.clients.get(false);
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
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
      expect(current.map(fission => ({ utxoId: fission.utxoId, satoshis: fission.satoshis }))).toEqual([
        { utxoId: firstLock.utxoId, satoshis: firstLock.securitizedSatoshis },
        { utxoId: secondLock.utxoId, satoshis: secondLock.securitizedSatoshis },
      ]);

      const [firstCurrentLock, secondCurrentLock] = await BitcoinLock.getMany(client, [
        firstLock.utxoId!,
        secondLock.utxoId!,
      ]);
      expect(firstCurrentLock?.fissionedSatoshis).toBe(firstLock.securitizedSatoshis);
      expect(secondCurrentLock?.fissionedSatoshis).toBe(secondLock.securitizedSatoshis);
      expect(fissions.getLiquids()).toEqual([
        expect.objectContaining({
          liquidId: 0,
          fissions: [
            expect.objectContaining({ fissionId: 0, utxoId: firstLock.utxoId }),
            expect.objectContaining({ fissionId: 1, utxoId: secondLock.utxoId }),
          ],
        }),
      ]);
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  it('serializes concurrent Liquid creations against the runtime Fission identity', async () => {
    const harness = await createHarness();

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 10n;
      const client = await harness.clients.get(false);
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
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
    const mnemonic = 'test test test test test test test test test test test junk';
    const walletKeys = new MemoryWalletKeys({ substrateSuri: mnemonic, masterMnemonic: mnemonic });
    const harness = await createHarness(walletKeys);
    let actor: AppVaultOperator | undefined;

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 5n;
      const client = await harness.clients.get(false);
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
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

      const beforeFinalization = await client.at(await client.rpc.chain.getFinalizedHead());
      expect((await BitcoinLock.get(beforeFinalization, lock.utxoId!))?.fundedSatoshis ?? 0n).toBe(0n);

      await actor.ensureOperationalLiquid({ client });
      const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());
      const fissions = await BitcoinFission.getAllByOwner(finalizedClient, walletKeys.defaultArgonAddress);
      expect(fissions).toHaveLength(1);
      expect(fissions[0]).toMatchObject({
        utxoId: lock.utxoId,
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

      const restoredClient = await client.at(await client.rpc.chain.getFinalizedHead());
      expect(await BitcoinFission.getAllByOwner(restoredClient, walletKeys.defaultArgonAddress)).toEqual(fissions);
    } finally {
      await actor?.dispose();
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  it('ratchets a finalized Liquid through the application operation at an eligible runtime rate', async () => {
    const harness = await createHarness();

    try {
      const targetLiquidity = harness.myVault.createdVault!.availableBitcoinSpace() / 5n;
      const client = await harness.clients.get(false);
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const lock = await createFundedLock(harness, targetLiquidity);
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
        await client.at(await client.rpc.chain.getFinalizedHead()),
        harness.currency.priceIndex,
      );
      expect(unsupportedPreview.canRatchet).toBe(false);
      expect(unsupportedPreview.errors).toEqual(['Testing does not have enough available insurance for this ratchet.']);

      const ratchetRate = await submitBitcoinPrice(client, {
        btcUsdPrice: 150_000,
      });
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const snapshotClient = await client.at(await client.rpc.chain.getFinalizedHead());
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
            utxoId: lock.utxoId,
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
        resecuritizedUtxoIds: [lock.utxoId],
      });
      const ratchetedFission = await BitcoinFission.get(client, txSigner.address, initialFission.fissionId);
      expect(ratchetedFission).toMatchObject({
        liquidId: initialFission.liquidId,
        fissionId: initialFission.fissionId,
        utxoId: lock.utxoId,
        satoshis: lock.securitizedSatoshis,
        microgonsAtTargetPerBtc: ratchetRate,
        liquidityPromised: preview.newLiquidity,
        ratchetNumber: 1,
      });

      const currentLock = await BitcoinLock.get(client, lock.utxoId!);
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
      await submitBitcoinPrice(client, { btcUsdPrice: 120_000 });
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
      const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());
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
      expect(fissions.getLiquids()).toEqual([]);

      const currentLock = await BitcoinLock.get(client, lock.utxoId!);
      expect(currentLock).toMatchObject({
        fundedSatoshis: lock.securitizedSatoshis,
        fissionedSatoshis: 0n,
      });
      expect(await BitcoinLock.getReleaseRequest(client, lock.utxoId!)).toBeUndefined();
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });
});

async function submitBitcoinPrice(client: ArgonClient, args: { btcUsdPrice: number }): Promise<bigint> {
  const { btcUsdPrice } = args;
  const initialSnapshot = await client.at(await client.rpc.chain.getFinalizedHead());
  const [currentPrice, rateHistory] = await Promise.all([
    initialSnapshot.query.priceIndex.current(),
    initialSnapshot.query.bitcoinLocks.microgonPerBtcHistory(),
  ]);
  const latestHistory = rateHistory?.at(-1);
  if (currentPrice?.btcUsdPrice.isEqualTo(btcUsdPrice) && latestHistory) {
    return latestHistory[1];
  }
  const previousHistoryTick = Number(latestHistory?.[0] ?? 0);
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
        argonUsdPrice: toFixedNumber(1.06, 18),
        argonotUsdPrice: toFixedNumber(0.05, 18),
        argonUsdTargetPrice: toFixedNumber(1.06, 18),
        argonTimeWeightedAverageLiquidity: toFixedNumber(100_000_000, 18),
        tick: BigInt(tick),
      },
      null,
    ),
    priceOracle,
  );

  return await waitFor(30_000, `eligible Bitcoin rate after price tick ${tick}`, async () => {
    const snapshotClient = await client.at(await client.rpc.chain.getFinalizedHead());
    const [publishedPrice, rateHistory] = await Promise.all([
      snapshotClient.query.priceIndex.current(),
      snapshotClient.query.bitcoinLocks.microgonPerBtcHistory(),
    ]);
    const latestRate = rateHistory?.at(-1);
    if (!publishedPrice || publishedPrice.tick !== tick || !latestRate) return;
    const [historyTick, rate] = latestRate;
    if (Number(historyTick) <= previousHistoryTick) return;
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
  } = {},
): Promise<IBitcoinLockRecord> {
  const { verifyRestoredCreation = false, waitForFinalizedFunding = true, onCreated } = args;
  const vault = harness.myVault.createdVault!;
  const client = await harness.clients.get(false);
  await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
  const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
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
  const restoredCreation = verifyRestoredCreation
    ? wallet.createChannel({ vault, liquidityMicrogons: targetLiquidity, txSigner })
    : creation;
  if (verifyRestoredCreation) {
    expect(restoredCreation).toBe(creation);
    expect(wallet.isCreatingChannel(vault.vaultId)).toBe(true);
  }

  const pendingLock = await creation;
  await expect(restoredCreation).resolves.toBe(pendingLock);
  expect(wallet.isCreatingChannel(vault.vaultId)).toBe(false);
  const txInfo = harness.bitcoinLockCreate.getPendingLockTxInfo(pendingLock.uuid);
  if (!txInfo) throw new Error('Pending Bitcoin channel transaction was not retained.');
  await txInfo.txResult.waitForFinalizedBlock;
  await txInfo.waitForPostProcessing;

  const lock = Object.values(harness.bitcoinLocks.data.locksByUtxoId).find(record => record.uuid === pendingLock.uuid);
  if (!lock?.utxoId) throw new Error('Finalized Bitcoin Lock was not published.');
  await onCreated?.(lock);

  const fundingAddress = harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
  sendBitcoinToAddress(fundingAddress, lock.securitizedSatoshis);
  generateBlocks(8, minerAddress);

  await waitFor(90_000, `Bitcoin Lock #${lock.utxoId} funding`, async () => {
    const current = waitForFinalizedFunding
      ? await BitcoinLock.get(await client.at(await client.rpc.chain.getFinalizedHead()), lock.utxoId!)
      : await BitcoinLock.get(client, lock.utxoId!);
    if (current?.fundedSatoshis !== lock.securitizedSatoshis) return;
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
