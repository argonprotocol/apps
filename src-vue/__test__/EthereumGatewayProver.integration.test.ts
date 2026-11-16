import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, ZeroHash, concat, hexlify } from 'ethers';
import { describe, expect, inject, it, vi } from 'vitest';
import { TestEthereum } from '@argonprotocol/testing';
import {
  Keyring,
  EvmContracts,
  type CapturedGatewayActivityStorageProof,
  buildGatewayActivityReceiptProofPayloads,
  decodeExecutionHeaderRlp,
  discoverMissingGatewayActivityLocators,
} from '@argonprotocol/mainchain';
import {
  JsonExt,
  MainchainClients,
  BlockWatch,
  NetworkConfig,
  TxSigner,
  getLatestArgonFinalizedExecutionHeader,
} from '@argonprotocol/apps-core';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.ts';
import { integrationAccountUri } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { erc20Abi, hexToBytes, toHex, size } from 'viem';
import {
  createDevEthereumSetup,
  DEV_ETHEREUM_ADMIN_ACCOUNT,
  readDevEthereumRuntimeState,
  startDevEthereum,
} from '../../e2e/devEthereum.ts';
import { DelegateSubmitLane } from '../../bot/src/DelegateSubmitLane.ts';
import { EthereumBeaconSyncService } from '../../bot/src/EthereumBeaconSyncService.ts';
import { EthereumGatewayProverService } from '../../bot/src/EthereumGatewayProverService.ts';

