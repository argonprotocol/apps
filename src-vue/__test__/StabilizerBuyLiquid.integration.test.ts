import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, inject, it, vi } from 'vitest';
import { Contract, JsonRpcProvider, Wallet, type ContractTransactionResponse } from 'ethers';
import BigNumber from 'bignumber.js';
import { erc20Abi, getAddress } from 'viem';
import { TestEthereum } from '@argonprotocol/testing';
import { BitcoinLock, NetworkConfig } from '@argonprotocol/apps-core';
import { DelegateSubmitLane, EthereumBeaconSyncService, EthereumGatewayProverService } from '@argonprotocol/apps-bot';
import { integrationAccountUri } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { generateBlocks, sendBitcoinToAddress } from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import {
  createDevEthereumSetup,
  DEV_ETHEREUM_ADMIN_ACCOUNT,
  readDevEthereumRuntimeState,
  startDevEthereum,
} from '../../e2e/devEthereum.ts';
import { setDevEthereumPoolPrice } from '../../e2e/devEthereumStabilization.ts';
import { BitcoinFissions } from '../lib/BitcoinFissions.ts';
import { EthereumClient } from '../lib/EthereumClient.ts';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { BitcoinLiquidCreate } from '../lib/txs/BitcoinLiquid.create.ts';
import { BitcoinLockResecuritize } from '../lib/txs/BitcoinLock.resecuritize.ts';
import { StabilizerBuyStatus } from '../interfaces/IStabilizerBuyPurchase.ts';
import {
  getStabilizerBuyReturnedSatoshis,
  projectStabilizerBuyLiquidPaydown,
} from '../lib/financials/StabilizerBuys.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import {
  cleanupBitcoinLocksHarness,
  createBitcoinLocksHarness,
  defaultVaultSetup,
} from './helpers/bitcoinLocksHarness.ts';

