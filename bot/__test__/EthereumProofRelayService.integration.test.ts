import Path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlockWatch, MainchainClients, NetworkConfig, TransactionEvents } from '@argonprotocol/apps-core';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import {
  buildEthereumEventProof,
  dispatchErrorToString,
  findEthereumBurnForTransferLogIndex,
  getClient,
  getEthereumBeaconSyncBootstrapTx,
  getEthereumBeaconSyncState,
  Keyring,
  MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
  mintingGatewayArtifact,
  TxSubmitter,
  waitForRetainedExecutionAnchor,
  type ArgonClient,
  type KeyringPair,
} from '@argonprotocol/mainchain';
import { teardown, TestEthereum } from '@argonprotocol/testing';
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DelegateSubmitLane } from '../src/DelegateSubmitLane.ts';
import { EthereumBeaconSyncService } from '../src/EthereumBeaconSyncService.ts';
import { EthereumProofRelayService } from '../src/EthereumProofRelayService.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));
const runEthereumRelayerIntegration = Boolean(JSON.parse(process.env.RUN_ETHEREUM_RELAYER_INTEGRATION ?? '0'));
const ethereumPreset = 'minimal';
const burnAmountRuntimeBaseUnits = 1_000_000n;
const delegateFeeBuffer = 250_000n;
const testTimeoutMs = 360e3;
const devEthereumAdminAccount = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
  balance: '100ETH',
} as const;

