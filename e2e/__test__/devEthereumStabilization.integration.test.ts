import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Contract, JsonRpcProvider, Wallet, type EventLog, type InterfaceAbi } from 'ethers';
import { TestEthereum, uniswapV4FixtureArtifacts } from '@argonprotocol/testing';
import { EvmContracts, getOfflineRegistry } from '@argonprotocol/mainchain';
import { erc20Abi, getAddress } from 'viem';
import BigNumber from 'bignumber.js';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { NetworkConfig, StabilizerBuyContracts, UnitOfMeasurement, type BlockWatch } from '@argonprotocol/apps-core';
import { EthereumClient } from 'src-vue/lib/EthereumClient.ts';
import { StabilizerBuyPurchases } from 'src-vue/lib/StabilizerBuyPurchases.ts';
import { StabilizerBuyAlerts } from 'src-vue/lib/StabilizerBuyAlerts.ts';
import { StabilizerBuyStatus } from 'src-vue/interfaces/IStabilizerBuyPurchase.ts';
import { StabilizerBuys } from 'src-vue/lib/StabilizerBuys.ts';
import { WalletsForEthereum } from 'src-vue/lib/WalletsForEthereum.ts';
import { createTestDb } from 'src-vue/__test__/helpers/db.ts';
import { createMockWalletKeys } from 'src-vue/__test__/helpers/wallet.ts';
import { WalletForEthereum } from 'src-vue/lib/WalletForEthereum.ts';
import { calculateStabilizerBuyCost, projectStabilizerBuyQuote } from 'src-vue/lib/financials/StabilizerBuys.ts';
import {
  DEV_ETHEREUM_ADMIN_ACCOUNT,
  readDevEthereumRuntimeState,
  updateDevEthereumRuntimeState,
  writeDevEthereumRuntimeState,
} from '../devEthereum.ts';
import {
  deployDevEthereumPurchaseDependencies,
  deployDevEthereumStabilizationPool,
  type IDevEthereumStabilization,
} from '../devEthereumStabilization.ts';
import { run as runPrice } from '../../dev/commands/price.ts';

const command = promisify(execFile);
const require = createRequire(import.meta.url);
const { Actions, V4Planner } = require('@uniswap/v4-sdk') as typeof import('@uniswap/v4-sdk');
const { getMainchainClientMock } = vi.hoisted(() => ({ getMainchainClientMock: vi.fn() }));
vi.mock('src-vue/stores/mainchain.ts', () => ({ getMainchainClient: getMainchainClientMock }));
const container = `stabilizer-fixture-${randomUUID().slice(0, 8)}`;
let directory: string;
let rpc: string;
let provider: JsonRpcProvider;

