import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchErrorToString,
  getClient,
  Keyring,
  mintingGatewayArtifact,
  TxSubmitter,
  waitForRetainedExecutionAnchor,
} from '@argonprotocol/mainchain';
import { teardown, TestEthereum } from '@argonprotocol/testing';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { EthereumBeaconSyncService, waitForFinalizedBeaconExecutionAtOrAbove } from '@argonprotocol/apps-bot';
import { MoveToken } from '@argonprotocol/apps-core';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { EthereumClient } from '../lib/EthereumClient.ts';

const TEST_ACCOUNT = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
  balance: '100ETH',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
} as const;
const PROOF_TEST_ACCOUNT = {
  address: '0x9f56ABD52Bf2ceC2A66913629d769Ad89b5ff403' as Address,
  balance: '100ETH',
  privateKey: '0x59c6995e998f97a5a0044966f094538e0d7d4f1f43ccf50c41f1af1ecfdaf0c5' as Hex,
} as const;

const getMainchainClientMock = vi.hoisted(() => vi.fn());
const invokeWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: getMainchainClientMock,
}));

vi.mock('../lib/tauriApi.ts', () => ({
  invokeWithTimeout: invokeWithTimeoutMock,
}));

vi.mock('../lib/Env.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/Env.ts')>('../lib/Env.ts');
  return {
    ...actual,
    SERVER_ENV_VARS: {
      ...actual.SERVER_ENV_VARS,
      ETHEREUM_FINALITY_MILLIS: '16000',
    },
  };
});

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));
const RUNTIME_TO_ERC20_SCALE = 1_000_000_000_000n;

