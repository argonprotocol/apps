import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, inject, it, vi } from 'vitest';
import { createArgonClient, createDeferred, NetworkConfig } from '@argonprotocol/apps-core';
import { EvmContracts, getClient, getEthereumBeaconSyncState } from '@argonprotocol/mainchain';
import { TestEthereum } from '@argonprotocol/testing';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { JsonRpcProvider, Wallet } from 'ethers';
import { createPublicClient, getAddress, http } from 'viem';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import {
  createDevEthereumSetup,
  DEV_ETHEREUM_ADMIN_ACCOUNT,
  readDevEthereumRuntimeState,
  startDevEthereum,
} from '../devEthereum.ts';
import { setDevEthereumPoolPrice } from '../devEthereumStabilization.ts';

describe('local pool and Rust file oracle', { tags: ['isolated-argon-network'] }, () => {
  it(
    'publishes the deployed pool price and liquidity on Argon, and reuses the deployment on restart',
    { timeout: 900_000 },
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'stabilizer-oracle-'));
      vi.stubEnv('ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR', directory);
      vi.stubEnv('PRICE_INDEX_FILE_PATH', undefined);
      const network = await startArgonTestNetwork(`stabilizer-oracle-${inject('argonIntegrationRunId')}`, {
        profiles: ['all'],
        registerTeardown: false,
      });
      let ethereum: Awaited<ReturnType<typeof startDevEthereum>> | undefined;
      const client = createArgonClient(await getClient(network.networkConfigOverride.archiveUrl));
      const config = {
        beaconPreset: 'minimal',
        secondsPerSlot: 1,
        finalityMillis: 16_000,
        finalityBlocks: 16,
      } as const;
      const oracleContext = {
        composeDir: fileURLToPath(new URL('../argon', import.meta.url)),
        composeEnv: { ...network.composeEnv },
        composeProjectName: network.composeEnv.COMPOSE_PROJECT_NAME,
        profiles: ['all'],
      };
      const allowBootstrap = createDeferred<void>(false);
      const gatewayReady = createDeferred<void>(false);
      const allowPoolSetup = createDeferred<void>(false);
      const beaconProxy = createServer(async (request, response) => {
        try {
          await allowBootstrap.promise;
          const upstream = await fetch(new URL(request.url!, ethereum!.beaconApiUrl));
          response.writeHead(upstream.status, { 'content-type': 'application/json' });
          response.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (error) {
          response.destroy(error as Error);
        }
      });
      let setup: Promise<void> | undefined;

      try {
        ethereum = await startDevEthereum(config);
        await new Promise<void>(resolve => beaconProxy.listen(0, '127.0.0.1', resolve));
        const beaconApiUrl = `http://127.0.0.1:${(beaconProxy.address() as AddressInfo).port}`;
        setup = createDevEthereumSetup(
          network.networkConfigOverride.archiveUrl,
          { ...ethereum, beaconApiUrl },
          {
            ...config,
            oracleContext,
            networkConfigOverride: network.networkConfigOverride,
          },
        ).start(async () => {
          gatewayReady.resolve();
          await allowPoolSetup.promise;
          throw new Error('Synthetic upstream worker failed');
        });
        void setup.catch(() => undefined);

        // Gateway deployment can finish while the independent beacon endpoint is still waiting.
        await vi.waitFor(
          async () => {
            const pending = await readDevEthereumRuntimeState(ethereum!.executionRpcUrl);
            expect(pending?.gateway?.buyAndTransferAddress).toBeDefined();
            expect(pending?.setupStatus).toBe('starting');
          },
          { timeout: 120_000, interval: 500 },
        );
        expect((await getEthereumBeaconSyncState(client.raw)).isBootstrapped).toBe(false);
        allowBootstrap.resolve();
        await Promise.race([gatewayReady.promise, setup]);

        // Relay startup receives a usable gateway before pool publication or desktop readiness.
        const beforePool = (await readDevEthereumRuntimeState(ethereum.executionRpcUrl))!;
        expect((await getEthereumBeaconSyncState(client.raw)).isBootstrapped).toBe(true);
        const chainConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
        if (chainConfig?.type !== 'Evm') throw new Error('The relay needs an Ethereum gateway configuration');
        expect(chainConfig.value.gateway.toLowerCase()).toBe(beforePool.gateway!.gatewayAddress.toLowerCase());
        expect(NetworkConfig.get().esploraHost).toBe(network.networkConfigOverride.esploraHost);
        expect(NetworkConfig.get().indexerHost).toBe(network.networkConfigOverride.indexerHost);
        const councilHash =
          await client.query.crosschainTransfer.activeGlobalIssuanceCouncilByDestinationChain('Ethereum');
        const council = await client.query.crosschainTransfer.globalIssuanceCouncilByHash(councilHash!);
        const ethereumClient = createPublicClient({ transport: http(ethereum.executionRpcUrl) });
        const ethereumCouncil = await ethereumClient.readContract({
          address: getAddress(beforePool.gateway!.gatewayAddress),
          abi: EvmContracts.mintingGatewayAbi,
          functionName: 'globalIssuanceCouncil',
        });
        expect(councilHash!.toLowerCase()).toBe(ethereumCouncil[2].toLowerCase());
        expect(council?.totalWeight).toBe(ethereumCouncil[0]);
        expect(council!.totalWeight).toBeGreaterThan(0n);
        expect(council?.epochMicrogonsPerArgonot).toBe(ethereumCouncil[3]);
        const [member] = Object.values(council!.members);
        expect(Object.keys(council!.members)).toHaveLength(1);
        expect(member.weight).toBe(council!.totalWeight);
        expect(await client.query.vaults.vaultIdByOperator(member.accountId)).not.toBeNull();
        expect(
          await client.query.crosschainTransfer.councilSignerByDestinationChainAndAccountId(
            'Ethereum',
            member.accountId,
          ),
        ).toBe(member.signer);
        expect(
          await client.query.crosschainTransfer.currentTransferOutMicrogonsPerArgonotByDestinationChain('Ethereum'),
        ).toBe(ethereumCouncil[3]);
        expect(await client.query.crosschainTransfer.mintingAuthoritiesBySigner.entries()).toEqual([]);
        expect(beforePool.setupStatus).toBe('starting');
        expect(beforePool.stabilization?.deployment).toBeUndefined();
        expect(await client.query.stabilizerBuys.approvedPool()).toBeNull();
        allowPoolSetup.resolve();
        await expect(setup).rejects.toThrow('Synthetic upstream worker failed');

        const afterFailure = (await readDevEthereumRuntimeState(ethereum.executionRpcUrl))!;
        expect(afterFailure.gateway).toEqual(beforePool.gateway);
        expect(afterFailure.setupStatus).toBe('starting');
        expect(afterFailure.stabilization?.deployment).toBeUndefined();

        const resumed = await startDevEthereum(config, afterFailure.gateway);
        setup = createDevEthereumSetup(network.networkConfigOverride.archiveUrl, resumed, {
          ...config,
          oracleContext,
          networkConfigOverride: network.networkConfigOverride,
        }).start();
        await setup;

        const saved = (await readDevEthereumRuntimeState(ethereum.executionRpcUrl))!;
        const deployment = saved.stabilization!.deployment!;
        expect(saved.gateway?.buyAndTransferAddress).toBeDefined();
        expect((await client.query.stabilizerBuys.approvedPool())?.poolId).toBe(deployment.pool.poolId);
        expect(
          (
            await client.query.stabilizerPools.pools(deployment.pool.poolManager, deployment.pool.poolId)
          )?.subscriber.toLowerCase(),
        ).toBe(deployment.contracts.stabilizationPoolSubscriber.address.toLowerCase());

        await vi.waitFor(
          async () => {
            const prices = await runtimeClient(client).query.priceIndex.current();
            expect(prices).toMatchObject({ stabilizerPoolSqrtPriceX96: BigInt(deployment.pool.sqrtPriceX96) });
            expect(prices?.argonTimeWeightedAverageLiquidity.gt(0)).toBe(true);
            expect(prices?.argonTimeWeightedAverageLiquidity.eq(100_000_000)).toBe(false);
            expect(prices?.argonUsdTargetPrice.toNumber()).toBe(1.06);
            expect(prices?.argonUsdPrice.toNumber()).toBeCloseTo(1.06, 2);
          },
          { timeout: 180_000, interval: 1_000 },
        );

        const provider = new JsonRpcProvider(ethereum.executionRpcUrl, undefined, { cacheTimeout: -1 });
        let changedPrice: bigint;
        try {
          const result = await setDevEthereumPoolPrice({
            signer: new Wallet(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey, provider),
            ethereum: saved,
            priceUsdc: '0.95',
          });
          expect(result.transactionHash).toBeDefined();
          changedPrice = result.sqrtPriceX96;
        } finally {
          provider.destroy();
        }
        await vi.waitFor(
          async () => {
            const prices = await runtimeClient(client).query.priceIndex.current();
            expect(prices).toMatchObject({ stabilizerPoolSqrtPriceX96: changedPrice });
            expect(prices?.argonUsdPrice.toNumber()).toBeLessThan(1);
          },
          { timeout: 180_000, interval: 1_000 },
        );

        const restarted = await startDevEthereum(config, saved.gateway);
        await createDevEthereumSetup(network.networkConfigOverride.archiveUrl, restarted, {
          ...config,
          oracleContext,
          networkConfigOverride: network.networkConfigOverride,
        }).start();
        const afterRestart = (await readDevEthereumRuntimeState(restarted.executionRpcUrl))!;
        expect(afterRestart.gateway).toEqual(saved.gateway);
        expect(afterRestart.stabilization?.deployment).toEqual(saved.stabilization?.deployment);
        expect(afterRestart.stabilization?.liquidityTokenId).toBe(saved.stabilization?.liquidityTokenId);
        expect(afterRestart.setupStatus).toBe('ready');
        expect(await client.query.crosschainTransfer.activeGlobalIssuanceCouncilByDestinationChain('Ethereum')).toBe(
          councilHash,
        );
        expect(await runtimeClient(client).query.priceIndex.current()).toMatchObject({
          stabilizerPoolSqrtPriceX96: changedPrice,
        });
      } finally {
        allowBootstrap.resolve();
        allowPoolSetup.resolve();
        await setup?.catch(() => undefined);
        if (beaconProxy.listening) {
          await new Promise<void>((resolve, reject) => {
            beaconProxy.close(error => {
              if (error) reject(error);
              else resolve();
            });
          });
        }
        await client.disconnect();
        if (ethereum) await new TestEthereum(ethereum.enclaveName).teardown();
        await network.stop();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