describe('Stabilizer Buy Liquid settlement', { tags: ['isolated-argon-network'] }, () => {
  it('buys with a permit, admits the Liquid, and settles the best rate with fixed BTC returned', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'stabilizer-liquid-'));
    const priceFile = path.join(directory, 'prices.json');
    const oraclePrices = JSON.parse(
      await readFile(new URL('../../e2e/argon/oracle/test-price-index.json', import.meta.url), 'utf8'),
    );
    await writeFile(priceFile, JSON.stringify(oraclePrices));
    vi.stubEnv('ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR', directory);
    vi.stubEnv('PRICE_INDEX_FILE_PATH', priceFile);
    let network: Awaited<ReturnType<typeof startArgonTestNetwork>> | undefined;
    let ethereum: Awaited<ReturnType<typeof startDevEthereum>> | undefined;
    let harness: Awaited<ReturnType<typeof createBitcoinLocksHarness>> | undefined;
    let provider: JsonRpcProvider | undefined;
    let fissions: BitcoinFissions | undefined;
    let buys: StabilizerBuys | undefined;
    let purchases: StabilizerBuyPurchases | undefined;
    let beacon: EthereumBeaconSyncService | undefined;
    let prover: EthereumGatewayProverService | undefined;
    let unsubscribeFissions: VoidFunction | undefined;

    try {
      network = await startArgonTestNetwork(`stabilizer-liquid-${inject('argonIntegrationRunId')}`, {
        profiles: ['all'],
        ticksBetweenSlots: 6,
        registerTeardown: false,
      });
      vi.stubEnv('COMPOSE_PROJECT_NAME', network.composeEnv.COMPOSE_PROJECT_NAME);
      const config = {
        beaconPreset: 'minimal',
        secondsPerSlot: 1,
        finalityMillis: 16_000,
        finalityBlocks: 16,
      } as const;
      ethereum = await startDevEthereum(config);
      await createDevEthereumSetup(network.archiveUrl, ethereum, {
        ...config,
        oracleContext: {
          composeDir: fileURLToPath(new URL('../../e2e/argon', import.meta.url)),
          composeEnv: network.composeEnv,
          composeProjectName: network.composeEnv.COMPOSE_PROJECT_NAME,
          profiles: ['all'],
        },
        networkConfigOverride: network.networkConfigOverride,
      }).start();
      const deployment = (await readDevEthereumRuntimeState(ethereum.executionRpcUrl))!;
      NetworkConfig.setRuntimeOverride('dev-docker', {
        ...network.networkConfigOverride,
        ethereumNetwork: { executionRpcUrls: [ethereum.executionRpcUrl], finalityBlocks: 16 },
      });

      const walletKeys = createMockWalletKeys(
        integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'buyer'),
      );
      harness = await createBitcoinLocksHarness({
        archiveUrl: network.archiveUrl,
        esploraHost: network.networkConfigOverride.esploraHost,
        network: 'dev-docker',
        walletKeys,
        walletFundingMicrogons: 20_000_000_000n,
        vaultSetup: {
          ...defaultVaultSetup,
          securitizationMicrogons: 10_000_000_000n,
          committedMicronots: 0n,
          btcFlatFee: 1_000_000n,
          btcPctFee: 2.5,
        },
      });
      const { db, bitcoinLocks, bitcoinLockCreate, currency, miningFrames, transactionTracker, vaults } = harness;
      const client = await harness.clients.get(false);
      const txSigner = await walletKeys.getLiquidLockingSigner();
      const vault = harness.myVault.createdVault!;
      const lockCreation = await bitcoinLockCreate.submit({
        vault,
        satoshis: await bitcoinLocks.satoshisForArgonLiquidity(vault.availableBitcoinSpace() / 5n),
        txSigner,
        client,
      });
      await lockCreation.waitForPostProcessing;
      const lock = Object.values(bitcoinLocks.data.locksByLockId).find(
        record => record.uuid === lockCreation.tx.metadataJson.bitcoin.uuid,
      )!;
      const fundingAddress = bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
      sendBitcoinToAddress(fundingAddress, lock.securitizedSatoshis);
      generateBlocks(8);
      await waitFor(90_000, 'finalized Bitcoin funding', async () => {
        const snapshot = await miningFrames.blockWatch.getFinalizedApi();
        return (await BitcoinLock.get(snapshot, lock.lockId!))?.fundedSatoshis === lock.securitizedSatoshis;
      });

      fissions = new BitcoinFissions(Promise.resolve(db), txSigner.address, miningFrames.blockWatch, currency);
      await fissions.load();
      const liquidState = fissions;
      unsubscribeFissions = bitcoinLocks.events.on('fissions:changed', change =>
        liquidState.syncFinalizedBlock(change.block, change.events, change.client),
      );
      const upstream = new UpstreamOperatorClient();
      vi.spyOn(upstream, 'getBitcoinLockCoupons').mockResolvedValue([]);
      const resecuritize = new BitcoinLockResecuritize(bitcoinLocks, transactionTracker, currency, upstream);
      const createLiquid = new BitcoinLiquidCreate(
        fissions,
        transactionTracker,
        bitcoinLocks,
        vaults,
        resecuritize,
        upstream,
        miningFrames.blockWatch,
      );
      await createLiquid.load();
      const liquidCreation = await createLiquid.submit({
        allocations: [{ lock, satoshis: lock.securitizedSatoshis / 2n }],
        txSigner,
        client,
      });
      await liquidCreation.waitForPostProcessing;
      const liquid = fissions.getLiquids()[0];
      const initialSatoshis = liquid.satoshis;
      const lockExpirations = new Map([[lock.lockId!, lock.scriptDetails!.vaultClaimHeight]]);

      buys = new StabilizerBuys(miningFrames.blockWatch, txSigner.address, Promise.resolve(db));
      await buys.load();
      const wallets = new WalletsForEthereum(
        walletKeys,
        Promise.resolve(db),
        Promise.resolve(db.financialCacheTable),
        async (_reason, operation) => operation({}),
      );
      const ethereumClient = new EthereumClient(walletKeys, ethereum.executionRpcUrl);
      purchases = new StabilizerBuyPurchases(buys, walletKeys, ethereumClient, wallets);
      await purchases.load();
      provider = new JsonRpcProvider(ethereum.executionRpcUrl, undefined, { cacheTimeout: -1 });
      const admin = new Wallet(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey, provider);
      const buyer = wallets.coreWallet;
      const usdc = new Contract(ethereum.usdcTokenAddress, erc20Abi, admin);
      const funding: ContractTransactionResponse = await usdc.getFunction('transfer')(buyer.address, 500_000_000n);
      await funding.wait();
      await (await admin.sendTransaction({ to: buyer.address, value: 10n ** 18n })).wait();
      await setDevEthereumPoolPrice({ signer: admin, ethereum: deployment, priceUsdc: '0.75' });
      // Keep the scenario's oracle inputs explicit instead of depending on a changing TWAP.
      oraclePrices.argon_usd_price = 0.75;
      await writeFile(priceFile, JSON.stringify(oraclePrices));
      await waitFor(300_000, 'oracle reaches the requested purchase price', async () => {
        const snapshot = await miningFrames.blockWatch.getFinalizedApi();
        const prices = await snapshot.query.priceIndex.current();
        return prices?.argonUsdPrice.minus('0.75').abs().lt('0.000001');
      });
      await waitFor(
        60_000,
        'Stabilizer market is ready below target',
        async () => buys!.buyDiscountPercent !== undefined,
      );

      const delegate = await walletKeys.getVaultDelegateSigner();
      await sudoFundWallet({ client, address: delegate.address, microgons: 100_000_000n, micronots: 0n });
      const lane = new DelegateSubmitLane(delegate);
      lane.client = client;
      beacon = new EthereumBeaconSyncService(client, {
        beaconApiUrl: ethereum.beaconApiUrl,
        pollMs: 1_000,
        submitLane: lane,
      });
      await beacon.start();
      prover = new EthereumGatewayProverService(lane, miningFrames.blockWatch, directory, {
        backgroundSweepMs: 1_000,
        shouldApplySharedRelayStagger: false,
      });

      const quote = await purchases.quote({
        sourceAddress: buyer.address,
        destinationAddress: txSigner.address,
        quoterAddress: getAddress(deployment.stabilization!.deployment!.contracts.uniswapV4PriceQuoter.address),
        maxUsdcIn: 80_000_000n,
        slippageBps: 100,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
        repayLiquidId: BigInt(liquid.liquidId),
      });
      const preview = await purchases.previewPurchase({ ethereumQuote: quote });
      expect(preview.needsPermit).toBe(true);
      expect(await usdc.getFunction('allowance')(buyer.address, quote.adapterAddress)).toBe(0n);
      const nonceBefore = await provider.getTransactionCount(buyer.address);
      await purchases.purchase({
        id: 'liquid-buy',
        ethereumQuote: quote,
        ethereumMaxFeeWei: preview.feeEstimateWei * 2n,
        ethereumWallet: buyer,
        txSigner,
      });
      const domain = buys;
      await vi.waitFor(
        () => {
          const buy = domain.data.buys.find(buy => buy.id === 'liquid-buy')!;
          expect(buy.statusError).toBeUndefined();
          expect(buy.ethereumGatewayActivity).toBeDefined();
        },
        { timeout: 120_000, interval: 500 },
      );
      expect(await provider.getTransactionCount(buyer.address)).toBe(nonceBefore + 1);
      const submitted = domain.data.buys.find(buy => buy.id === 'liquid-buy')!;
      expect(submitted.usdcApprovalTxHash).toBeUndefined();
      expect(submitted.ethereumGatewayActivity!.purchase.repayLiquidId).toBe(BigInt(liquid.liquidId));
      const gatewayNonce = submitted.ethereumGatewayActivity!.gatewayState.gatewayActivityNonce;
      await vi.waitFor(
        async () => {
          const result = await prover!.runToCheckpoint({
            sourceChain: 'Ethereum',
            throughGatewayActivityNonce: gatewayNonce,
          });
          if (result.outcome === 'Rejected') throw new Error(result.reason);
          expect(domain.data.buys.find(buy => buy.id === 'liquid-buy')?.repayLiquidId).toBe(liquid.liquidId);
        },
        { timeout: 180_000, interval: 1_000 },
      );

      const admitted = domain.data.buys.find(buy => buy.id === 'liquid-buy')!;
      expect(admitted.purchaseAdmissionFailure).toBeUndefined();
      expect(admitted.ineligibleReason).toBeUndefined();
      expect(admitted.principal).toBeGreaterThan(0n);
      await vi.waitFor(() => expect(fissions!.data.pendingRepaymentLiquidIds.has(liquid.liquidId)).toBe(true), 30_000);

      const pending = domain.data.positions.find(position => position.admissionFrame === admitted.admissionFrame)!;
      expect(pending.purchase.bidRate.eq(1)).toBe(true);
      expect(pending.heldPrincipal).toBe(admitted.principal);
      const held = await (await miningFrames.blockWatch.getFinalizedApi()).query.balances.holds(txSigner.address);
      expect(held?.find(hold => hold.id.type === 'StabilizerBuys')?.amount).toBe(admitted.principal);
      const forecast = projectStabilizerBuyLiquidPaydown({
        microgons: admitted.principal!,
        priceIndex: currency.priceIndex,
        repayment: pending.liquidRepayments[0],
        liquid,
        lockExpirations,
      })!;
      expect(forecast.paydownPercent).toBeGreaterThan(0);
      expect(forecast.paydownPercent).toBeLessThan(100);
      const returnedSatoshis = [...forecast.repaidSatoshisByFission!.values()].reduce(
        (sum, amount) => sum + amount,
        0n,
      );
      expect(returnedSatoshis).toBeGreaterThan(0n);

      // Independently check the purchase terms, rather than using the preview as the oracle.
      // In this price band the published redemption curve is 0.5618 + 0.3944 / R.
      // The purchase must afford the selected whole satoshis, but not one more.
      const repayment = pending.liquidRepayments[0];
      expect(repayment.purchaseRValue.toNumber()).toBeCloseTo(0.75 / 1.06, 3);
      expect(liquid.fissions).toHaveLength(1);
      const purchaseRate = new BigNumber('0.5618')
        .plus(new BigNumber('0.3944').div(repayment.purchaseRValue))
        .decimalPlaces(18, BigNumber.ROUND_DOWN);
      const btcBasis = BigNumber.minimum(repayment.microgonsAtTargetPerBtc, liquid.fissions[0].microgonsAtTargetPerBtc);
      const repaidBasis = btcBasis.times(returnedSatoshis).div(100_000_000).integerValue(BigNumber.ROUND_DOWN);
      const nextSatoshiBasis = btcBasis
        .times(returnedSatoshis + 1n)
        .div(100_000_000)
        .integerValue(BigNumber.ROUND_DOWN);
      expect(repaidBasis.times(purchaseRate).integerValue(BigNumber.ROUND_DOWN).lte(admitted.principal!)).toBe(true);
      expect(nextSatoshiBasis.times(purchaseRate).integerValue(BigNumber.ROUND_DOWN).gt(admitted.principal!)).toBe(
        true,
      );

      // At R=0.95 the curve costs 0.95 per unit of the same BTC basis. Savings return
      // as unused ARGN; the advertised 5% bonus is calculated separately from the burn.
      // Numeric oracle inputs 1.007 / 1.06 yield R=0.949999999999999879.
      // Native fixed-point squaring gives this rate, two units below exact 0.95.
      const expectedBurn = BigInt(
        repaidBasis.times('0.949999999999999998').integerValue(BigNumber.ROUND_DOWN).toFixed(0),
      );
      const expectedRefund = admitted.principal! - expectedBurn;
      const expectedBonus = (expectedBurn * 5n) / 100n;
      expect(new BigNumber(expectedRefund).div(admitted.principal!).toNumber()).toBeCloseTo(0.151194, 3);

      // Request the curve's cheapest R directly, below target so the upward clamp
      // cannot turn this controlled observation into an incidental intermediate quote.
      const recoveryUsdPrice = new BigNumber(oraclePrices.argon_usd_target_price).times('0.95');
      await setDevEthereumPoolPrice({ signer: admin, ethereum: deployment, priceUsdc: recoveryUsdPrice.toFixed() });
      oraclePrices.argon_usd_price = recoveryUsdPrice.toNumber();
      await writeFile(priceFile, JSON.stringify(oraclePrices));
      const targetForecast = await waitFor(180_000, 'paydown retaining the cheapest quote', () => {
        const repayment = domain.data.positions.find(position => position.admissionFrame === admitted.admissionFrame)
          ?.liquidRepayments[0];
        if (!repayment?.observedRValueHighWater?.minus('0.95').abs().lt('0.000000000001')) return;
        return projectStabilizerBuyLiquidPaydown({
          microgons: admitted.principal!,
          priceIndex: currency.priceIndex,
          repayment,
          liquid,
          lockExpirations,
        });
      });
      expect(targetForecast.returnedMicrogons).toBeGreaterThan(forecast.returnedMicrogons);
      expect(targetForecast.burnedMicrogons).toBe(expectedBurn);
      expect(targetForecast.returnedMicrogons).toBe(expectedRefund);
      expect(targetForecast.repaidSatoshisByFission).toEqual(forecast.repaidSatoshisByFission);

      await setDevEthereumPoolPrice({ signer: admin, ethereum: deployment, priceUsdc: '0.75' });
      oraclePrices.argon_usd_price = 0.75;
      await writeFile(priceFile, JSON.stringify(oraclePrices));
      await waitFor(180_000, 'price falls below target again', async () => {
        const snapshot = await miningFrames.blockWatch.getFinalizedApi();
        return (await snapshot.query.priceIndex.current())?.argonUsdPrice.lt(0.8);
      });
      const retainedRepayment = domain.data.positions.find(
        position => position.admissionFrame === admitted.admissionFrame,
      )!.liquidRepayments[0];
      const retainedForecast = projectStabilizerBuyLiquidPaydown({
        microgons: admitted.principal!,
        priceIndex: currency.priceIndex,
        repayment: retainedRepayment,
        liquid,
        lockExpirations,
      })!;
      expect(retainedForecast.burnedMicrogons).toBe(targetForecast.burnedMicrogons);
      expect(retainedForecast.repaidSatoshisByFission).toEqual(forecast.repaidSatoshisByFission);

      await vi.waitFor(
        () => expect(domain.data.buys.find(buy => buy.id === 'liquid-buy')?.status).toBe(StabilizerBuyStatus.Complete),
        { timeout: 900_000, interval: 1_000 },
      );
      const completed = domain.data.buys.find(buy => buy.id === 'liquid-buy')!;
      expect(completed.liquidRepaymentEvent?.microgonsBurned).toBe(expectedBurn);
      expect(completed.releasedPrincipal).toBe(expectedRefund);
      expect(completed.liquidRepaymentEvent!.microgonsBurned + completed.releasedPrincipal!).toBe(completed.principal);
      await vi.waitFor(() => {
        expect(fissions!.data.pendingRepaymentLiquidIds.has(liquid.liquidId)).toBe(false);
        const current = fissions!.getLiquids().find(current => current.liquidId === liquid.liquidId)!;
        expect(current.satoshis).toBe(initialSatoshis - returnedSatoshis);
        expect(getStabilizerBuyReturnedSatoshis(completed, current)).toBe(returnedSatoshis);
      }, 30_000);
      const settledLock = await BitcoinLock.get(await miningFrames.blockWatch.getFinalizedApi(), lock.lockId!);
      expect(settledLock?.fissionedSatoshis).toBe(initialSatoshis - returnedSatoshis);
      const remainingHolds = await (
        await miningFrames.blockWatch.getFinalizedApi()
      ).query.balances.holds(txSigner.address);
      expect(remainingHolds?.some(hold => hold.id.type === 'StabilizerBuys')).toBe(false);
      const rewards = domain.data.frameRewards.find(rewards => rewards.admissionFrame === admitted.admissionFrame)!;
      expect(rewards.latestBid).toBe(100);
      expect(rewards.repaymentRewards?.reduce((sum, reward) => sum + reward.amount, 0n)).toBe(expectedBonus);
      const persisted = await db.stabilizerBuysTable.fetchAll(txSigner.address);
      expect(persisted.buys.find(buy => buy.id === 'liquid-buy')).toMatchObject({
        status: StabilizerBuyStatus.Complete,
        repayLiquidId: liquid.liquidId,
        releasedPrincipal: expectedRefund,
        liquidRepaymentEvent: { microgonsBurned: expectedBurn },
      });
    } finally {
      unsubscribeFissions?.();
      const cleanup = await Promise.allSettled([
        purchases?.close(),
        buys?.close(),
        prover?.shutdown(),
        beacon?.shutdown(),
        fissions?.shutdown(),
      ]);
      for (const result of cleanup) {
        if (result.status === 'rejected') console.error('Liquid test service cleanup failed', result.reason);
      }
      provider?.destroy();
      try {
        if (harness) await cleanupBitcoinLocksHarness(harness);
      } finally {
        try {
          if (ethereum) await new TestEthereum(ethereum.enclaveName).teardown();
        } finally {
          try {
            await network?.stop();
          } finally {
            NetworkConfig.clearRuntimeOverride('dev-docker');
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
  }, 1_500_000);
});