describe
  .skipIf(skipE2E || !TestEthereum.isInstalled())
  .sequential('EthereumClient integration', { timeout: 240e3 }, () => {
    let ethereum: TestEthereum;
    let publicClient: ReturnType<typeof createPublicClient>;
    let gatewayAddress: Address;
    let argonTokenAddress: Address;
    let argonotTokenAddress: Address;
    let destinationAddress: string;
    let destinationHex: Hex;

    beforeAll(async () => {
      ethereum = new TestEthereum();
      const endpoints = await ethereum.launch({
        preset: 'minimal',
        secondsPerSlot: 1,
        waitForFinalization: false,
        prefundedAccounts: {
          [TEST_ACCOUNT.address]: {
            balance: TEST_ACCOUNT.balance,
          },
          [PROOF_TEST_ACCOUNT.address]: {
            balance: PROOF_TEST_ACCOUNT.balance,
          },
        },
      });
      const fixture = await ethereum.deployMintingGatewayFixture({
        deployerPrivateKey: TEST_ACCOUNT.privateKey,
        seedArgonRecipient: TEST_ACCOUNT.address,
        seedArgonAmountBaseUnits: 1_000_000_000n,
      });
      const chain = defineChain({
        id: Number.parseInt(endpoints.chainId, 16),
        name: 'argon-test-ethereum',
        nativeCurrency: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
        rpcUrls: {
          default: {
            http: [endpoints.executionRpcUrl],
          },
        },
      });

      publicClient = createPublicClient({
        chain,
        transport: http(endpoints.executionRpcUrl),
      });
      gatewayAddress = fixture.gatewayAddress;
      argonTokenAddress = fixture.argonTokenAddress;
      argonotTokenAddress = fixture.argonotTokenAddress;
      const deployerWalletClient = createWalletClient({
        account: privateKeyToAccount(TEST_ACCOUNT.privateKey),
        chain,
        transport: http(endpoints.executionRpcUrl),
      });
      const proofAccountFundingHash = await deployerWalletClient.sendTransaction({
        to: PROOF_TEST_ACCOUNT.address,
        value: 1_000_000_000_000_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: proofAccountFundingHash });
      const proofMintHash = await deployerWalletClient.sendTransaction({
        to: gatewayAddress,
        data: encodeFunctionData({
          abi: mintingGatewayArtifact.abi,
          functionName: 'adminMintBatch',
          args: [argonTokenAddress, [PROOF_TEST_ACCOUNT.address], [1_000_000_000n]],
        }),
      });
      await publicClient.waitForTransactionReceipt({ hash: proofMintHash });

      const destinationAccount = new Keyring({ type: 'sr25519' }).createFromUri('//Bob');
      destinationAddress = destinationAccount.address;
      destinationHex = toHex(destinationAccount.publicKey, { size: 32 });

      getMainchainClientMock.mockResolvedValue(
        createMainchainClientMock({ destinationHex, gatewayAddress, argonTokenAddress, argonotTokenAddress }),
      );
    }, 240e3);

    beforeEach(() => {
      vi.clearAllMocks();
      invokeWithTimeoutMock.mockImplementation(
        async (_command: string, args: { request: { unsignedTransaction: Hex } }) => {
          const signature = await sign({
            hash: keccak256(args.request.unsignedTransaction),
            privateKey: TEST_ACCOUNT.privateKey,
            to: 'object',
          });

          return {
            yParity: signature.yParity,
            r: signature.r,
            s: signature.s,
          };
        },
      );
      getMainchainClientMock.mockResolvedValue(
        createMainchainClientMock({ destinationHex, gatewayAddress, argonTokenAddress, argonotTokenAddress }),
      );
    });

    afterAll(async () => {
      await teardown();
    });

    it('submits real approve and burn transactions and confirms the burn receipt details', async () => {
      const client = new EthereumClient({ ethereumAddress: TEST_ACCOUNT.address } as any, ethereum.executionRpcUrl!);
      const amountBaseUnits = 250n * RUNTIME_TO_ERC20_SCALE;

      await client.approveTransfer({
        moveToken: MoveToken.ARGN,
        amountBaseUnits,
      });

      const allowance = await publicClient.readContract({
        address: argonTokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [TEST_ACCOUNT.address, gatewayAddress],
      });
      expect(allowance).toBe(amountBaseUnits);

      const submitted = await client.submitBurnTransfer({
        moveToken: MoveToken.ARGN,
        amountBaseUnits,
        destinationAddress,
      });
      expect(submitted).toMatchObject({
        moveToken: MoveToken.ARGN,
        amountBaseUnits,
        destinationAddress,
        executionRpcUrl: ethereum.executionRpcUrl,
      });

      const confirmed = await client.confirmBurnTransfer(submitted);
      const burnReceipt = await publicClient.waitForTransactionReceipt({
        hash: submitted.burnTxHash,
      });
      const burnForTransferTopic = encodeEventTopics({
        abi: mintingGatewayArtifact.abi,
        eventName: 'BurnForTransfer',
      })[0];
      const expectedLogIndex = burnReceipt.logs.findIndex(
        log =>
          log.address.toLowerCase() === gatewayAddress.toLowerCase() &&
          log.topics[0]?.toLowerCase() === burnForTransferTopic?.toLowerCase(),
      );

      expect(burnReceipt.status).toBe('success');
      expect(confirmed.burnTxHash).toBe(submitted.burnTxHash);
      expect(confirmed.burnBlockNumber).toBe(Number(burnReceipt.blockNumber));
      expect(confirmed.burnBlockHash).toBe(burnReceipt.blockHash);
      expect(confirmed.burnLogIndex).toBe(expectedLogIndex);
      expect(expectedLogIndex).toBeGreaterThanOrEqual(0);
    });

    it('approves the correct token contract when moving ARGNOT', async () => {
      const client = new EthereumClient({ ethereumAddress: TEST_ACCOUNT.address } as any, ethereum.executionRpcUrl!);

      await client.approveTransfer({
        moveToken: MoveToken.ARGNOT,
        amountBaseUnits: 123n,
      });

      const allowance = await publicClient.readContract({
        address: argonotTokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [TEST_ACCOUNT.address, gatewayAddress],
      });
      expect(allowance).toBe(123n);
    });

    it('builds a real burn proof and proves it on Argon with the shared beacon sync service', async () => {
      const network = await startArgonTestNetwork('EthereumClient.proveTransfer', {
        registerTeardown: false,
        chainStartTimeoutMs: 120_000,
        chainStartPollMs: 250,
      });
      const mainchainClient = await getClient(network.archiveUrl);
      const relayKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
      const syncKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Charlie');
      const recipient = new Keyring({ type: 'sr25519' }).createFromUri('//Bob');
      const ethereumAccount = privateKeyToAccount(PROOF_TEST_ACCOUNT.privateKey);
      const walletClient = createWalletClient({
        account: ethereumAccount,
        chain: publicClient.chain!,
        transport: http(ethereum.executionRpcUrl),
      });
      const transferAmountRuntimeBaseUnits = 1_000_000n;
      const transferAmountBaseUnits = transferAmountRuntimeBaseUnits * RUNTIME_TO_ERC20_SCALE;
      let ethereumBeaconSyncService: EthereumBeaconSyncService | undefined;

      try {
        getMainchainClientMock.mockResolvedValue(mainchainClient);

        const setConfigResult = await new TxSubmitter(
          mainchainClient,
          mainchainClient.tx.sudo.sudo(
            mainchainClient.tx.crosschainTransfer.setChainConfig({
              Ethereum: {
                gateway: gatewayAddress,
                argonToken: argonTokenAddress,
                argonotToken: argonotTokenAddress,
                previousGateway: null,
                previousReleaseExpiration: null,
              },
            }),
          ),
          relayKeypair,
        ).submit();
        await setConfigResult.waitForInFirstBlock;
        const setConfigSudoEvent = setConfigResult.events.find(event => mainchainClient.events.sudo.Sudid.is(event));
        if (!setConfigSudoEvent || !mainchainClient.events.sudo.Sudid.is(setConfigSudoEvent)) {
          throw new Error('setChainConfig did not emit sudo.Sudid');
        }
        if (setConfigSudoEvent.data.sudoResult.isErr) {
          throw new Error(
            `setChainConfig failed: ${dispatchErrorToString(mainchainClient, setConfigSudoEvent.data.sudoResult.asErr as any)}`,
          );
        }

        const burnAccount = mainchainClient.consts.crosschainTransfer.ethereumBurnAccount.toString();
        const fundBurnAccountResult = await new TxSubmitter(
          mainchainClient,
          mainchainClient.tx.balances.transferAllowDeath(
            burnAccount,
            transferAmountRuntimeBaseUnits + mainchainClient.consts.balances.existentialDeposit.toBigInt(),
          ),
          relayKeypair,
        ).submit();
        await fundBurnAccountResult.waitForInFirstBlock;
        if (fundBurnAccountResult.extrinsicError) {
          throw fundBurnAccountResult.extrinsicError;
        }

        invokeWithTimeoutMock.mockImplementation(
          async (_command: string, args: { request: { unsignedTransaction: Hex } }) => {
            const signature = await sign({
              hash: keccak256(args.request.unsignedTransaction),
              privateKey: PROOF_TEST_ACCOUNT.privateKey,
              to: 'object',
            });

            return {
              yParity: signature.yParity,
              r: signature.r,
              s: signature.s,
            };
          },
        );

        const client = new EthereumClient(
          { ethereumAddress: PROOF_TEST_ACCOUNT.address } as any,
          ethereum.executionRpcUrl!,
        );
        const recipientBefore = await mainchainClient.query.system.account(recipient.address);

        await client.approveTransfer({
          moveToken: MoveToken.ARGN,
          amountBaseUnits: transferAmountBaseUnits,
        });

        const submitted = await client.submitBurnTransfer({
          moveToken: MoveToken.ARGN,
          amountBaseUnits: transferAmountBaseUnits,
          destinationAddress: recipient.address,
        });
        const confirmed = await client.confirmBurnTransfer(submitted);

        const laterTxHash = await walletClient.sendTransaction({
          account: ethereumAccount,
          chain: publicClient.chain!,
          to: ethereumAccount.address,
          value: 0n,
        });
        const laterReceipt = await publicClient.waitForTransactionReceipt({ hash: laterTxHash });

        await waitForFinalizedBeaconExecutionAtOrAbove(ethereum.beaconApiUrl!, laterReceipt.blockNumber);

        await EthereumBeaconSyncService.ensureBootstrapped(mainchainClient, ethereum.beaconApiUrl!, relayKeypair, {
          minimumExecutionBlockNumber: laterReceipt.blockNumber,
        });
        ethereumBeaconSyncService = new EthereumBeaconSyncService(mainchainClient, {
          beaconApiUrl: ethereum.beaconApiUrl!,
          pollMs: 1_000,
          syncKeypair,
        });
        const anchorSyncDeadline = Date.now() + 120_000;
        let anchorSyncAttempts = 0;

        while (true) {
          anchorSyncAttempts += 1;
          await ethereumBeaconSyncService.runOnce();

          try {
            await waitForRetainedExecutionAnchor(mainchainClient, laterReceipt.blockNumber, {
              pollMs: 250,
              timeoutMs: 1_000,
            });
            break;
          } catch (error) {
            if (Date.now() >= anchorSyncDeadline) {
              throw error;
            }
          }
        }

        const eventProof = await client.buildBurnProof(confirmed);
        const proveTransferResult = await new TxSubmitter(
          mainchainClient,
          mainchainClient.tx.crosschainTransfer.proveTransfer({
            Ethereum: {
              sourceChain: 'Ethereum',
              eventLog: eventProof.eventLog,
              proof: eventProof.proof,
            },
          }),
          relayKeypair,
        ).submit();
        await proveTransferResult.waitForInFirstBlock;
        if (proveTransferResult.extrinsicError) {
          throw proveTransferResult.extrinsicError;
        }

        const recipientAfter = await mainchainClient.query.system.account(recipient.address);
        expect(
          proveTransferResult.events.some(event =>
            mainchainClient.events.crosschainTransfer.BurnNoticeAccepted.is(event),
          ),
        ).toBe(true);
        expect(recipientAfter.data.free.toBigInt() - recipientBefore.data.free.toBigInt()).toBe(
          transferAmountRuntimeBaseUnits - (proveTransferResult.finalFee ?? 0n),
        );
        expect(ethereumBeaconSyncService.state().lastError).toBeUndefined();
      } finally {
        await ethereumBeaconSyncService?.shutdown().catch(() => undefined);
        await mainchainClient.disconnect().catch(() => undefined);
        await network.stop().catch(() => undefined);
      }
    }, 420_000);
  });

function createMainchainClientMock(args: {
  destinationHex: Hex;
  gatewayAddress: Address;
  argonTokenAddress: Address;
  argonotTokenAddress: Address;
}) {
  const { destinationHex, gatewayAddress, argonTokenAddress, argonotTokenAddress } = args;

  return {
    createType: vi.fn(() => ({
      toHex: () => destinationHex,
    })),
    query: {
      crosschainTransfer: {
        chainConfigBySourceChain: vi.fn(async () => ({
          isNone: false,
          unwrap: () => ({
            isEthereum: true,
            asEthereum: {
              gateway: { toHex: () => gatewayAddress },
              argonToken: { toHex: () => argonTokenAddress },
              argonotToken: { toHex: () => argonotTokenAddress },
            },
          }),
        })),
      },
    },
  };
}