describe
  .skipIf(skipE2E || !runEthereumRelayerIntegration || !TestEthereum.isInstalled())
  .sequential('EthereumProofRelayService integration', { timeout: testTimeoutMs }, () => {
    let archiveClient: ArgonClient;
    let argonTokenAddress: Address;
    let blockWatch: BlockWatch;
    let clients: MainchainClients;
    let delegateKeypair: KeyringPair;
    let ethereumProofRelayService: EthereumProofRelayService;
    let executionPublicClient: ReturnType<typeof createPublicClient>;
    let executionRpcUrl: string;
    let beaconApiUrl: string;
    let gatewayAddress: Address;

    beforeAll(async () => {
      NetworkConfig.setNetwork('dev-docker');

      const network = await startArgonTestNetwork(Path.basename(import.meta.filename), {
        chainStartTimeoutMs: 120_000,
        chainStartPollMs: 250,
      });

      archiveClient = await getClient(network.archiveUrl);
      clients = new MainchainClients(network.archiveUrl, () => false, archiveClient);
      blockWatch = new BlockWatch(clients);
      await blockWatch.start();

      const ethereum = new TestEthereum();
      const endpoints = await ethereum.launch({
        consensusClient: 'lighthouse',
        preset: ethereumPreset,
        secondsPerSlot: 1,
        waitForFinalization: false,
        prefundedAccounts: {
          [devEthereumAdminAccount.address]: {
            balance: devEthereumAdminAccount.balance,
          },
        },
      });
      executionRpcUrl = endpoints.executionRpcUrl;
      beaconApiUrl = endpoints.beaconApiUrl;

      const chain = defineExecutionChain(endpoints.chainId, executionRpcUrl);
      executionPublicClient = createPublicClient({
        chain,
        transport: http(executionRpcUrl, {
          retryCount: 1,
          timeout: 15_000,
        }),
      });

      const fixture = await ethereum.deployMintingGatewayFixture({
        deployerPrivateKey: devEthereumAdminAccount.privateKey,
        seedArgonRecipient: devEthereumAdminAccount.address,
        seedArgonAmountBaseUnits: 1_000_000_000n,
      });
      gatewayAddress = fixture.gatewayAddress;
      argonTokenAddress = fixture.argonTokenAddress;

      await ensureEthereumBeaconBootstrap(archiveClient, beaconApiUrl);
      await ensureEthereumChainConfig(archiveClient, fixture);

      delegateKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Ferdie//ethereum-relay');
      const submitLane = new DelegateSubmitLane(delegateKeypair);
      submitLane.client = archiveClient;
      ethereumProofRelayService = new EthereumProofRelayService(submitLane);
    }, testTimeoutMs);

    afterAll(async () => {
      blockWatch?.destroy();
      await clients?.disconnect().catch(() => undefined);
      await teardown();
    });

    it('finalizes a relayed ARGN proof and recovers the relay fee back to the delegate', async () => {
      const burnReceipt = await approveAndBurnArgon({
        argonTokenAddress,
        executionRpcUrl,
        publicClient: executionPublicClient,
        gatewayAddress,
      });
      const burnLogIndex = findEthereumBurnForTransferLogIndex(burnReceipt, gatewayAddress);

      expect(burnLogIndex).toBeGreaterThanOrEqual(0);

      await syncEthereumHeadersUntilRetainedAnchor({
        client: archiveClient,
        beaconApiUrl,
        targetBlockNumber: burnReceipt.blockNumber,
      });

      const proof = await buildEthereumEventProof(archiveClient, {
        txHash: burnReceipt.transactionHash,
        logIndex: burnLogIndex,
        executionRpcUrl,
        receipt: burnReceipt,
      });

      const relayRequest = {
        transferProof: {
          Ethereum: {
            sourceChain: 'Ethereum',
            eventLog: proof.eventLog,
            proof: proof.proof,
          },
        },
      } as const;
      const estimatedFee = await archiveClient.tx.crosschainTransfer
        .proveTransfer(relayRequest.transferProof)
        .paymentInfo(delegateKeypair.address)
        .then(x => x.partialFee.toBigInt());

      expect(estimatedFee).toBeLessThan(burnAmountRuntimeBaseUnits);

      await fundRelayDelegate(archiveClient, delegateKeypair.address, estimatedFee + delegateFeeBuffer);
      const burnAccount = archiveClient.consts.crosschainTransfer.ethereumBurnAccount.toString();
      const fundBurnAccountResult = await new TxSubmitter(
        archiveClient,
        archiveClient.tx.balances.transferAllowDeath(
          burnAccount,
          burnAmountRuntimeBaseUnits + archiveClient.consts.balances.existentialDeposit.toBigInt(),
        ),
        new Keyring({ type: 'sr25519' }).createFromUri('//Alice'),
      ).submit();
      await fundBurnAccountResult.waitForInFirstBlock;
      if (fundBurnAccountResult.extrinsicError) {
        throw fundBurnAccountResult.extrinsicError;
      }
      const delegateBalanceBeforeRelay = await archiveClient.query.system
        .account(delegateKeypair.address)
        .then(x => x.data.free.toBigInt());

      const relayResult = await ethereumProofRelayService.relayTransferProof(relayRequest);

      expect(relayResult.outcome).toBe('Submitted');
      if (relayResult.outcome !== 'Submitted') return;

      const finalizedRelayTx = await waitFor(
        120_000,
        'relayed proveTransfer finalization',
        async () => {
          const tx = await TransactionEvents.findByExtrinsicHash({
            blockWatch,
            extrinsicHash: relayResult.argonTxHash,
            searchStartBlockHeight: relayResult.txSubmittedAtBlockHeight,
            bestBlockHeight: blockWatch.bestBlockHeader.blockNumber,
            ignoreHeaderErrors: true,
          });
          if (!tx) return;
          if (blockWatch.finalizedBlockHeader.blockNumber < tx.blockNumber) return;
          return tx;
        },
        { pollMs: 1_000 },
      );

      expect(finalizedRelayTx.error).toBeUndefined();
      expect(
        finalizedRelayTx.extrinsicEvents.some(event =>
          archiveClient.events.crosschainTransfer.BurnNoticeAccepted.is(event),
        ),
      ).toBe(true);

      const delegateBalanceAfterRelay = await archiveClient.query.system
        .account(delegateKeypair.address)
        .then(x => x.data.free.toBigInt());

      expect(finalizedRelayTx.fee).toBeGreaterThan(0n);
      expect(delegateBalanceAfterRelay).toBeGreaterThanOrEqual(delegateBalanceBeforeRelay);
    });
  });