describe('local Stabilizer Buys deployment', { tags: ['no-argon-network'] }, () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'stabilizer-fixture-'));
    vi.stubEnv('ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR', path.join(directory, 'owner', 'dev-ethereum'));
    vi.stubEnv('ARGON_APP_INSTANCE_DIR', path.join(directory, 'joined'));
    vi.stubEnv('ARGON_APP_INSTANCE', 'joined');
    await command('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-p',
      '127.0.0.1::8545',
      '--entrypoint',
      'anvil',
      'ghcr.io/foundry-rs/foundry:stable',
      '--host',
      '0.0.0.0',
    ]);
    const port = await command('docker', ['port', container, '8545/tcp']);
    rpc = `http://${port.stdout.trim()}`;
    provider = new JsonRpcProvider(rpc, 31337, { cacheTimeout: -1 });
    provider.pollingInterval = 25;
    await vi.waitFor(() => provider.getBlockNumber(), { timeout: 15_000 });
  });

  afterAll(async () => {
    provider?.destroy();
    await command('docker', ['rm', '-f', container]).catch(() => undefined);
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('deploys the SDK fixture and confirms a purchase on Ethereum', async () => {
    const signer = new Wallet(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey, provider);
    const ethereum = new TestEthereum();
    ethereum.executionRpcUrl = rpc;
    ethereum.chainId = '0x7a69';
    const usdc = await ethereum.deployUsdcFixture(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey);
    const state: IDevEthereumStabilization = {};
    await writeDevEthereumRuntimeState({
      beaconPreset: 'minimal',
      enclaveName: container,
      executionRpcUrl: rpc,
      beaconApiUrl: rpc,
      chainId: ethereum.chainId,
      serverExecutionRpcUrl: rpc,
      serverBeaconApiUrl: rpc,
      usdcTokenAddress: usdc,
      stabilization: state,
      setupStatus: 'starting',
    });
    const saveProgress = () => updateDevEthereumRuntimeState(rpc, { stabilization: state });
    const purchase = await deployDevEthereumPurchaseDependencies({ signer, usdc, state, saveProgress });
    const gateway = await ethereum.deployMintingGatewayFixture({
      deployerPrivateKey: DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey,
      purchase,
    });
    const gatewayContract = new Contract(gateway.gatewayAddress, EvmContracts.mintingGatewayAbi, signer);
    const balance = 10_000n * 10n ** 18n;
    await (
      await gatewayContract.getFunction('migrate')(
        { recipients: [signer.address], amounts: [balance] },
        { recipients: [signer.address], amounts: [balance] },
      )
    ).wait();
    const positionManager = new Contract(
      state.positionManager!,
      JSON.stringify(uniswapV4FixtureArtifacts.positionManager.abi),
      signer,
    );
    let interrupted = false;
    const interruptAfterMint = async () => {
      if (
        state.liquidityTokenId &&
        !interrupted &&
        (await positionManager.getFunction('nextTokenId')()) > BigInt(state.liquidityTokenId)
      ) {
        interrupted = true;
        throw new Error('Interrupted after liquidity transaction');
      }
      await saveProgress();
    };
    await expect(
      deployDevEthereumStabilizationPool({
        signer,
        chainId: ethereum.chainId,
        usdc,
        gateway,
        state,
        saveProgress: interruptAfterMint,
        initialPriceUsdc: '1.06',
      }),
    ).rejects.toThrow('Interrupted after liquidity');

    const recovered = (await readDevEthereumRuntimeState(rpc))!.stabilization!;
    const positionCount = await positionManager.getFunction('nextTokenId')();
    await deployDevEthereumPurchaseDependencies({
      signer,
      usdc,
      state: recovered,
      saveProgress: () => updateDevEthereumRuntimeState(rpc, { stabilization: recovered }),
    });
    const deployment = await deployDevEthereumStabilizationPool({
      signer,
      chainId: ethereum.chainId,
      usdc,
      gateway,
      state: recovered,
      saveProgress: () => updateDevEthereumRuntimeState(rpc, { stabilization: recovered }),
      initialPriceUsdc: '1.06',
    });

    expect(await new Contract(usdc, erc20Abi, provider).getFunction('decimals')()).toBe(6n);
    expect((await gatewayContract.getFunction('swapContract')()).toLowerCase()).toBe(
      gateway.buyAndTransferAddress!.toLowerCase(),
    );
    expect((await positionManager.getFunction('poolManager')()).toLowerCase()).toBe(
      recovered.poolManager!.toLowerCase(),
    );
    expect(await positionManager.getFunction('nextTokenId')()).toBe(positionCount);
    expect(
      await positionManager.getFunction('getPositionLiquidity')(BigInt(recovered.liquidityTokenId!)),
    ).toBeGreaterThan(0n);
    const [key] = await positionManager.getFunction('getPoolAndPositionInfo')(BigInt(recovered.liquidityTokenId!));
    expect(key.hooks.toLowerCase()).toBe(deployment.contracts.stabilizationPoolHook.address.toLowerCase());
    expect(recovered.poolManager).toBe(state.poolManager);
    expect(recovered.deployment?.pool.poolId).toBe(state.deployment?.pool.poolId);

    // Recreate the older shallow fixture, then resume after a top-up was mined but its save failed.
    const tokenId = BigInt(recovered.liquidityTokenId!);
    const seededLiquidity = await positionManager.getFunction('getPositionLiquidity')(tokenId);
    const shallowLiquidity = 500n * 10n ** 12n;
    const plan = new V4Planner();
    plan.addAction(Actions.DECREASE_LIQUIDITY, [tokenId, seededLiquidity - shallowLiquidity, 0n, 0n, '0x']);
    plan.addAction(Actions.TAKE_PAIR, [key.currency0, key.currency1, signer.address]);
    const actions = plan.finalize();
    const gas = await positionManager.getFunction('modifyLiquidities').estimateGas(actions, (1n << 256n) - 1n);
    await (
      await positionManager.getFunction('modifyLiquidities')(actions, (1n << 256n) - 1n, {
        gasLimit: (gas * 12n) / 10n + 50_000n,
      })
    ).wait();
    expect(await positionManager.getFunction('getPositionLiquidity')(tokenId)).toBe(shallowLiquidity);

    await expect(
      deployDevEthereumStabilizationPool({
        signer,
        chainId: ethereum.chainId,
        usdc,
        gateway,
        state: recovered,
        saveProgress: async () => {
          throw new Error('Interrupted after liquidity top-up');
        },
      }),
    ).rejects.toThrow('Interrupted after liquidity top-up');
    expect(await positionManager.getFunction('getPositionLiquidity')(tokenId)).toBe(seededLiquidity);

    const afterTopUp = (await readDevEthereumRuntimeState(rpc))!.stabilization!;
    const topUpNonce = await signer.getNonce();
    await deployDevEthereumStabilizationPool({
      signer,
      chainId: ethereum.chainId,
      usdc,
      gateway,
      state: afterTopUp,
      saveProgress: () => updateDevEthereumRuntimeState(rpc, { stabilization: afterTopUp }),
    });
    expect(await signer.getNonce()).toBe(topUpNonce);
    expect(await positionManager.getFunction('nextTokenId')()).toBe(positionCount);
    expect(await positionManager.getFunction('getPositionLiquidity')(tokenId)).toBe(seededLiquidity);

    await updateDevEthereumRuntimeState(rpc, { gateway, setupStatus: 'ready' });
    const manager = new Contract(
      recovered.poolManager!,
      uniswapV4FixtureArtifacts.poolManager.abi as InterfaceAbi,
      provider,
    );
    const initialNonce = await signer.getNonce();
    await runPrice(['--profile', 'joined', '--join', 'owner', '--argon', '1.06']);
    await expect(signer.getNonce()).resolves.toBe(initialNonce);
    await provider.send('evm_setAutomine', [false]);
    const pending = await signer.sendTransaction({ to: signer.address, value: 0n });
    try {
      await expect(runPrice(['--profile', 'joined', '--join', 'owner', '--argon', '0.95'])).rejects.toThrow(
        'pending Ethereum transaction',
      );
      await expect(signer.getNonce('pending')).resolves.toBe(initialNonce + 1);
    } finally {
      await provider.send('evm_mine', []);
      await provider.send('evm_setAutomine', [true]);
    }
    await pending.wait();
    for (const price of ['0.95', '1.12']) {
      const before = await provider.getBlockNumber();
      await command('yarn', ['dev', 'price', '--profile', 'joined', '--join', 'owner', '--argon', price]);
      const swaps = (await manager.queryFilter(manager.getEvent('Swap'), before + 1, 'latest')) as EventLog[];
      expect(swaps).toHaveLength(1);
      const rawRatio = (Number(swaps[0].args.sqrtPriceX96) / 2 ** 96) ** 2;
      let actualPrice = rawRatio * 1e12;
      if (deployment.pool.key.currency0.toLowerCase() === usdc.toLowerCase()) actualPrice = 1e12 / rawRatio;
      expect(actualPrice).toBeCloseTo(Number(price), 5);
    }
    const nonce = await signer.getNonce();
    await runPrice(['--profile', 'joined', '--join', 'owner', '--argon', '1.12']);
    await expect(signer.getNonce()).resolves.toBe(nonce);
    await expect(runPrice(['--profile', 'joined', '--join', 'owner', '--argon', '0'])).rejects.toThrow(
      'positive USDC amount',
    );
    await expect(signer.getNonce()).resolves.toBe(nonce);
    expect((await readDevEthereumRuntimeState(rpc))?.stabilization?.deployment).toEqual(deployment);

    // The app quotes the approved native pool, then signs and executes against the real adapter.
    await runPrice(['--profile', 'joined', '--join', 'owner', '--argon', '0.95']);
    const walletKeys = createMockWalletKeys();
    const buyer = new WalletForEthereum(walletKeys.coreEthereumAddress, undefined, undefined, true);
    await provider.send('anvil_setBalance', [buyer.address, '0x56BC75E2D63100000']);
    await (await new Contract(usdc, erc20Abi, signer).getFunction('transfer')(buyer.address, 500_000_000n)).wait();
    let currentTick = 100;
    let retainRecentTarget = true;
    let hasUsdcReference = true;
    const registry = getOfflineRegistry();
    const snapshot = runtimeClient({
      registry,
      consts: {
        balances: { existentialDeposit: 1_000_000n },
        priceIndex: { maxDowntimeTicksBeforeReset: 10n },
        stabilizerBuys: { maxPriceAgeTicks: registry.createType('u64', 10) },
      },
      query: {
        ticks: { currentTick: async () => currentTick },
        stabilizerBuys: {
          priceHistoryByTick: Object.assign(() => undefined, {
            multi: async (ticks: string[]) =>
              ticks.map(tick => {
                const observationTick = retainRecentTarget ? 100 : 99;
                if (Number(BigInt(tick)) !== observationTick)
                  return registry.createType('Option<PalletStabilizerBuysPriceHistoryPriceObservation>');

                if (!hasUsdcReference)
                  return registry.createType('Option<PalletStabilizerBuysPriceHistoryPriceObservation>', {
                    frame: 0,
                    rValue: 1_000_000_000_000_000_000n,
                  });

                const target = new BigNumber(retainRecentTarget ? '1.06' : '1.04');
                return registry.createType('Option<PalletStabilizerBuysPriceHistoryPriceObservation>', {
                  frame: 0,
                  rValue: 1_000_000_000_000_000_000n,
                  prices: {
                    argonUsdTargetPrice: target.times(1e18).toFixed(0),
                    microgonsAtTargetPerUsdc: new BigNumber(1)
                      .div(target)
                      .times(1e24)
                      .integerValue(BigNumber.ROUND_CEIL)
                      .toFixed(0),
                  },
                });
              }),
          }),
          approvedPool: async () => ({
            chainId: 31337n,
            poolManager: deployment.pool.poolManager,
            poolId: deployment.pool.poolId,
            usdcToken: usdc,
            argonIsToken0: deployment.pool.key.currency0.toLowerCase() === gateway.argonTokenAddress.toLowerCase(),
          }),
        },
        stabilizerPools: { pools: async () => ({ key: deployment.pool.key }) },
        priceIndex: {
          current: async () => ({
            tick: 100,
            argonUsdTargetPrice: new BigNumber('1.06'),
            usdcUsdPrice: new BigNumber(2),
          }),
          currentEthereumPrice: async () => ({
            tick: 100,
            ethereumUsdPrice: new BigNumber(3000),
            ethereumGasPriceWei: 1n,
          }),
        },
        crosschainTransfer: {
          chainConfigBySourceChain: async () => ({
            type: 'Evm',
            value: {
              chainId: 31337n,
              gateway: gateway.gatewayAddress,
              argonToken: gateway.argonTokenAddress,
              argonotToken: gateway.argonotTokenAddress,
            },
          }),
        },
      },
    });
    getMainchainClientMock.mockResolvedValue({
      query: snapshot.query,
      raw: { at: async () => snapshot },
      rpc: { chain: { getFinalizedHead: async () => '0x00' } },
    });
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', { ethereumNetwork: { finalityBlocks: 1 } });
    const db = await createTestDb();
    const buys = new StabilizerBuys({} as BlockWatch, walletKeys.defaultArgonAddress, Promise.resolve(db));
    const wallets = new WalletsForEthereum(
      walletKeys,
      Promise.resolve(db),
      Promise.resolve(db.financialCacheTable),
      async (_reason, operation) => operation({}),
    );
    const ethereumClient = new EthereumClient(walletKeys, rpc);
    vi.spyOn(ethereumClient, 'getTransactionFinalityPollMs').mockReturnValue(10);
    const contractReads = vi.spyOn(ethereumClient.publicClient, 'readContract');
    const purchaseCommand = new StabilizerBuyPurchases(buys, walletKeys, ethereumClient, wallets);
    try {
      const deadline = BigInt((await provider.getBlock('latest'))!.timestamp) + 3600n;
      const quoteArgs = {
        maxUsdcIn: 100_000_000n,
        slippageBps: 50,
        deadline,
        destinationAddress: walletKeys.defaultArgonAddress,
        sourceAddress: buyer.address,
        quoterAddress: deployment.contracts.uniswapV4PriceQuoter.address as `0x${string}`,
      };
      const quote = await purchaseCommand.quote(quoteArgs);
      expect(quote.prices?.argonUsdTargetPrice.toFixed(2)).toBe('1.06');
      expect(quote.prices?.usdcUsdPrice.toFixed(2)).toBe('1.00');
      retainRecentTarget = false;
      expect((await purchaseCommand.quote(quoteArgs)).prices?.argonUsdTargetPrice.toFixed(2)).toBe('1.04');
      retainRecentTarget = true;
      hasUsdcReference = false;
      await expect(purchaseCommand.quote(quoteArgs)).rejects.toThrow('price reference');
      hasUsdcReference = true;
      expect(quote.quotedMicrogonsOut).toBeGreaterThan(100_000_000n);
      expect(quote.request.minMicrogonsOut).toBeGreaterThanOrEqual(
        await gatewayContract.getFunction('minimumSwapMicrogons')(),
      );
      const minimumQuote = await purchaseCommand.quote({ ...quoteArgs, maxUsdcIn: undefined, sizeToTarget: true });
      expect(minimumQuote.request.maxUsdcIn).toBeLessThan(quote.request.maxUsdcIn);
      expect(minimumQuote.request.minMicrogonsOut).toBeGreaterThanOrEqual(
        await gatewayContract.getFunction('minimumSwapMicrogons')(),
      );
      await expect(
        purchaseCommand.quote({ ...quoteArgs, maxUsdcIn: minimumQuote.request.maxUsdcIn - 1_000_000n }),
      ).rejects.toThrow('Minimum purchase amount: 100 ARGN');
      const maximumQuote = await purchaseCommand.quote({ ...quoteArgs, maxUsdcIn: 500_000_000n, sizeToTarget: true });
      expect(maximumQuote.request.maxUsdcIn).toBeLessThan(500_000_000n);
      expect(maximumQuote.request.minMicrogonsOut).toBeGreaterThanOrEqual(
        await gatewayContract.getFunction('minimumSwapMicrogons')(),
      );

      const best = await purchaseCommand.quoteMaxProfit({ ...quoteArgs, maxUsdcIn: 500_000_000n });
      const bestCost = calculateStabilizerBuyCost({ quote: best.quote, feeEstimateWei: best.preview.feeEstimateWei })!;
      const bestProfit = best.quote.quotedMicrogonsOut - bestCost.investedCost;
      const bestProjection = projectStabilizerBuyQuote({
        quote: best.quote,
        feeEstimateWei: best.preview.feeEstimateWei,
        periodDays: 30,
        matchingRate: new BigNumber(1),
      })!;
      expect(bestProfit).toBeGreaterThan(0n);
      expect(best.quote.request.maxUsdcIn).toBeGreaterThan(minimumQuote.request.maxUsdcIn);
      expect(best.quote.request.maxUsdcIn).toBeLessThan(maximumQuote.request.maxUsdcIn);
      for (const alternative of [minimumQuote, maximumQuote]) {
        const preview = await purchaseCommand.previewPurchase({ ethereumQuote: alternative });
        const cost = calculateStabilizerBuyCost({ quote: alternative, feeEstimateWei: preview.feeEstimateWei })!;
        expect(bestProfit).toBeGreaterThan(alternative.quotedMicrogonsOut - cost.investedCost);
      }

      // Alerts and the default purchase review use the same real optimizer and fee assumptions.
      Object.assign(buys.data, {
        isLoaded: true,
        isAvailable: true,
        currentTick,
        market: {
          approvedPool: await snapshot.query.stabilizerBuys.approvedPool(),
          prices: {
            tick: currentTick,
            argonUsdPrice: new BigNumber('0.95'),
            argonUsdTargetPrice: new BigNumber('1.06'),
          },
          matchingRate: new BigNumber(1),
          frameId: 0,
          frameRewardTicksRemaining: null,
          maxPriceAgeTicks: 10n,
          maxPositiveBids: 4,
          purchaseHoldFrames: 30,
          auctionInclusionPercent: new BigNumber('0.9'),
        },
      });
      await db.walletsTable.createDefaultEthereum({
        address: buyer.address,
        derivationPath: walletKeys.ethereumHdPath,
      });
      await wallets.reloadRecords();
      wallets.coreWallet.data.balanceUpdatedAt = new Date();
      wallets.coreWallet.data.balanceIsCached = false;
      wallets.coreWallet.data.otherTokens = [
        {
          symbol: 'USDC',
          decimals: 6,
          address: usdc,
          chain: 'ethereum',
          unitOfMeasurement: UnitOfMeasurement.USDC,
          value: 500_000_000n,
        },
      ];
      const walletRefresh = vi.spyOn(wallets, 'refresh').mockResolvedValue();
      const alerts = new StabilizerBuyAlerts(
        buys,
        () => purchaseCommand,
        wallets,
        { isLoaded: true, stabilizerBuyAlert: { minimumApy: 0 } },
        Promise.resolve(db),
        async () => undefined,
      );
      NetworkConfig.setRuntimeOverride('dev-docker', {
        ethereumNetwork: {
          finalityBlocks: 1,
          stabilizerBuyQuoterAddress: quoteArgs.quoterAddress,
        },
      });
      try {
        await alerts.refresh();
        expect(alerts.data.error).toBeUndefined();
        expect(alerts.opportunity?.quote.request.maxUsdcIn).toBe(best.quote.request.maxUsdcIn);
        expect(alerts.opportunity?.quote.quotedMicrogonsOut).toBe(best.quote.quotedMicrogonsOut);
        expect(alerts.opportunity?.apy).toBe(bestProjection.apy.max);
      } finally {
        await alerts.close();
        walletRefresh.mockRestore();
      }
      // A smaller wallet is the spending boundary, regardless of the pool's remaining opportunity.
      const limited = await purchaseCommand.quoteMaxProfit({ ...quoteArgs, maxUsdcIn: 110_000_000n });
      expect(limited.quote.request.maxUsdcIn).toBeLessThanOrEqual(110_000_000n);
      expect(limited.quote.request.maxUsdcIn).toBeGreaterThanOrEqual(limited.minimumQuote.request.maxUsdcIn);
      const unfunded = await purchaseCommand.quoteMaxProfit({ ...quoteArgs, maxUsdcIn: 0n });
      expect(unfunded.quote.request.maxUsdcIn).toBe(unfunded.minimumQuote.request.maxUsdcIn);

      // An existing allowance can outweigh a larger gross discount when a new approval is expensive.
      await provider.send('anvil_impersonateAccount', [buyer.address]);
      const buyerSigner = await provider.getSigner(buyer.address);
      const buyerUsdc = new Contract(usdc, erc20Abi, buyerSigner);
      const allowanceBoundary = minimumQuote.request.maxUsdcIn + 5_123_457n;
      await (await buyerUsdc.getFunction('approve')(quote.adapterAddress, allowanceBoundary)).wait();
      const expensiveFees = vi.spyOn(ethereumClient.publicClient, 'estimateFeesPerGas').mockResolvedValue({
        maxFeePerGas: 20_000_000_000_000n,
        maxPriorityFeePerGas: 1n,
      });
      const fixedTransactionGas = vi
        .spyOn(ethereumClient.publicClient, 'estimateContractGas')
        .mockResolvedValue(200_000n);
      const approvedBest = await purchaseCommand.quoteMaxProfit({ ...quoteArgs, maxUsdcIn: 500_000_000n });
      expect(approvedBest.quote.request.maxUsdcIn).toBe(allowanceBoundary);
      expect(approvedBest.preview.needsApproval).toBe(false);
      fixedTransactionGas.mockRestore();
      expensiveFees.mockRestore();
      await (await buyerUsdc.getFunction('approve')(quote.adapterAddress, 0n)).wait();
      await provider.send('anvil_stopImpersonatingAccount', [buyer.address]);

      const fullWallet = await purchaseCommand.quote({ ...quoteArgs, maxUsdcIn: 500_000_000n });
      expect(fullWallet.request.maxUsdcIn).toBe(500_000_000n);
      expect(fullWallet.request.maxUsdcIn).toBeGreaterThan(maximumQuote.request.maxUsdcIn);
      const fullWalletFees = await purchaseCommand.previewPurchase({ ethereumQuote: fullWallet });
      const fullWalletProjection = projectStabilizerBuyQuote({
        quote: fullWallet,
        feeEstimateWei: fullWalletFees.feeEstimateWei,
        periodDays: 30,
        matchingRate: new BigNumber(1),
      })!;
      expect(fullWalletProjection.apy.min).toBeLessThan(bestProjection.apy.min);
      await expect(purchaseCommand.quote({ ...quoteArgs, deadline: 1n })).rejects.toThrow('expired');
      // Background fee estimates work before approval, without ETH or signing access.
      await provider.send('anvil_setBalance', [buyer.address, '0x0']);
      const estimated = await purchaseCommand.previewPurchase({ ethereumQuote: quote });
      const contracts = new StabilizerBuyContracts(() => ethereumClient.publicClient);
      const estimatedGas = await contracts.estimatePurchaseGas(quote);
      expect(estimated.needsApproval).toBe(true);
      expect(estimated.feeEstimateWei).toBeGreaterThan(0n);
      await provider.send('anvil_setBalance', [buyer.address, '0x56BC75E2D63100000']);
      const input = {
        id: 'synthetic-evm-buy',
        ethereumQuote: quote,
        ethereumMaxFeeWei: estimated.feeEstimateWei,
        ethereumWallet: buyer,
      };
      currentTick = 111;
      await expect(purchaseCommand.quote(quoteArgs)).rejects.toThrow('price reference');
      await expect(purchaseCommand.previewPurchase(input)).rejects.toThrow('price reference');
      currentTick = 100;
      await expect(purchaseCommand.previewPurchase({ ...input, ethereumMaxFeeWei: 1n })).rejects.toThrow('fee limit');
      const prepared = await purchaseCommand.previewPurchase(input);
      expect(prepared.needsApproval).toBe(true);
      await expect(
        walletKeys.signEthereumPermit({
          tokenAddress: getAddress(gateway.argonotTokenAddress),
          tokenName: 'ARGNOT',
          value: 1n,
          nonce: 0n,
          deadline,
        }),
      ).resolves.toMatchObject({ v: expect.any(Number) });
      await expect(
        purchaseCommand.previewPurchase({
          ...input,
          ethereumQuote: { ...quote, request: { ...quote.request, minMicrogonsOut: quote.quotedMicrogonsOut + 1n } },
        }),
      ).rejects.toThrow('minimum output');

      const adapterReads = contractReads.mock.calls.filter(
        ([request]) => request.address?.toLowerCase() === quote.adapterAddress.toLowerCase(),
      );
      expect(adapterReads.map(([request]) => request.functionName).sort()).toEqual([
        'argon',
        'gateway',
        'poolManager',
        'usdc',
      ]);
      const quoterReads = contractReads.mock.calls.filter(
        ([request]) =>
          request.address?.toLowerCase() === quote.quoterAddress.toLowerCase() &&
          request.functionName === 'poolManager',
      );
      expect(quoterReads).toHaveLength(1);

      await purchaseCommand.purchase(input);
      await vi.waitFor(
        async () => {
          await provider.send('anvil_mine', ['0x1']);
          expect(buys.data.buys.find(buy => buy.id === input.id)?.status).toBe(
            StabilizerBuyStatus.WaitingForArgonRecognition,
          );
        },
        { timeout: 15_000, interval: 100 },
      );
      const buy = buys.data.buys.find(buy => buy.id === input.id)!;
      expect(buy.usdcApprovalFeeWei).toBeGreaterThan(0n);
      expect(buy.ethereumGatewayActivity?.amount).toBeGreaterThanOrEqual(quote.request.minMicrogonsOut);
      expect(buy.ethereumGatewayActivity?.purchase.usdcSpent).toBe(quote.request.maxUsdcIn);
      const usdcContract = new Contract(usdc, erc20Abi, provider);
      expect(await usdcContract.getFunction('balanceOf')(buyer.address)).toBe(500_000_000n - quote.request.maxUsdcIn);
      const receipt = (await provider.getTransactionReceipt(buy.ethereumTxHash!))!;
      expect(buy.ethereumFeeWei).toBe(receipt.gasUsed * receipt.gasPrice);
      expect(estimated.feeEstimateWei).toBeGreaterThanOrEqual(buy.ethereumFeeWei! + buy.usdcApprovalFeeWei!);
      const approval = (await provider.getTransaction(buy.usdcApprovalTxHash!))!;
      const purchased = (await provider.getTransaction(buy.ethereumTxHash!))!;
      expect(estimatedGas.gasEstimate).toBeGreaterThanOrEqual(approval.gasLimit + purchased.gasLimit);
      expect(buy.spentMicrogons).toBe(94_339_623n);
      expect(buy.ethereumFeeMicrogons).toBeGreaterThan(0n);
      expect(buy.usdcApprovalFeeMicrogons).toBeGreaterThan(0n);
      expect((await db.stabilizerBuysTable.fetchAll(walletKeys.defaultArgonAddress)).buys[0]).toMatchObject(buy);
      await expect(purchaseCommand.quote(quoteArgs)).rejects.toThrow('Minimum purchase amount: 100 ARGN');
      await runPrice(['--profile', 'joined', '--join', 'owner', '--argon', '0.60']);
      await (
        await usdcContract.connect(signer).getFunction('approve')(quote.adapterAddress, quote.request.maxUsdcIn)
      ).wait();
      const approvedQuote = await purchaseCommand.quote({ ...quoteArgs, sourceAddress: signer.address });
      const approvedFees = await purchaseCommand.previewPurchase({ ethereumQuote: approvedQuote });
      expect(approvedFees.needsApproval).toBe(false);
      expect(approvedFees.feeEstimateWei).toBeGreaterThan(0n);
      expect(approvedFees.feeEstimateWei).toBeLessThan(estimated.feeEstimateWei);
      await expect(
        purchaseCommand.previewPurchase({ ...input, ethereumMaxFeeWei: buy.usdcApprovalFeeWei! }),
      ).rejects.toThrow('fee limit');

      const mismatchId = 'synthetic-mismatched-receipt';
      await buys.createPurchase({
        ...input,
        id: mismatchId,
        ethereumQuote: { ...quote, poolId: `0x${'00'.repeat(32)}` },
      });
      await buys.recordPurchase(mismatchId, {
        status: StabilizerBuyStatus.ConfirmingPurchaseOnEthereum,
        ethereumTxHash: buy.ethereumTxHash,
        ethereumSubmittedAt: buy.ethereumSubmittedAt,
      });
      await purchaseCommand.load();
      await vi.waitFor(() =>
        expect(buys.data.buys.find(buy => buy.id === mismatchId)?.statusError).toContain(
          'no matching gateway purchase',
        ),
      );

      // Crossing the final target is accepted by the real adapter and gateway.
      const crossing = await purchaseCommand.quote({
        ...quoteArgs,
        sourceAddress: signer.address,
        maxUsdcIn: 2_000_000_000n,
      });
      const belowTarget = await purchaseCommand.quote({
        ...quoteArgs,
        sourceAddress: signer.address,
        maxUsdcIn: crossing.request.maxUsdcIn,
        sizeToTarget: true,
      });
      expect(crossing.request.maxUsdcIn).toBeGreaterThan(belowTarget.request.maxUsdcIn);
      await (
        await usdcContract.connect(signer).getFunction('approve')(crossing.adapterAddress, crossing.request.maxUsdcIn)
      ).wait();
      const adapter = new Contract(crossing.adapterAddress, EvmContracts.argonBuyAndTransferAbi, signer);
      const crossingGas = await adapter
        .getFunction('buyAndTransfer')
        .estimateGas(crossing.request, crossing.poolKey, '0x');
      const crossingReceipt = await (
        await adapter.getFunction('buyAndTransfer')(crossing.request, crossing.poolKey, '0x', {
          gasLimit: (crossingGas * 12n) / 10n + 50_000n,
        })
      ).wait();
      expect(crossingReceipt.status).toBe(1);

      // A positive purchase discount inside the one-cent margin earns no network reward.
      await runPrice(['--profile', 'joined', '--join', 'owner', '--argon', '1.052']);
      await (await gatewayContract.getFunction('setMinimumSwapMicrogons')(1_000_000n)).wait();
      const nearTarget = await purchaseCommand.quote({
        ...quoteArgs,
        sourceAddress: signer.address,
        maxUsdcIn: 2_000_000n,
      });
      expect(nearTarget.quotedMicrogonsOut).toBeGreaterThanOrEqual(nearTarget.minimumRewardPrincipal);
      expect(nearTarget.qualifiesForRewards).toBe(false);
      const nearTargetProjection = projectStabilizerBuyQuote({
        quote: nearTarget,
        feeEstimateWei: 0n,
        periodDays: 30,
        matchingRate: new BigNumber(1),
      })!;
      expect(nearTargetProjection.earnings.min).toBeGreaterThan(0n);
      expect(nearTargetProjection.earnings.max).toBe(nearTargetProjection.earnings.min);
    } finally {
      await purchaseCommand.close();
      await buys.close();
      await db.sql.close();
    }
  });
});