describe('Ethereum gateway proof relay', { tags: ['isolated-argon-network'] }, () => {
  it(
    'relays an oversized receipt from a persisted storage capture after restart, then falls back to receipts',
    async () => {
      const startedAt = Date.now();
      const directory = await mkdtemp(join(tmpdir(), 'gateway-proof-relay-'));
      vi.stubEnv('ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR', directory);
      let network: Awaited<ReturnType<typeof startArgonTestNetwork>> | undefined;
      let ethereum: Awaited<ReturnType<typeof startDevEthereum>> | undefined;
      let clients: MainchainClients | undefined;
      let blockWatch: BlockWatch | undefined;
      let provider: JsonRpcProvider | undefined;
      let beacon: EthereumBeaconSyncService | undefined;
      let prover: EthereumGatewayProverService | undefined;
      let blockLogs = false;
      let proofPolicy: 'all' | 'none' | 'head' = 'all';
      let proofHead: string | undefined;
      let finalizedSnapshot: bigint | undefined;
      let rpcRequests: Record<string, number> = {};
      const blockedMethods: string[] = [];
      const proxy = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        const rpc = JSON.parse(body);
        rpcRequests[rpc.method] = (rpcRequests[rpc.method] ?? 0) + 1;
        if (rpc.method === 'eth_getBlockByNumber' && rpc.params[0] === 'finalized' && finalizedSnapshot !== undefined) {
          rpc.params[0] = toHex(finalizedSnapshot);
          body = JSON.stringify(rpc);
        }
        const proofUnavailable =
          rpc.method === 'eth_getProof' &&
          (proofPolicy === 'none' || (proofPolicy === 'head' && rpc.params[2] !== proofHead));
        if (proofUnavailable || (blockLogs && rpc.method === 'eth_getLogs')) {
          blockedMethods.push(rpc.method);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32601, message: 'Historical proof reads are unavailable' },
            }),
          );
          return;
        }
        try {
          const upstream = await fetch(ethereum!.executionRpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
          const result = await upstream.text();
          if (rpc.method === 'eth_getBlockByNumber' && rpc.params[0] === 'latest') {
            proofHead = JSON.parse(result).result?.number;
          }
          response.writeHead(upstream.status, { 'content-type': 'application/json' });
          response.end(result);
        } catch {
          response.writeHead(502);
          response.end();
        }
      });
      try {
        network = await startArgonTestNetwork(`gateway-proof-${inject('argonIntegrationRunId')}`, {
          profiles: ['all'],
          ticksBetweenSlots: 6,
          registerTeardown: false,
        });
        vi.stubEnv('COMPOSE_PROJECT_NAME', network.composeEnv.COMPOSE_PROJECT_NAME);
        const timing = {
          beaconPreset: 'minimal',
          secondsPerSlot: 1,
          finalityMillis: 16_000,
          finalityBlocks: 16,
        } as const;
        ethereum = await startDevEthereum(timing);
        await createDevEthereumSetup(network.archiveUrl, ethereum, {
          ...timing,
          oracleContext: {
            composeDir: fileURLToPath(new URL('../../e2e/argon', import.meta.url)),
            composeEnv: network.composeEnv,
            composeProjectName: network.composeEnv.COMPOSE_PROJECT_NAME,
            profiles: ['all'],
          },
          networkConfigOverride: network.networkConfigOverride,
        }).start();
        const deployment = (await readDevEthereumRuntimeState(ethereum.executionRpcUrl))!.gateway!;
        await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const address = proxy.address();
        if (!address || typeof address === 'string') throw new Error('Missing local RPC proxy port');
        NetworkConfig.setNetwork('dev-docker');
        const config = {
          ...network.networkConfigOverride,
          ethereumNetwork: { executionRpcUrls: [`http://127.0.0.1:${address.port}`], finalityBlocks: 16 },
        };
        NetworkConfig.setRuntimeOverride('dev-docker', config);
        clients = new MainchainClients(network.archiveUrl, () => false);
        const client = await clients.get(false);
        blockWatch = new BlockWatch(clients);
        await blockWatch.start();
        const keyring = new Keyring({ type: 'sr25519' });
        const relay = new TxSigner(
          keyring.createFromUri(integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'relay')),
        );
        const recipient = keyring.createFromUri(
          integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'recipient'),
        );
        const lane = new DelegateSubmitLane(relay);
        lane.client = client;
        beacon = new EthereumBeaconSyncService(client, {
          beaconApiUrl: ethereum.beaconApiUrl,
          pollMs: 1_000,
          submitLane: lane,
        });
        prover = new EthereumGatewayProverService(lane, blockWatch, directory, {
          shouldApplySharedRelayStagger: false,
        });
        expect(typeof client.tx.crosschainTransfer.proveGatewayActivityStorage).toBe('function');

        provider = new JsonRpcProvider(ethereum.executionRpcUrl, undefined, { cacheTimeout: -1 });
        const admin = new Wallet(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey, provider);
        const token = new Contract(deployment.argonTokenAddress, erc20Abi, admin);
        const gateway = new Contract(deployment.gatewayAddress, EvmContracts.mintingGatewayAbi, admin);
        const amount = 1_000_000n;
        const startingBalance = (await client.query.system.account(recipient.address)).data.free;

        // Contract wallet: forward calldata after its 20-byte destination, then emit an unrelated 4 KiB log.
        const runtime = [
          0x60, 0x14, 0x36, 0x03, 0x60, 0x14, 0x5f, 0x37, 0x5f, 0x5f, 0x60, 0x14, 0x36, 0x03, 0x5f, 0x5f, 0x5f, 0x35,
          0x60, 0x60, 0x1c, 0x5a, 0xf1, 0x15, 0x60, 0, 0x57, 0x61, 0x10, 0x00, 0x5f, 0xa0, 0x00,
        ];
        runtime[25] = runtime.length;
        runtime.push(0x5b, 0x3d, 0x5f, 0x5f, 0x3e, 0x3d, 0x5f, 0xfd);
        const init = hexlify(
          Uint8Array.from([
            0x60,
            runtime.length,
            0x60,
            0x0c,
            0x60,
            0x00,
            0x39,
            0x60,
            runtime.length,
            0x60,
            0x00,
            0xf3,
            ...runtime,
          ]),
        );
        const wallet = await new ContractFactory([], init, admin).deploy();
        await wallet.waitForDeployment();
        const walletAddress = await wallet.getAddress();
        const baseUnits = amount * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
        await (await token.getFunction('transfer').send(walletAddress, baseUnits)).wait();
        await (
          await admin.sendTransaction({
            to: walletAddress,
            data: concat([
              deployment.argonTokenAddress,
              token.interface.encodeFunctionData('approve', [deployment.gatewayAddress, baseUnits]),
            ]),
          })
        ).wait();
        const transfer = [deployment.argonTokenAddress, amount, toHex(recipient.publicKey), 0n, 0, ZeroHash, ZeroHash];
        await (
          await admin.sendTransaction({
            to: walletAddress,
            data: concat([
              deployment.gatewayAddress,
              gateway.interface.encodeFunctionData('startTransferToArgon', transfer),
            ]),
            gasLimit: 1_000_000n,
          })
        ).wait();
        const firstNonce: bigint = await gateway.getFunction('gatewayActivityNonce')();

        // The capture precedes Argon's execution anchor; no beacon sync runs until after restart.
        await waitFor(120_000, 'Ethereum finalizes the gateway activity', async () => {
          const locators = await discoverMissingGatewayActivityLocators({
            executionRpcUrl: ethereum!.executionRpcUrl,
            gatewayAddress: deployment.gatewayAddress,
            minimumGatewayActivityNonce: firstNonce,
            finalizedExecutionBlockNumber: BigInt((await provider!.getBlock('finalized'))!.number),
          });
          return locators.length > 0;
        });
        expect(await prover.getRelayStatus()).toMatchObject({ isReady: false });
        finalizedSnapshot = BigInt((await provider.getBlock('finalized'))!.number);
        rpcRequests = {};
        await prover.start();
        console.log('Gateway RPC profile', {
          elapsedMs: Date.now() - startedAt,
          stage: 'capture',
          requests: rpcRequests,
        });
        expect(existsSync(join(directory, 'ethereum-gateway-activities.json'))).toBe(true);
        const captured: {
          byGateway: Record<string, CapturedGatewayActivityStorageProof[]>;
        } = JsonExt.parse(await readFile(join(directory, 'ethereum-gateway-activities.json'), 'utf8'));
        const records = captured.byGateway[`${client.genesisHash.toHex()}:${deployment.gatewayAddress.toLowerCase()}`];
        expect(records.at(-1)?.activities.at(-1)?.gatewayState.gatewayActivityNonce).toBe(firstNonce);
        const capturedHeader = decodeExecutionHeaderRlp(hexToBytes(records.at(-1)!.executionHeaderRlp));
        expect(capturedHeader.number).toBe(finalizedSnapshot);
        expect(
          records
            .at(-1)
            ?.proof.activityLogs.some(log => log.address.toLowerCase() === deployment.gatewayAddress.toLowerCase()),
        ).toBe(true);
        finalizedSnapshot = undefined;
        rpcRequests = {};
        await expect(
          prover.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: firstNonce }),
        ).rejects.toThrow('not ready to relay');
        expect(rpcRequests.eth_getProof ?? 0).toBe(0);
        expect(rpcRequests.eth_getLogs ?? 0).toBe(0);
        console.log('Gateway RPC profile', {
          elapsedMs: Date.now() - startedAt,
          stage: 'deferred checkpoint',
          requests: rpcRequests,
        });
        await prover.shutdown();
        await sudoFundWallet({ client, address: relay.address, microgons: 100_000_000n, micronots: 0n });

        const captureBlock = BigInt((await provider.getBlock('latest'))!.number);
        await waitFor(120_000, 'Argon anchors the captured execution state', async () => {
          await beacon!.runOnce();
          return (await getLatestArgonFinalizedExecutionHeader(client)).blockNumber >= captureBlock;
        });
        const locators = await discoverMissingGatewayActivityLocators({
          executionRpcUrl: ethereum.executionRpcUrl,
          gatewayAddress: deployment.gatewayAddress,
          minimumGatewayActivityNonce: firstNonce,
          finalizedExecutionBlockNumber: BigInt((await provider.getBlock('finalized'))!.number),
        });
        const receipts = await buildGatewayActivityReceiptProofPayloads(client.raw, {
          executionRpcUrl: ethereum.executionRpcUrl,
          gatewayAddress: deployment.gatewayAddress,
          locators,
        });
        const largestReceiptNode = Math.max(
          ...receipts.payloads.flatMap(payload =>
            payload.proof.blocks.flatMap(block => block.receiptProof.nodes.map(size)),
          ),
        );
        expect(largestReceiptNode).toBeGreaterThan(4096);

        proofPolicy = 'none';
        blockLogs = true;
        rpcRequests = {};
        prover = new EthereumGatewayProverService(lane, blockWatch, directory, {
          shouldApplySharedRelayStagger: false,
        });
        await prover.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: firstNonce });
        await waitFor(
          30_000,
          'storage proof credits the recipient after restart',
          async () => (await client.query.system.account(recipient.address)).data.free === startingBalance + amount,
        );
        expect(blockedMethods).toEqual([]);
        console.log('Gateway RPC profile', {
          elapsedMs: Date.now() - startedAt,
          stage: 'restart checkpoint',
          requests: rpcRequests,
        });
        expect(
          (await client.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum'))?.gatewayActivityNonce,
        ).toBe(firstNonce);

        // The provider now lacks eth_getProof, but ordinary receipts must still advance the stream.
        blockLogs = false;
        rpcRequests = {};
        await (await token.getFunction('approve').send(deployment.gatewayAddress, baseUnits)).wait();
        await (await gateway.getFunction('startTransferToArgon').send(...transfer)).wait();
        const nextNonce: bigint = await gateway.getFunction('gatewayActivityNonce')();
        const nextBlock = BigInt((await provider.getBlock('latest'))!.number);
        await waitFor(120_000, 'receipt fallback advances the gateway stream', async () => {
          await beacon!.runOnce();
          if ((await getLatestArgonFinalizedExecutionHeader(client)).blockNumber < nextBlock) return false;
          await prover!.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: nextNonce });
          return (await client.query.system.account(recipient.address)).data.free === startingBalance + 2n * amount;
        });
        expect(blockedMethods).toContain('eth_getProof');
        console.log('Gateway RPC profile', {
          elapsedMs: Date.now() - startedAt,
          stage: 'receipt fallback and anchor',
          requests: rpcRequests,
        });
        expect(
          (await client.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum'))?.gatewayActivityNonce,
        ).toBe(nextNonce);

        // Head-only proof providers still use storage when historical state is unavailable.
        console.log('Gateway RPC profile', { elapsedMs: Date.now() - startedAt, stage: 'head-state fallback start' });
        proofPolicy = 'head';
        blockedMethods.length = 0;
        rpcRequests = {};
        await (await token.getFunction('approve').send(deployment.gatewayAddress, baseUnits)).wait();
        await (await gateway.getFunction('startTransferToArgon').send(...transfer)).wait();
        const finalNonce: bigint = await gateway.getFunction('gatewayActivityNonce')();
        const finalBlock = BigInt((await provider.getBlock('latest'))!.number);
        await waitFor(120_000, 'head-state storage fallback advances the gateway stream', async () => {
          await beacon!.runOnce();
          if ((await getLatestArgonFinalizedExecutionHeader(client)).blockNumber < finalBlock) return false;
          try {
            const response = await prover!.runToCheckpoint({
              sourceChain: 'Ethereum',
              throughGatewayActivityNonce: finalNonce,
            });
            if (response.outcome === 'Submitted')
              expect(response.extrinsicMethodJson.method).toBe('proveGatewayActivityStorage');
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('not ready to relay')) throw error;
            return false;
          }
          return (await client.query.system.account(recipient.address)).data.free === startingBalance + 3n * amount;
        });
        expect(blockedMethods).toContain('eth_getProof');
        console.log('Gateway RPC profile', {
          elapsedMs: Date.now() - startedAt,
          stage: 'head-state fallback and anchor',
          requests: rpcRequests,
        });
        const retained: typeof captured = JsonExt.parse(
          await readFile(join(directory, 'ethereum-gateway-activities.json'), 'utf8'),
        );
        expect(
          retained.byGateway[`${client.genesisHash.toHex()}:${deployment.gatewayAddress.toLowerCase()}`].at(-1)
            ?.endGatewayActivityNonce,
        ).toBe(finalNonce);
        expect(
          (await client.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum'))?.gatewayActivityNonce,
        ).toBe(finalNonce);
      } finally {
        await prover?.shutdown();
        await beacon?.shutdown();
        provider?.destroy();
        blockWatch?.stop();
        await clients?.disconnect();
        if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
        try {
          if (ethereum) await new TestEthereum(ethereum.enclaveName).teardown();
        } finally {
          await network?.stop();
          NetworkConfig.clearRuntimeOverride('dev-docker');
          vi.unstubAllEnvs();
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    30 * 60_000,
  );
});