function defineExecutionChain(chainIdHex: string, executionRpcUrl: string) {
  return defineChain({
    id: Number.parseInt(chainIdHex, 16),
    name: 'argon-relayer-test-ethereum',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [executionRpcUrl],
      },
    },
  });
}

async function ensureEthereumBeaconBootstrap(client: ArgonClient, beaconApiUrl: string): Promise<void> {
  const state = await getEthereumBeaconSyncState(client);
  if (state.isBootstrapped) {
    return;
  }

  const sudoKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
  const bootstrapTx = await waitFor(
    60_000,
    'ethereum light-client bootstrap endpoint',
    async () => {
      try {
        return await getEthereumBeaconSyncBootstrapTx(client, beaconApiUrl);
      } catch (error) {
        if (isBootstrapNotReady(error)) {
          return;
        }
        throw error;
      }
    },
    { pollMs: 1_000 },
  );

  const bootstrapResult = await new TxSubmitter(client, client.tx.sudo.sudo(bootstrapTx), sudoKeypair).submit();
  await bootstrapResult.waitForInFirstBlock;

  const sudoResultEvent = bootstrapResult.events.find(event => client.events.sudo.Sudid.is(event));
  if (!sudoResultEvent || !client.events.sudo.Sudid.is(sudoResultEvent)) {
    throw new Error('Bootstrap transaction did not emit sudo.Sudid.');
  }
  if (sudoResultEvent.data.sudoResult.isErr) {
    throw new Error(`Bootstrap failed: ${dispatchErrorToString(client, sudoResultEvent.data.sudoResult.asErr as any)}`);
  }
}

async function ensureEthereumChainConfig(
  client: ArgonClient,
  fixture: {
    gatewayAddress: Hex;
    argonTokenAddress: Hex;
    argonotTokenAddress: Hex;
  },
): Promise<void> {
  const currentConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
  if (currentConfig.isSome && currentConfig.unwrap().isEthereum) {
    const ethereumConfig = currentConfig.unwrap().asEthereum;
    const isMatch =
      ethereumConfig.gateway.toHex().toLowerCase() === fixture.gatewayAddress.toLowerCase() &&
      ethereumConfig.argonToken.toHex().toLowerCase() === fixture.argonTokenAddress.toLowerCase() &&
      ethereumConfig.argonotToken.toHex().toLowerCase() === fixture.argonotTokenAddress.toLowerCase();
    if (isMatch) {
      return;
    }
  }

  const sudoKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
  const configResult = await new TxSubmitter(
    client,
    client.tx.sudo.sudo(
      client.tx.crosschainTransfer.setChainConfig({
        Ethereum: {
          gateway: fixture.gatewayAddress,
          argonToken: fixture.argonTokenAddress,
          argonotToken: fixture.argonotTokenAddress,
          previousGateway: null,
          previousReleaseExpiration: null,
        },
      }),
    ),
    sudoKeypair,
  ).submit();
  await configResult.waitForInFirstBlock;

  const sudoResultEvent = configResult.events.find(event => client.events.sudo.Sudid.is(event));
  if (!sudoResultEvent || !client.events.sudo.Sudid.is(sudoResultEvent)) {
    throw new Error('Ethereum chain-config transaction did not emit sudo.Sudid.');
  }
  if (sudoResultEvent.data.sudoResult.isErr) {
    throw new Error(
      `Ethereum chain-config setup failed: ${dispatchErrorToString(client, sudoResultEvent.data.sudoResult.asErr as any)}`,
    );
  }
}

