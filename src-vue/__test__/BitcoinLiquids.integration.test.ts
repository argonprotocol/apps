import { getHistoricalBitcoinLockDetails } from '../lib/recovery/BitcoinLockHistory.ts';
import { BitcoinFissionRecovery } from '../lib/recovery/BitcoinFissions.ts';
import { getFinalizedClient } from '../stores/mainchain.ts';
import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import docker from 'docker-compose';
import { COMPOSE_CONFIG, COMPOSE_DIR } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.ts';

import { SKIP_E2E, teardown } from '@argonprotocol/testing';
import {
  BitcoinFission,
  BitcoinLock,
  Currency,
  NetworkConfig,
  SATS_PER_BTC,
  Vault,
  UserRole,
  type ArgonClient,
} from '@argonprotocol/apps-core';
import { Keyring, toFixedNumber } from '@argonprotocol/mainchain';
import {
  integrationAccountUri,
  type IntegrationNetwork,
} from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import {
  createBitcoinAddress,
  generateBlocks,
  sendBitcoinToAddress,
  runBtcCli,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import {
  getTestMainchainClient,
  submitAndFinalize,
  sudoSubmitAndFinalize,
} from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';

import { BitcoinFissions } from '../lib/BitcoinFissions.ts';
import { BitcoinLockWalletFundingError } from '../lib/BitcoinLocks.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { BitcoinLiquidClose } from '../lib/txs/BitcoinLiquid.close.ts';
import { BitcoinLiquidCreate, BitcoinLiquidCreateStateChangedError } from '../lib/txs/BitcoinLiquid.create.ts';
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
import { Db as RouterDb } from '../../router/src/Db.ts';
import { BitcoinLockCouponService } from '../../router/src/BitcoinLockCouponService.ts';
import { BotUpstreamClient } from '../../router/src/BotUpstreamClient.ts';
import { BitcoinLockFeeCouponService } from '../../bot/src/BitcoinLockFeeCouponService.ts';
import { DelegateSubmitLane } from '../../bot/src/DelegateSubmitLane.ts';

const walletFundingMicrogons = 500_000_000n;
const runtimeSpec = Number(process.env.ARGON_TEST_RUNTIME_SPEC ?? 161);

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
      expect(client.runtimeVersion.specVersion.toNumber()).toBe(runtimeSpec);
      await waitFor(90_000, 'shared Bitcoin pricing', async () => {
        const snapshot = await getFinalizedClient(client);
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
      const satoshis = lock.securitizedSatoshis;

      await waitFor(90_000, 'fresh unchanged Bitcoin price with an older history entry', async () => {
        const snapshot = await getFinalizedClient(client);
        const [priceIndex, history, currentTick] = await Promise.all([
          Currency.fetchPriceIndex(snapshot),
          snapshot.query.bitcoinLocks.microgonPerBtcHistory(),
          snapshot.query.ticks.currentTick(),
        ]);
        if (priceIndex.lastUpdatedTick === undefined || priceIndex.lastUpdatedTick < currentTick - 20) return;

        const latestRate = history?.at(-1);
        if (!latestRate) return;
        const [rateTick, rate] = latestRate;
        if (rate !== priceIndex.getSatoshiPriceInTargetMicrogons(SATS_PER_BTC)) return;

        const rateAge = BigInt(currentTick) - rateTick;
        return rateAge >= 21n && rateAge <= 22n;
      });

      const preview = await createLiquid.preview({
        allocations: [{ lock, satoshis: satoshis }],
        txSigner,
        client,
      });
      expect(preview.maximumSatoshisByLockId).toEqual({ [lock.lockId!]: satoshis });
      expect(preview.liquidityMicrogons).toBeGreaterThan(0n);

      const txInfo = await createLiquid.submit({
        allocations: [{ lock, satoshis: satoshis }],
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
        satoshis: satoshis,
      });
      expect(current[0].liquidityPromised).toBeGreaterThan(0n);

      const currentLock = await BitcoinLock.get(client, lock.lockId!);
      expect(currentLock?.fissionedSatoshis).toBe(satoshis);
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

  it.each(['price', 'coverage'] as const)(
    'preserves independent %s targets through paid application Liquid flows on both runtimes',
    { tags: ['exclusive-argon-network'], timeout: 420_000 },
    async change => {
      const operator = await createHarness(
        createMockWalletKeys(
          integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, `operator-${change}`),
        ),
      );
      const vault = operator.myVault.createdVault!;
      const delegate = await operator.walletKeys.getVaultDelegateKeypair();
      const operatorSigner = await operator.walletKeys.getVaultingKeypair();
      await cleanupBitcoinLocksHarness(operator);
      const harness = await createHarness(
        createMockWalletKeys(
          integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, `owner-${change}`),
        ),
      );
      const client = await harness.clients.get(false);
      const spec = client.runtimeVersion.specVersion.toNumber();
      expect(spec).toBe(Number(process.env.ARGON_TEST_RUNTIME_SPEC ?? 161));

      const routerDb = new RouterDb(':memory:');
      routerDb.migrate();
      const composeOptions = {
        cwd: COMPOSE_DIR,
        config: COMPOSE_CONFIG,
        env: { ...process.env, COMPOSE_PROJECT_NAME: inject('argonIntegrationSession').composeProjectName },
      };
      try {
        await docker.pauseOne('bitcoin-miner', composeOptions);
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
        const lock = await createFundedLock(harness, 2_000_000n, { vault });
        const confirmedHeight = Number(runBtcCli(['getblockcount'])) - 6;
        await waitFor(90_000, 'all manually mined Bitcoin headers to finalize', async () => {
          const snapshot = await getFinalizedClient(client);
          const tip = await snapshot.query.bitcoinUtxos.confirmedBitcoinBlockTip();
          if (tip?.blockHeight === confirmedHeight) return true;
        });
        const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
        const upstream = new UpstreamOperatorClient(undefined, () => 'synthetic-operator');
        const signer = new BitcoinLockFeeCouponService(
          harness.clients,
          vault.operatorAccountId,
          new DelegateSubmitLane(delegate),
        );
        const botClient = new BotUpstreamClient('http://127.0.0.1:1');
        vi.spyOn(botClient, 'signBitcoinLockFeeCoupon').mockImplementation(request => signer.sign(request));
        const couponService = new BitcoinLockCouponService({
          db: routerDb,
          botClient,
          queryFinalizedState: async query => query(await getFinalizedClient(client)),
        });
        const member = routerDb.usersTable.insertUser({ role: UserRole.Member, name: 'Synthetic member' });
        vi.spyOn(upstream, 'getBitcoinLockCoupons').mockImplementation(() => couponService.getByUserId(member.id));
        vi.spyOn(upstream, 'initializeBitcoinLock').mockImplementation(async (offerCode, payload) => {
          const result = await couponService.authorizeInitialization(offerCode, payload);
          return {
            bitcoinLock: result.status,
            execution: { type: 'FeeCoupon', requestId: result.use.requestId, feeCoupon: result.use.feeCoupon! },
          };
        });
        let rejectFinalizedAcknowledgment = change === 'price';
        vi.spyOn(upstream, 'recordBitcoinLockFeeCouponUse').mockImplementation(async (requestId, status) => {
          if (status === 'Finalized' && rejectFinalizedAcknowledgment) {
            rejectFinalizedAcknowledgment = false;
            throw new Error('Synthetic coupon acknowledgment unavailable');
          }
          await couponService.reportFeeCouponUse(requestId, txSigner.address);
        });
        const { createLiquid, ratchetLiquid, closeLiquid, fissions } = await createLiquidServices(harness, upstream);
        expect(txSigner.address).not.toBe(vault.operatorAccountId);
        const funded = (await BitcoinLock.get(client, lock.lockId!))!;
        const half = funded.fundedSatoshis / 2n;
        const baseRate = await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
        const first = await createLiquid.submit({ allocations: [{ lock, satoshis: half }], txSigner, client });
        await first.waitForPostProcessing;
        const sibling = (await BitcoinFission.get(
          client,
          txSigner.address,
          first.tx.metadataJson.fissions[0].fissionId,
        ))!;

        // A different lower price is already valid within the shared 160 guarantee.
        const lowerRate = await submitBitcoinPrice(harness, { btcUsdPrice: 110_000 });
        const lowerInput = { allocations: [{ lock, satoshis: half / 2n }], txSigner, client };
        const lowerPreview = await createLiquid.preview(lowerInput);
        expect(lowerPreview.maximumSatoshisByLockId[lock.lockId!]).toBe(funded.fundedSatoshis - half);
        expect(lowerPreview.totalSecurityFeeMicrogons).toBe(0n);
        const lower = await createLiquid.submit(lowerInput);
        await lower.waitForPostProcessing;
        expect(
          (await BitcoinFission.get(client, txSigner.address, lower.tx.metadataJson.fissions[0].fissionId))
            ?.microgonsAtTargetPerBtc,
        ).toBe(lowerRate);
        const lowerClose = await closeLiquid.submit({ liquidId: lower.tx.metadataJson.liquidId, txSigner, client });
        await lowerClose.waitForPostProcessing;

        // Lower required coverage at the same BTC rate must retain usable Bitcoin without another fee.
        const lowerCoverageRate = await submitBitcoinPrice(harness, { btcUsdPrice: 120_000, argonUsdPrice: 1.0 });
        expect(lowerCoverageRate).toBe(baseRate);
        const lowerCoverageInput = { allocations: [{ lock, satoshis: half / 2n }], txSigner, client };
        const lowerCoveragePreview = await createLiquid.preview(lowerCoverageInput);
        expect(lowerCoveragePreview.liquidityMicrogons).toBeLessThan(((half / 2n) * baseRate) / SATS_PER_BTC);
        expect(lowerCoveragePreview.totalSecurityFeeMicrogons).toBe(0n);
        expect(lowerCoveragePreview.maximumSatoshisByLockId[lock.lockId!]).toBe(funded.fundedSatoshis - half);
        const feesBeforeDecrease = (await BitcoinLock.get(client, lock.lockId!))!.securityFees;
        const lowerCoverage = await createLiquid.submit(lowerCoverageInput);
        await lowerCoverage.waitForPostProcessing;
        expect(
          await BitcoinFission.get(client, txSigner.address, lowerCoverage.tx.metadataJson.fissions[0].fissionId),
        ).toMatchObject({
          satoshis: half / 2n,
          microgonsAtTargetPerBtc: baseRate,
          liquidityPromised: lowerCoveragePreview.liquidityMicrogons,
        });
        expect((await BitcoinLock.get(client, lock.lockId!))!.securityFees).toBe(feesBeforeDecrease);
        const lowerCoverageClose = await closeLiquid.submit({
          liquidId: lowerCoverage.tx.metadataJson.liquidId,
          txSigner,
          client,
        });
        await lowerCoverageClose.waitForPostProcessing;

        let rate = await submitBitcoinPrice(harness, {
          btcUsdPrice: change === 'price' ? 144_000 : 120_000,
          argonUsdPrice: change === 'coverage' ? 0.795 : 1.06,
        });
        if (change === 'coverage') {
          expect(rate).toBe(baseRate);
          const history = await client.raw.query.bitcoinLocks.microgonPerBtcHistory();
          const samePriceHistory = history.registry.createType(
            history.toRawType(),
            history.filter(([, value]) => value.toBigInt() === baseRate),
          );
          await sudoSubmitAndFinalize(
            client,
            client.tx.system.setStorage([
              [client.raw.query.bitcoinLocks.microgonPerBtcHistory.key(), samePriceHistory.toHex()],
            ]),
          );
        }
        const before = (await BitcoinLock.get(client, lock.lockId!))!;
        const recordsBefore = (await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).map(
          ({ fissionId, liquidId, lockId, microgonsAtTargetPerBtc, liquidityPromised, ratchetNumber }) => ({
            fissionId,
            liquidId,
            lockId,
            microgonsAtTargetPerBtc,
            liquidityPromised,
            ratchetNumber,
          }),
        );
        const nextId = await BitcoinFission.nextId(client, txSigner.address);
        let selectedSatoshis = before.fundedSatoshis - before.fissionedSatoshis;

        if (spec === 160) {
          await expect(
            submitAndFinalize(
              client,
              BitcoinFission.createTx({
                client,
                fissionId: nextId,
                liquidId: nextId,
                lockId: lock.lockId!,
                satoshis: selectedSatoshis,
                microgonsAtTargetPerBtc: rate,
              }),
              txSigner,
              { useLatestNonce: true },
            ),
          ).rejects.toMatchObject({ errorCode: 'bitcoinFissions.InsufficientSecuritization' });
          expect(await BitcoinFission.get(client, txSigner.address, sibling.fissionId)).toEqual(sibling);
          expect(await BitcoinFission.get(client, txSigner.address, nextId)).toBeUndefined();
          expect((await BitcoinLock.get(client, lock.lockId!))?.securityFees).toBe(before.securityFees);
          expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toMatchObject(recordsBefore);
          if (change === 'coverage') {
            // 160 cannot replace the same basis/price solely to increase coverage.
            await expect(
              createLiquid.submit({ allocations: [{ lock, satoshis: selectedSatoshis }], txSigner, client }),
            ).rejects.toThrow('This Bitcoin cannot cover the existing and selected Liquids');
            expect(await BitcoinFission.get(client, txSigner.address, nextId)).toBeUndefined();
            expect(fissions.getAll().map(fission => fission.fissionId)).toEqual([sibling.fissionId]);
            return;
          }
          await expect(
            submitAndFinalize(
              client,
              BitcoinFission.createRatchetTx({ client, fissionId: sibling.fissionId, microgonsAtTargetPerBtc: rate }),
              txSigner,
              { useLatestNonce: true },
            ),
          ).rejects.toMatchObject({ errorCode: 'bitcoinFissions.NoRatchetingAvailable' });
        }

        if (spec === 161 && change === 'coverage') {
          const currentVault = await Vault.get(client, vault.vaultId);
          const availableCollateral = 2_000n;
          await submitAndFinalize(
            client,
            client.tx.vaults.setReservedSecuritizationSpace(
              currentVault.availableSecuritizationSpace(txSigner.address) - availableCollateral,
            ),
            operatorSigner,
          );
          const constrainedPreview = await createLiquid
            .preview({ allocations: [{ lock, satoshis: selectedSatoshis }], txSigner, client })
            .catch((error: unknown) => {
              if (error instanceof BitcoinLiquidCreateStateChangedError) return error;
              throw error;
            });
          expect(constrainedPreview).toBeInstanceOf(BitcoinLiquidCreateStateChangedError);
          expect(constrainedPreview).toMatchObject({
            message: 'The selected vaults can no longer guarantee the full selected Bitcoin amount.',
          });
          const maximumSatoshis = constrainedPreview.maximumSatoshisByLockId[lock.lockId!];
          expect(maximumSatoshis).toBeGreaterThan(0n);
          expect(maximumSatoshis).toBeLessThan(selectedSatoshis);
          await expect(
            submitAndFinalize(
              client,
              BitcoinFission.createTx({
                client,
                fissionId: nextId,
                liquidId: nextId,
                lockId: lock.lockId!,
                satoshis: maximumSatoshis + 1n,
                microgonsAtTargetPerBtc: rate,
              }),
              txSigner,
              { useLatestNonce: true },
            ),
          ).rejects.toMatchObject({ errorCode: 'bitcoinFissions.ResecuritizationFailed' });
          expect(await BitcoinFission.get(client, txSigner.address, nextId)).toBeUndefined();
          expect((await BitcoinLock.get(client, lock.lockId!))?.securityFees).toBe(before.securityFees);
          expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toMatchObject(recordsBefore);
          selectedSatoshis = maximumSatoshis;
        }

        const allocations: Parameters<BitcoinLiquidCreate['submit']>[0]['allocations'] = [
          { lock, satoshis: selectedSatoshis },
        ];
        let preparedRequestId: string | undefined;
        if (change === 'price') {
          // Keep scheduled Liquid mints paused while comparing fixed wallet budgets.
          await submitBitcoinPrice(harness, { btcUsdPrice: 144_000, argonUsdPrice: 1.05 });
          await couponService.create({
            userId: member.id,
            vaultId: vault.vaultId,
            maxSatoshis: funded.fundedSatoshis,
            estimatedGiftUsd: 0.5,
            feeCreditMicrogons: 500_000n,
            expiresAfterTicks: 1_000,
          });
          allocations[0].operatorCoupon = await couponService.activateLatest(member.id, txSigner.address);
          const balance = (await client.query.system.account(txSigner.address)).data.free;
          await sudoSubmitAndFinalize(
            client,
            client.tx.balances.forceSetBalance(txSigner.address, client.consts.balances.existentialDeposit + 100_000n),
          );
          await expect(createLiquid.submit({ allocations, txSigner, client })).rejects.toBeInstanceOf(
            BitcoinLockWalletFundingError,
          );
          const reserved = (await couponService.getByUserId(member.id))[0];
          expect(reserved.uses).toHaveLength(1);
          expect(reserved.uses![0].status).toBe('Prepared');
          preparedRequestId = reserved.uses![0].requestId;
          expect(
            await client.query.bitcoinLocks.lastFeeCouponNonceByVaultAndAccount(vault.vaultId, txSigner.address),
          ).toBeNull();
          expect(await BitcoinFission.get(client, txSigner.address, nextId)).toBeUndefined();
          expect((await BitcoinLock.get(client, lock.lockId!))?.securityFees).toBe(before.securityFees);
          expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toMatchObject(recordsBefore);
          // Repricing the failed-before-submit purchase reauthorizes the same reserved nonce.
          rate = await submitBitcoinPrice(harness, { btcUsdPrice: 145_000, argonUsdPrice: 1.05 });
          allocations[0].operatorCoupon = reserved;

          const maximumPreview = await createLiquid.preview({ allocations, txSigner, client });
          expect(maximumPreview.maximumSatoshisByLockId[lock.lockId!]).toBe(selectedSatoshis);
          const preparedWithGift = await createLiquid.prepare({ allocations, txSigner, client });
          expect(preparedWithGift.unavailableBalance).toBe(maximumPreview.securityFeeMicrogons);
          const walletBudget =
            client.consts.balances.existentialDeposit +
            preparedWithGift.txFeePlusTip +
            preparedWithGift.unavailableBalance! +
            maximumPreview.couponCreditMicrogons / 2n;
          await sudoSubmitAndFinalize(client, client.tx.balances.forceSetBalance(txSigner.address, walletBudget));
          await submitBitcoinPrice(harness, { btcUsdPrice: 145_000, argonUsdPrice: 1.05 });
          const affordableWithGift = await createLiquid.prepare({ allocations, txSigner, client });
          expect(affordableWithGift.availableBalance).toBe(walletBudget);
          expect(affordableWithGift.canAfford).toBe(true);
          await submitBitcoinPrice(harness, { btcUsdPrice: 145_000, argonUsdPrice: 1.05 });
          const preparedWithoutGift = await createLiquid.prepare({
            allocations: [{ lock, satoshis: selectedSatoshis }],
            txSigner,
            client,
          });
          expect(preparedWithoutGift.unavailableBalance).toBe(maximumPreview.totalSecurityFeeMicrogons);
          expect(preparedWithoutGift.availableBalance).toBe(walletBudget);
          expect(preparedWithoutGift.canAfford).toBe(false);
          await sudoSubmitAndFinalize(client, client.tx.balances.forceSetBalance(txSigner.address, balance));
          await submitBitcoinPrice(harness, { btcUsdPrice: 145_000 });
        }
        const beforeVault = await Vault.get(client, vault.vaultId);
        const preview = await createLiquid.preview({ allocations, txSigner, client });
        expect(preview.totalSecurityFeeMicrogons).toBeGreaterThan(0n);
        const selected = await createLiquid.submit({ allocations, txSigner, client });
        if (change === 'price') {
          await expect(selected.waitForPostProcessing).rejects.toThrow('Synthetic coupon acknowledgment unavailable');
          const charged = (await BitcoinLock.get(client, lock.lockId!))!.securityFees;
          createLiquid.resume(selected);
          await selected.waitForPostProcessing;
          expect((await BitcoinLock.get(client, lock.lockId!))!.securityFees).toBe(charged);
        } else await selected.waitForPostProcessing;
        const selectedId = selected.tx.metadataJson.fissions[0].fissionId;
        const native = (await BitcoinFission.get(client, txSigner.address, selectedId))!;
        const after = (await BitcoinLock.get(client, lock.lockId!))!;
        await waitFor(30_000, 'loaded Lock to publish its finalized Liquid allocation', async () => {
          if (
            lock.fissionedSatoshis === after.fissionedSatoshis &&
            lock.securityFees === after.securityFees &&
            lock.securitizationCoverageMicrogons === after.securitizationCoverageMicrogons
          )
            return true;
        });
        expect(await harness.db.bitcoinLocksTable.getByLockId(lock.lockId!)).toMatchObject({
          fissionedSatoshis: after.fissionedSatoshis,
          securityFees: after.securityFees,
          securitizationCoverageMicrogons: after.securitizationCoverageMicrogons,
        });
        expect(native.microgonsAtTargetPerBtc).toBe(rate);
        expect(after.securityFees - before.securityFees).toBe(preview.totalSecurityFeeMicrogons);
        const couponCredit = change === 'price' ? 500_000n : 0n;
        expect(after.couponFeesPaid - before.couponFeesPaid).toBe(couponCredit);
        expect(preview.securityFeeMicrogons).toBe(preview.totalSecurityFeeMicrogons - couponCredit);
        if (change === 'price') {
          const used = (await couponService.getByUserId(member.id))[0];
          expect(used.uses).toHaveLength(1);
          expect(used.uses![0]).toMatchObject({ requestId: preparedRequestId, status: 'Finalized' });
          expect(used.usedFeeCreditMicrogons).toBe(500_000n);
          expect(
            await client.query.bitcoinLocks.lastFeeCouponNonceByVaultAndAccount(vault.vaultId, txSigner.address),
          ).toBe(1n);
        }
        const afterVault = await Vault.get(client, vault.vaultId);
        if (spec === 161) {
          const transferredCoverage =
            before.cosignerGuarantee!.guaranteedMicrogons - after.cosignerGuarantee!.guaranteedMicrogons;
          expect(afterVault.securitizationLocked - beforeVault.securitizationLocked).toBe(
            native.cosignerGuarantee!.guaranteedMicrogons - transferredCoverage,
          );
        } else {
          expect(afterVault.securitizationLocked - beforeVault.securitizationLocked).toBe(
            after.securitizationCollateralMicrogons! - before.securitizationCollateralMicrogons!,
          );
        }
        expect(await BitcoinFission.get(client, txSigner.address, sibling.fissionId)).toEqual(sibling);
        expect(fissions.getAll().find(fission => fission.fissionId === selectedId)).toMatchObject({
          microgonsAtTargetPerBtc: rate,
          liquidityPromised: native.liquidityPromised,
        });
        expect(
          (await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).find(
            fission => fission.fissionId === selectedId,
          ),
        ).toMatchObject({ microgonsAtTargetPerBtc: rate, liquidityPromised: native.liquidityPromised });
        const historicalApi = await harness.miningFrames.blockWatch.getApi(
          await harness.miningFrames.blockWatch.getHeader(selected.tx.blockHeight!),
        );
        const historicalLock = (await getHistoricalBitcoinLockDetails(historicalApi, lock.lockId!))!;
        expect(historicalLock.securityFees).toBe(after.securityFees);
        expect(historicalLock.couponFeesPaid).toBe(after.couponFeesPaid);
        expect(historicalLock.securitizationCoverageMicrogons).toBe(after.securitizationCoverageMicrogons);
        expect(
          fissions.getRecords().find(fission => fission.fissionId === selectedId)?.ratchets[0].netSecurityFee,
        ).toBe(spec === 161 ? preview.securityFeeMicrogons : 0n);
        if (spec === 161) {
          expect(selected.tx.metadataJson.resecuritizations).toEqual([]);
          expect(native.cosignerGuarantee?.guaranteedMicrogons).toBeGreaterThanOrEqual(native.liquidityPromised);
          expect(fissions.getAll().find(fission => fission.fissionId === selectedId)?.cosignerGuarantee).toEqual(
            native.cosignerGuarantee,
          );
        } else expect(selected.tx.metadataJson.resecuritizations).toHaveLength(1);

        if (change === 'price') {
          const invalid = await ratchetLiquid.submit({
            liquidId: native.liquidId,
            microgonsAtTargetPerBtc: 1n,
            txSigner,
            client,
          });
          await expect(invalid.waitForPostProcessing).rejects.toThrow();
          expect(await BitcoinFission.get(client, txSigner.address, selectedId)).toEqual(native);
          expect(await BitcoinFission.get(client, txSigner.address, sibling.fissionId)).toEqual(sibling);
          expect((await BitcoinLock.get(client, lock.lockId!))?.securityFees).toBe(after.securityFees);
          await couponService.create({
            userId: member.id,
            vaultId: vault.vaultId,
            maxSatoshis: funded.fundedSatoshis,
            estimatedGiftUsd: 0.2,
            feeCreditMicrogons: 200_000n,
            expiresAfterTicks: 1_000,
          });
          const ratchetGift = await couponService.activateLatest(member.id, txSigner.address);
          const higherRate = await submitBitcoinPrice(harness, { btcUsdPrice: 172_800 });
          const input = { liquidId: native.liquidId, microgonsAtTargetPerBtc: higherRate, txSigner, client };
          const prepared = await ratchetLiquid.prepare(input);
          const beforeRatchet = (await BitcoinLock.get(client, lock.lockId!))!;
          const ratchet = await ratchetLiquid.submit(input, prepared);
          await ratchet.waitForPostProcessing;
          const afterRatchet = (await BitcoinLock.get(client, lock.lockId!))!;
          const ratchetFee = afterRatchet.securityFees - beforeRatchet.securityFees;
          expect(ratchetFee).toBeGreaterThan(0n);
          expect(afterRatchet.couponFeesPaid - beforeRatchet.couponFeesPaid).toBe(200_000n);
          expect(prepared.unavailableBalance).toBe(ratchetFee - 200_000n);
          if (spec === 161) {
            expect(
              fissions
                .getRecords()
                .find(fission => fission.fissionId === selectedId)
                ?.ratchets.at(-1)?.netSecurityFee,
            ).toBe(ratchetFee - 200_000n);
          }
          const usedRatchetGift = (await couponService.getByUserId(member.id)).find(
            gift => gift.coupon.id === ratchetGift.coupon.id,
          )!;
          expect(usedRatchetGift.uses).toHaveLength(1);
          expect(usedRatchetGift.uses![0].status).toBe('Finalized');
          expect(usedRatchetGift.usedFeeCreditMicrogons).toBe(200_000n);
          expect(
            await client.query.bitcoinLocks.lastFeeCouponNonceByVaultAndAccount(vault.vaultId, txSigner.address),
          ).toBe(2n);
          await waitFor(30_000, 'loaded Lock to publish its finalized ratchet fee', async () => {
            if (
              lock.securityFees === afterRatchet.securityFees &&
              lock.securitizationCoverageMicrogons === afterRatchet.securitizationCoverageMicrogons
            )
              return true;
          });
          expect((await BitcoinFission.get(client, txSigner.address, selectedId))?.ratchetNumber).toBe(1);
          expect(await BitcoinFission.get(client, txSigner.address, sibling.fissionId)).toEqual(sibling);
          expect(fissions.getAll().find(fission => fission.fissionId === selectedId)?.microgonsAtTargetPerBtc).toBe(
            higherRate,
          );
        }
        const beforeClose = (await BitcoinLock.get(client, lock.lockId!))!;
        const close = await closeLiquid.submit({ liquidId: native.liquidId, txSigner, client });
        await close.waitForPostProcessing;
        expect(await BitcoinFission.get(client, txSigner.address, selectedId)).toBeUndefined();
        expect(await BitcoinFission.get(client, txSigner.address, sibling.fissionId)).toEqual(sibling);
        expect(fissions.getLiquids().find(liquid => liquid.liquidId === native.liquidId)?.isClosed).toBe(true);
        const closed = (await BitcoinLock.get(client, lock.lockId!))!;
        expect(closed.securityFees).toBe(beforeClose.securityFees);
        expect(closed.couponFeesPaid).toBe(beforeClose.couponFeesPaid);
        expect(closed.fissionedSatoshis).toBe(sibling.satoshis);
        await waitFor(30_000, 'loaded Lock to publish its returned guarantee', async () => {
          if (
            lock.fissionedSatoshis === closed.fissionedSatoshis &&
            lock.securitizationCoverageMicrogons === closed.securitizationCoverageMicrogons
          )
            return true;
        });
        expect(await harness.db.bitcoinLocksTable.getByLockId(lock.lockId!)).toMatchObject({
          fissionedSatoshis: closed.fissionedSatoshis,
          securityFees: closed.securityFees,
          securitizationCoverageMicrogons: closed.securitizationCoverageMicrogons,
        });
        const replay = new BitcoinFissionRecovery(Promise.resolve(harness.db), txSigner.address);
        await replay.beginHistoryReplay({ replace: true });
        for (let blockNumber = first.tx.blockHeight!; blockNumber <= close.tx.blockHeight!; blockNumber += 1) {
          const block = await harness.miningFrames.blockWatch.getHeader(blockNumber);
          const { events } = await harness.miningFrames.blockWatch.getEventsWithSpec(block);
          await replay.recoverBlock(block, events);
        }
        const recovered = await replay.prepareHistoryReplay();
        expect([...recovered.failuresByLockId.values()]).toEqual([]);
        const selectedHistory = recovered.records.find(record => record.fissionId === selectedId)!;
        const storedHistory = (await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).find(
          record => record.fissionId === selectedId,
        )!;
        expect(selectedHistory.ratchets.map(ratchet => ratchet.netSecurityFee)).toEqual(
          storedHistory.ratchets.map(ratchet => ratchet.netSecurityFee),
        );
        expect(selectedHistory.closedAtArgonBlock).toBe(storedHistory.closedAtArgonBlock);
        expect(selectedHistory.ratchets[0].netSecurityFee).toBe(spec === 161 ? preview.securityFeeMicrogons : 0n);
        await replay.finishHistoryReplay();
        if (spec === 161)
          expect(closed.cosignerGuarantee!.guaranteedMicrogons).toBeGreaterThan(
            beforeClose.cosignerGuarantee!.guaranteedMicrogons,
          );
      } finally {
        await docker.unpauseOne('bitcoin-miner', composeOptions);
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000, argonUsdPrice: 1.06 });
        routerDb.close();
        await cleanupBitcoinLocksHarness(harness);
      }
    },
  );

  // prettier-ignore
  it.runIf(runtimeSpec === 160).each([false, true])('handles an expired higher Lock price with existing Liquids: %s', { tags: ['exclusive-argon-network'] }, async hasExistingLiquid => {
    const harness = await createHarness();
    const client = await harness.clients.get(false);
    let restorePriceHistory: string | undefined;

    try {
      await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
      const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 10n);
      const { createLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
      const coveredSatoshis = lock.securitizedSatoshis;

      if (hasExistingLiquid) {
        // Publish a fresh occurrence of the original rate after the Bitcoin funding wait.
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_001 });
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
        const firstCreation = await createLiquid.submit({
          allocations: [{ lock, satoshis: coveredSatoshis / 2n }],
          txSigner,
          client,
        });
        await firstCreation.waitForPostProcessing;
      }
      const existingFissions = await BitcoinFission.getAllByOwner(client, txSigner.address);
      const fundingAddress = harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
      sendBitcoinToAddress(fundingAddress, coveredSatoshis);
      generateBlocks(8, minerAddress);
      const fundedLock = await waitFor(90_000, 'additional finalized Lock funding', async () => {
        const snapshot = await getFinalizedClient(client);
        const current = await BitcoinLock.get(snapshot, lock.lockId!);
        return current?.fundedSatoshis === coveredSatoshis * 2n ? current : undefined;
      });
      await harness.bitcoinLocks.syncCurrentLocks({ requireComplete: true });

      const eligibleRate = await submitBitcoinPrice(harness, { btcUsdPrice: 110_000 });
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
      const snapshot = await getFinalizedClient(client);
      expect((await snapshot.query.bitcoinLocks.microgonPerBtcHistory())?.some(([, rate]) => rate === fundedLock.microgonsAtTargetPerBtc)).toBe(false);

      const retainedSatoshis = coveredSatoshis - fundedLock.fissionedSatoshis;
      const retainedPreview = await createLiquid.preview({
        allocations: [{ lock, satoshis: retainedSatoshis }],
        txSigner,
        client,
      });
      expect(retainedPreview.maximumSatoshisByLockId[lock.lockId!]).toBe(
        hasExistingLiquid ? retainedSatoshis : fundedLock.fundedSatoshis,
      );
      expect(retainedPreview.totalSecurityFeeMicrogons).toBe(0n);

      let satoshis = fundedLock.fundedSatoshis - fundedLock.fissionedSatoshis;
      if (hasExistingLiquid) {
        await expect(createLiquid.preview({ allocations: [{ lock, satoshis }], txSigner, client })).rejects.toThrow(
          'Existing Liquids need a Bitcoin price that is no longer available',
        );
        expect(await BitcoinFission.getAllByOwner(client, txSigner.address)).toEqual(existingFissions);
        satoshis = coveredSatoshis - fundedLock.fissionedSatoshis;
      }

      const creation = await createLiquid.submit({ allocations: [{ lock, satoshis }], txSigner, client });
      await creation.waitForPostProcessing;
      const currentLock = await BitcoinLock.get(client, lock.lockId!);
      const currentFissions = await BitcoinFission.getAllByOwner(client, txSigner.address);
      expect(currentLock?.fissionedSatoshis).toBe(hasExistingLiquid ? coveredSatoshis : coveredSatoshis * 2n);
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
  it.runIf(runtimeSpec === 160)('selects an eligible higher rate that preserves curve-adjusted existing Liquid coverage', { tags: ['exclusive-argon-network'] }, async () => {
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
      await submitBitcoinPrice(harness, { btcUsdPrice: 120_000, argonUsdPrice: 0.795 });
      const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 10n);
      await submitBitcoinPrice(harness, { btcUsdPrice: 120_001, argonUsdPrice: 0.795 });
      await submitBitcoinPrice(harness, { btcUsdPrice: 120_000, argonUsdPrice: 0.795 });
      const { createLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
      const coveredSatoshis = lock.securitizedSatoshis;
      const firstCreation = await createLiquid.submit({
        allocations: [{ lock, satoshis: coveredSatoshis * 9n / 10n }], txSigner, client,
      });
      await firstCreation.waitForPostProcessing;
      const existingFission = (await BitcoinFission.getAllByOwner(client, txSigner.address))[0];
      sendBitcoinToAddress(harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex), coveredSatoshis);
      generateBlocks(8, minerAddress);
      await waitFor(90_000, 'additional finalized Lock funding', async () => {
        const snapshot = await getFinalizedClient(client);
        return (await BitcoinLock.get(snapshot, lock.lockId!))?.fundedSatoshis === coveredSatoshis * 2n;
      });
      await harness.bitcoinLocks.syncCurrentLocks({ requireComplete: true });

      const higherRate = await submitBitcoinPrice(harness, { btcUsdPrice: 132_000 });
      const currentRate = await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
      const snapshot = await getFinalizedClient(client);
      const priceIndex = await Currency.fetchPriceIndex(snapshot);
      const satoshis = coveredSatoshis / 5n;
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
      await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
      await cleanupBitcoinLocksHarness(harness);
    }
  });

  // prettier-ignore
  it.runIf(runtimeSpec === 160)('uses the eligible existing Lock price when a newer higher price exceeds vault capacity', { tags: ['exclusive-argon-network'] }, async () => {
    const harness = await createHarness();
    const client = await harness.clients.get(false);

    try {
      const coverageRate = await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
      const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 2n);
      await submitBitcoinPrice(harness, { btcUsdPrice: 120_001 });
      await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
      const { createLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
      const coveredSatoshis = lock.securitizedSatoshis;
      const satoshis = coveredSatoshis * 9n / 10n;
      const firstCreation = await createLiquid.submit({ allocations: [{ lock, satoshis }], txSigner, client });
      await firstCreation.waitForPostProcessing;
      const existingFission = (await BitcoinFission.getAllByOwner(client, txSigner.address))[0];
      sendBitcoinToAddress(harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex), coveredSatoshis);
      generateBlocks(8, minerAddress);
      await waitFor(90_000, 'additional finalized Lock funding', async () => {
        const snapshot = await getFinalizedClient(client);
        return (await BitcoinLock.get(snapshot, lock.lockId!))?.fundedSatoshis === coveredSatoshis * 2n;
      });
      await harness.bitcoinLocks.syncCurrentLocks({ requireComplete: true });

      await submitBitcoinPrice(harness, { btcUsdPrice: 180_000 });
      await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
      const higherRate = await submitBitcoinPrice(harness, { btcUsdPrice: 180_000 });
      const currentRate = await submitBitcoinPrice(harness, { btcUsdPrice: 110_000 });
      const snapshot = await getFinalizedClient(client);
      const currentLock = (await BitcoinLock.get(snapshot, lock.lockId!))!;
      const vault = await Vault.get(snapshot, lock.vaultId, NetworkConfig.tickMillis);
      const priceIndex = await Currency.fetchPriceIndex(snapshot);
      const availableCoverage = currentLock.securitizationCoverageMicrogons + vault.availableBitcoinSpace(txSigner.address);
      const securitizedSatoshis = existingFission.satoshis + satoshis;
      expect(BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis: securitizedSatoshis, microgonsAtTargetPerBtc: coverageRate })).toBeLessThanOrEqual(availableCoverage);
      expect(BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis: securitizedSatoshis, microgonsAtTargetPerBtc: higherRate })).toBeGreaterThan(availableCoverage);

      const creation = await createLiquid.submit({ allocations: [{ lock, satoshis }], txSigner, client });
      await creation.waitForPostProcessing;
      expect((await BitcoinLock.get(client, lock.lockId!))?.microgonsAtTargetPerBtc).toBe(coverageRate);
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
        { lockId: firstLock.lockId, satoshis: allocations[0].satoshis },
        { lockId: secondLock.lockId, satoshis: allocations[1].satoshis },
      ]);

      const [firstCurrentLock, secondCurrentLock] = await BitcoinLock.getMany(client, [
        firstLock.lockId!,
        secondLock.lockId!,
      ]);
      expect(firstCurrentLock?.fissionedSatoshis).toBe(allocations[0].satoshis);
      expect(secondCurrentLock?.fissionedSatoshis).toBe(allocations[1].satoshis);
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
    'preserves funded Liquid coverage beyond the partially funded Lock hold',
    { tags: ['exclusive-argon-network'] },
    async () => {
      const harness = await createHarness(
        createMockWalletKeys(
          integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'partial-funding'),
        ),
      );
      const client = await harness.clients.get(false);

      try {
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
        const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 10n, {
          fundingPercent: 50,
        });
        const snapshot = await getFinalizedClient(client);
        const coveredLock = (await BitcoinLock.get(snapshot, lock.lockId!))!;
        const fundedSatoshis = coveredLock.fundedSatoshis;
        const oldHoldHeight = coveredLock.securitizationHoldExpirationBitcoinHeight;
        if (oldHoldHeight === null) throw new Error('The partially funded Lock must retain its funding hold.');
        expect(coveredLock.cosignerGuarantee!.basis.satoshis).toBeGreaterThan(fundedSatoshis);
        if (runtimeSpec === 160) {
          await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
          const { createLiquid, ratchetLiquid, fissions } = await createLiquidServices(harness);
          const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
          const creation = await createLiquid.submit({
            allocations: [{ lock, satoshis: fundedSatoshis }],
            txSigner,
            client,
          });
          await creation.waitForPostProcessing;
          const available = (await Vault.get(client, lock.vaultId)).availableBitcoinSpace(txSigner.address);
          const parking = await harness.bitcoinLockCreate.submit({
            vault: await Vault.get(client, lock.vaultId),
            satoshis: await harness.bitcoinLocks.satoshisForArgonLiquidity(available - 10_000n),
            txSigner,
            client,
          });
          await parking.waitForPostProcessing;
          const rate = await submitBitcoinPrice(harness, { btcUsdPrice: 144_000 });
          const constrained = await getFinalizedClient(client);
          const priceIndex = await Currency.fetchPriceIndex(constrained);
          const requiredCoverage = BitcoinLock.calculateLiquidityPromised({
            priceIndex,
            satoshis: fundedSatoshis,
            microgonsAtTargetPerBtc: rate,
          });
          const spare = (await Vault.get(constrained, lock.vaultId)).availableBitcoinSpace(txSigner.address);
          expect(requiredCoverage).toBeGreaterThan(coveredLock.securitizationCoverageMicrogons + spare);
          expect(requiredCoverage).toBeLessThan(coveredLock.cosignerGuarantee!.guaranteedMicrogons);
          const preview = await ratchetLiquid.previewRatchet(
            creation.tx.metadataJson.liquidId,
            rate,
            constrained,
            priceIndex,
          );
          expect(preview.canRatchet).toBe(true);
          const ratchet = await ratchetLiquid.submit({
            liquidId: creation.tx.metadataJson.liquidId,
            microgonsAtTargetPerBtc: rate,
            txSigner,
            client,
          });
          await ratchet.waitForPostProcessing;
          const current = (await BitcoinLock.get(client, lock.lockId!))!;
          expect(current.securityFees).toBe(coveredLock.securityFees);
          const bitcoinHeight = (await client.query.bitcoinUtxos.confirmedBitcoinBlockTip())!.blockHeight;
          generateBlocks(Math.max(1, oldHoldHeight - bitcoinHeight + 8), minerAddress);
          await waitFor(90_000, 'old partial-funding hold boundary', async () => {
            const tip = await client.query.bitcoinUtxos.confirmedBitcoinBlockTip();
            if (tip && tip.blockHeight > oldHoldHeight) return true;
          });
          expect((await BitcoinFission.getAllByOwner(client, txSigner.address))[0]).toMatchObject({
            liquidityPromised: requiredCoverage,
            ratchetNumber: 1,
          });
          expect(fissions.getAll()[0].liquidityPromised).toBe(requiredCoverage);
          return;
        }
        const rate = await submitBitcoinPrice(harness, { btcUsdPrice: 120_000, argonUsdPrice: 0.795 });
        expect(rate).toBe(coveredLock.cosignerGuarantee!.basis.microgonsAtTargetPerBtc);
        const { createLiquid, fissions } = await createLiquidServices(harness);
        const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
        const allocations = [{ lock, satoshis: fundedSatoshis }];
        const preview = await createLiquid.preview({ allocations, txSigner, client });
        expect(preview.securityFeeMicrogons).toBe(0n);
        if (runtimeSpec === 161) expect(preview.totalSecurityFeeMicrogons).toBeGreaterThan(0n);
        else expect(preview.totalSecurityFeeMicrogons).toBe(0n);
        const creation = await createLiquid.submit({ allocations, txSigner, client });
        await creation.waitForPostProcessing;

        const finalized = await getFinalizedClient(client);
        const current = (await BitcoinLock.get(finalized, lock.lockId!))!;
        const created = await BitcoinFission.getAllByOwner(finalized, txSigner.address);
        expect(creation.tx.metadataJson.resecuritizations).toEqual([]);
        const fissionGuarantee = created[0].cosignerGuarantee!;
        expect(fissionGuarantee.guaranteedMicrogons).toBeGreaterThanOrEqual(created[0].liquidityPromised);
        const transferred =
          (coveredLock.cosignerGuarantee!.guaranteedMicrogons * fundedSatoshis) /
          coveredLock.cosignerGuarantee!.basis.satoshis;
        expect(current.cosignerGuarantee!.guaranteedMicrogons).toBe(
          coveredLock.cosignerGuarantee!.guaranteedMicrogons - transferred,
        );
        expect(current.securityFees - coveredLock.securityFees).toBe(preview.totalSecurityFeeMicrogons);
        const bitcoinHeight = (await finalized.query.bitcoinUtxos.confirmedBitcoinBlockTip())!.blockHeight;
        generateBlocks(Math.max(1, oldHoldHeight - bitcoinHeight + 8), minerAddress);
        await waitFor(90_000, 'old partial-funding hold boundary', async () => {
          const snapshot = await getFinalizedClient(client);
          const tip = await snapshot.query.bitcoinUtxos.confirmedBitcoinBlockTip();
          return tip && tip.blockHeight > oldHoldHeight;
        });
        const afterHold = await getFinalizedClient(client);
        expect((await BitcoinFission.getAllByOwner(afterHold, txSigner.address))[0].cosignerGuarantee).toEqual(
          created[0].cosignerGuarantee,
        );
        expect((await BitcoinFission.getAllByOwner(afterHold, txSigner.address))[0].liquidityPromised).toBe(
          created[0].liquidityPromised,
        );
        expect(fissions.getLiquids().some(liquid => liquid.liquidId === creation.tx.metadataJson.liquidId)).toBe(true);
        expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toHaveLength(1);
      } finally {
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
        await cleanupBitcoinLocksHarness(harness);
      }
    },
  );

  it.runIf(runtimeSpec === 160).each([false, true])(
    'creates a smaller Liquid when all remaining Bitcoin exceeds coverage, with integer rounding: %s',
    { tags: ['exclusive-argon-network'] },
    async hasRoundingBoundary => {
      const harness = await createHarness();
      const client = await harness.clients.get(false);
      let restorePriceHistory: string | undefined;
      try {
        const startingBitcoinPrice = hasRoundingBoundary ? 110_327.92353274 : 120_000;
        await submitBitcoinPrice(harness, { btcUsdPrice: startingBitcoinPrice, argonUsdPrice: 0.795 });
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
            harness.myVault.createdVault!.buildModifyFundingTx(client, 100_000_000n),
            vaultSigner,
            { useLatestNonce: true },
          );
        }
        const initialSnapshot = await getFinalizedClient(client);
        const initialPrice = await Currency.fetchPriceIndex(initialSnapshot);
        const liquidity = hasRoundingBoundary
          ? BitcoinLock.calculateLiquidityPromised({ priceIndex: initialPrice, satoshis: 50_008n })
          : harness.myVault.createdVault!.availableBitcoinSpace() / 10n;
        const lock = await createFundedLock(harness, liquidity);
        await submitBitcoinPrice(harness, { btcUsdPrice: startingBitcoinPrice + 1, argonUsdPrice: 0.795 });
        await submitBitcoinPrice(harness, { btcUsdPrice: startingBitcoinPrice, argonUsdPrice: 0.795 });
        const coveredSatoshis = lock.securitizedSatoshis;
        const { createLiquid, fissions } = await createLiquidServices(harness);
        const txSigner = await harness.walletKeys.getLiquidLockingKeypair();
        const firstCreation = await createLiquid.submit({
          allocations: [{ lock, satoshis: coveredSatoshis / 2n }],
          txSigner,
          client,
        });
        await firstCreation.waitForPostProcessing;
        const existingFission = (await BitcoinFission.getAllByOwner(client, txSigner.address))[0];
        const additionalSatoshis = hasRoundingBoundary ? 5_000n : 0n;
        if (additionalSatoshis) {
          expect(coveredSatoshis).toBe(50_008n);
          sendBitcoinToAddress(
            harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex),
            additionalSatoshis,
          );
          generateBlocks(8, minerAddress);
          await waitFor(90_000, 'additional finalized rounding-boundary funding', async () => {
            const snapshot = await getFinalizedClient(client);
            return (
              (await BitcoinLock.get(snapshot, lock.lockId!))?.fundedSatoshis === coveredSatoshis + additionalSatoshis
            );
          });
          await harness.bitcoinLocks.syncCurrentLocks({ requireComplete: true });
        }
        const rate = await submitBitcoinPrice(harness, { btcUsdPrice: hasRoundingBoundary ? 120_000 : 121_200 });
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
        const snapshot = await getFinalizedClient(client);
        const priceIndex = await Currency.fetchPriceIndex(snapshot);
        const satoshis = hasRoundingBoundary ? 25_015n : (coveredSatoshis * 3n) / 10n;
        const coverage = BitcoinLock.calculateLiquidityPromised({
          priceIndex,
          satoshis:
            coveredSatoshis > existingFission.satoshis + satoshis
              ? coveredSatoshis
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
            satoshis: coveredSatoshis + additionalSatoshis - existingFission.satoshis,
            microgonsAtTargetPerBtc: rate,
          });
        const allRemainingCoverage = BitcoinLock.calculateLiquidityPromised({
          priceIndex,
          satoshis: coveredSatoshis + additionalSatoshis,
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
            allocations: [{ lock, satoshis: coveredSatoshis + additionalSatoshis - existingFission.satoshis }],
            txSigner,
            client,
          }),
        ).rejects.toThrow('This Bitcoin cannot cover the existing and selected Liquids at the current price.');
        const allocations = [{ lock, satoshis }];
        const preview = await createLiquid.preview({ allocations, txSigner, client });
        expect(preview.maximumSatoshisByLockId[lock.lockId!]).toBeGreaterThanOrEqual(satoshis);
        const creation = await createLiquid.submit({ allocations, txSigner, client });
        await creation.waitForPostProcessing;
        const finalized = await getFinalizedClient(client);
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
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
        await cleanupBitcoinLocksHarness(harness);
      }
    },
  );

  it.runIf(runtimeSpec === 160)(
    'uses coverage released by an earlier Lock to create a Liquid from two Locks',
    { tags: ['exclusive-argon-network'] },
    async () => {
      const harness = await createHarness();
      const client = await harness.clients.get(false);
      let restorePriceHistory: string | undefined;

      try {
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
        const first = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 3n);
        const firstSatoshis = first.securitizedSatoshis;
        const firstCoverage = first.securitizationCoverageMicrogons!;
        const rate = await submitBitcoinPrice(harness, { btcUsdPrice: 40_000 });
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
          const snapshot = await getFinalizedClient(client);
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
        const snapshot = await getFinalizedClient(client);
        const vault = await Vault.get(snapshot, first.vaultId, NetworkConfig.tickMillis);
        await submitAndFinalize(
          client,
          client.tx.vaults.setReservedSecuritizationSpace(vault.availableSecuritizationSpace()),
          await harness.walletKeys.getVaultingKeypair(),
          { useLatestNonce: true },
        );
        const constrained = await getFinalizedClient(client);
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
        await submitBitcoinPrice(harness, { btcUsdPrice: 40_000 });
        const creation = await createLiquid.submit({ allocations, txSigner, client });
        await creation.waitForPostProcessing;
        const finalized = await getFinalizedClient(client);
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
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
        await cleanupBitcoinLocksHarness(harness);
      }
    },
  );

  it.runIf(runtimeSpec === 160)(
    'creates a Liquid within retained cosigner guarantee when a new purchase would exceed Vault capacity',
    { tags: ['exclusive-argon-network'] },
    async () => {
      const harness = await createHarness();
      const client = await harness.clients.get(false);

      try {
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
        const lock = await createFundedLock(harness, harness.myVault.createdVault!.availableBitcoinSpace() / 10n);
        const storedCoverage = lock.securitizationCoverageMicrogons!;
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000, argonUsdPrice: 0.795 });
        const snapshot = await getFinalizedClient(client);
        const vault = await Vault.get(snapshot, lock.vaultId, NetworkConfig.tickMillis);
        await submitAndFinalize(
          client,
          client.tx.vaults.setReservedSecuritizationSpace(vault.availableSecuritizationSpace()),
          await harness.walletKeys.getVaultingKeypair(),
          { useLatestNonce: true },
        );
        const constrained = await getFinalizedClient(client);
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
        const finalized = await getFinalizedClient(client);
        expect((await BitcoinLock.get(finalized, lock.lockId!))?.securitizationCoverageMicrogons).toBe(storedCoverage);
        expect((await BitcoinFission.getAllByOwner(finalized, txSigner.address))[0].satoshis).toBe(satoshis);
        expect(fissions.getLiquids().some(liquid => liquid.liquidId === creation.tx.metadataJson.liquidId)).toBe(true);
        expect(await harness.db.bitcoinFissionsTable.fetchAll(txSigner.address)).toHaveLength(1);
      } finally {
        await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
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

      const beforeFinalization = await getFinalizedClient(client);
      expect((await BitcoinLock.get(beforeFinalization, lock.lockId!))?.fundedSatoshis ?? 0n).toBe(0n);

      await actor.ensureOperationalLiquid({ client });
      const finalizedClient = await getFinalizedClient(client);
      const fissions = await BitcoinFission.getAllByOwner(finalizedClient, walletKeys.defaultArgonAddress);
      expect(fissions).toHaveLength(1);
      expect(fissions[0]).toMatchObject({
        lockId: lock.lockId,
        satoshis: lock.fundedSatoshis,
      });

      await actor.dispose();
      actor = undefined;
      actor = await AppVaultOperator.load({
        clients: harness.clients,
        walletKeys,
        networkConfigOverride: network.networkConfigOverride,
      });
      await actor.ensureOperationalLiquid({ client });

      const restoredClient = await getFinalizedClient(client);
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
      await submitBitcoinPrice(harness, { btcUsdPrice: 120_000 });
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const lock = await createFundedLock(harness, targetLiquidity);
      await submitBitcoinPrice(harness, { btcUsdPrice: 121_000 });
      const { createLiquid, ratchetLiquid, fissions } = await createLiquidServices(harness);
      const satoshis = lock.securitizedSatoshis;
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();

      const createTxInfo = await createLiquid.submit({
        allocations: [{ lock, satoshis: satoshis }],
        txSigner,
        client,
      });
      await createTxInfo.txResult.waitForFinalizedBlock;
      await createTxInfo.waitForPostProcessing;

      const initialFission = await BitcoinFission.get(client, txSigner.address, 0);
      if (!initialFission) throw new Error('Finalized Liquid was not published by the runtime.');

      const unsupportedRate = await submitBitcoinPrice(harness, {
        btcUsdPrice: 1_500_000,
      });
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      harness.vaults.operatorNamesByVaultId[lock.vaultId] = 'Testing';
      const unsupportedPreview = await ratchetLiquid.previewRatchet(
        initialFission.liquidId,
        unsupportedRate,
        await getFinalizedClient(client),
        harness.currency.priceIndex,
      );
      expect(unsupportedPreview.canRatchet).toBe(false);
      expect(unsupportedPreview.errors).toEqual([
        'Testing does not have enough available securitization for this ratchet.',
      ]);

      const ratchetRate = await submitBitcoinPrice(harness, {
        btcUsdPrice: 150_000,
      });
      await harness.currency.fetchMainchainRates(client, { ignoreCache: true });
      const snapshotClient = await getFinalizedClient(client);
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
        lockChanges: runtimeSpec === 161 ? [] : [
          {
            lockId: lock.lockId,
            phase: 'before-fissions',
            securitizedSatoshis: satoshis,
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
        resecuritizedLockIds: runtimeSpec === 161 ? [] : [lock.lockId],
      });
      const ratchetedFission = await BitcoinFission.get(client, txSigner.address, initialFission.fissionId);
      expect(ratchetedFission).toMatchObject({
        liquidId: initialFission.liquidId,
        fissionId: initialFission.fissionId,
        lockId: lock.lockId,
        satoshis: satoshis,
        microgonsAtTargetPerBtc: ratchetRate,
        liquidityPromised: preview.newLiquidity,
        ratchetNumber: 1,
      });

      const currentLock = await BitcoinLock.get(client, lock.lockId!);
      expect(currentLock).toMatchObject({
        securitizedSatoshis: runtimeSpec === 161 ? 0n : satoshis,
        fissionedSatoshis: satoshis,
      });
      if (runtimeSpec === 160) expect(currentLock?.microgonsAtTargetPerBtc).toBe(ratchetRate);
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
      const fundedSatoshis = (await BitcoinLock.get(client, lock.lockId!))!.fundedSatoshis;
      const { createLiquid, closeLiquid, fissions } = await createLiquidServices(harness);
      const txSigner = await harness.walletKeys.getLiquidLockingKeypair();

      const createTxInfo = await createLiquid.submit({
        allocations: [{ lock, satoshis: fundedSatoshis }],
        txSigner,
        client,
      });
      await createTxInfo.txResult.waitForFinalizedBlock;
      await createTxInfo.waitForPostProcessing;

      const fission = await BitcoinFission.get(client, txSigner.address, 0);
      if (!fission) throw new Error('Finalized Liquid was not published by the runtime.');
      const finalizedClient = await getFinalizedClient(client);
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
        fundedSatoshis,
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
  harness: BitcoinLocksHarness,
  args: { btcUsdPrice: number; argonUsdPrice?: number },
): Promise<bigint> {
  const { btcUsdPrice, argonUsdPrice = 1.06 } = args;
  const client = await harness.clients.get(false);
  const initialSnapshot = await getFinalizedClient(client);
  const currentPrice = await initialSnapshot.query.priceIndex.current();
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
    const snapshotClient = await harness.miningFrames.blockWatch.getFinalizedApi();
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
    vault?: Vault;
  } = {},
): Promise<IBitcoinLockRecord> {
  const { verifyRestoredCreation = false, waitForFinalizedFunding = true, onCreated, fundingPercent = 100 } = args;
  const vault = args.vault ?? harness.myVault.createdVault!;
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
    const snapshotClient = waitForFinalizedFunding ? await getFinalizedClient(client) : client;
    const current = await BitcoinLock.get(snapshotClient, lock.lockId!);
    if (current?.fundedSatoshis !== fundedSatoshis) return;
    return current;
  });
  return lock;
}

async function createLiquidServices(
  harness: BitcoinLocksHarness,
  providedUpstream?: UpstreamOperatorClient,
): Promise<{
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
  const upstreamOperatorClient = providedUpstream ?? new UpstreamOperatorClient();
  if (!providedUpstream) vi.spyOn(upstreamOperatorClient, 'getBitcoinLockCoupons').mockResolvedValue([]);
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
    harness.miningFrames.blockWatch,
  );
  const ratchetLiquid = new BitcoinLiquidRatchet(
    fissions,
    harness.transactionTracker,
    harness.currency,
    harness.bitcoinLocks,
    harness.vaults,
    resecuritize,
    upstreamOperatorClient,
    harness.miningFrames.blockWatch,
  );
  const closeLiquid = new BitcoinLiquidClose(
    fissions,
    harness.transactionTracker,
    harness.currency,
    harness.miningFrames.blockWatch,
  );
  await Promise.all([createLiquid.load(), ratchetLiquid.load(), closeLiquid.load()]);
  return { createLiquid, ratchetLiquid, closeLiquid, fissions };
}