async function fundRelayDelegate(client: ArgonClient, delegateAddress: string, amount: bigint): Promise<void> {
  const sudoKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
  const result = await new TxSubmitter(
    client,
    client.tx.balances.transferAllowDeath(delegateAddress, amount),
    sudoKeypair,
  ).submit();
  await result.waitForInFirstBlock;
}

async function approveAndBurnArgon(args: {
  argonTokenAddress: Address;
  executionRpcUrl: string;
  publicClient: ReturnType<typeof createPublicClient>;
  gatewayAddress: Address;
}) {
  const { argonTokenAddress, executionRpcUrl, publicClient, gatewayAddress } = args;
  const destinationAccount = new Keyring({ type: 'sr25519' }).createFromUri('//Bob');
  const destinationHex = toHex(destinationAccount.publicKey, { size: 32 });
  const burnAmountBaseUnits = burnAmountRuntimeBaseUnits * MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;

  const approveTx = await sendDevEthereumAdminTransaction({
    rpcUrl: executionRpcUrl,
    to: argonTokenAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [gatewayAddress, burnAmountBaseUnits],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx.hash });

  const burnTx = await sendDevEthereumAdminTransaction({
    rpcUrl: executionRpcUrl,
    to: gatewayAddress,
    data: encodeFunctionData({
      abi: mintingGatewayArtifact.abi,
      functionName: 'burnForTransfer',
      args: [argonTokenAddress, burnAmountRuntimeBaseUnits, destinationHex],
    }),
  });

  return publicClient.waitForTransactionReceipt({
    hash: burnTx.hash,
  });
}

async function syncEthereumHeadersUntilRetainedAnchor(args: {
  client: ArgonClient;
  beaconApiUrl: string;
  targetBlockNumber: bigint;
}): Promise<void> {
  const { client, beaconApiUrl, targetBlockNumber } = args;
  const syncKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Charlie');
  const submitLane = new DelegateSubmitLane(syncKeypair);
  submitLane.client = client;
  const ethereumBeaconSyncService = new EthereumBeaconSyncService(client, {
    beaconApiUrl,
    submitLane,
  });

  try {
    const anchorSyncDeadline = Date.now() + 180_000;

    while (true) {
      await ethereumBeaconSyncService.runOnce();

      try {
        await waitForRetainedExecutionAnchor(client, targetBlockNumber, {
          pollMs: 250,
          timeoutMs: 1_000,
        });
        return;
      } catch (error) {
        if (Date.now() >= anchorSyncDeadline) {
          throw error;
        }
      }
    }
  } finally {
    await ethereumBeaconSyncService.shutdown().catch(() => undefined);
  }
}

function isBootstrapNotReady(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('/eth/v1/beacon/light_client/bootstrap/') && message.includes('404');
}

async function sendDevEthereumAdminTransaction(args: {
  rpcUrl: string;
  to: Address;
  value?: bigint;
  data?: Hex;
}): Promise<{ hash: Hash; sender: Address }> {
  const { rpcUrl, to, data, value = 0n } = args;
  const account = privateKeyToAccount(devEthereumAdminAccount.privateKey);
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const chainId = await publicClient.getChainId();
  const chain = defineExecutionChain(`0x${chainId.toString(16)}`, rpcUrl);
  const nonce = await publicClient.getTransactionCount({
    address: account.address,
  });
  const gas = await publicClient.estimateGas({
    account: account.address,
    to,
    value,
    data,
  });
  const fees = await publicClient.estimateFeesPerGas({
    chain,
    type: 'eip1559',
  });

  if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) {
    throw new Error('Unable to estimate EIP-1559 fees for the local dev Ethereum network.');
  }

  const serializedTransaction = await account.signTransaction({
    type: 'eip1559',
    chain,
    chainId,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    to,
    value,
    data,
  });
  const hash = await publicClient.sendRawTransaction({
    serializedTransaction,
  });

  return {
    hash,
    sender: account.address,
  };
}
