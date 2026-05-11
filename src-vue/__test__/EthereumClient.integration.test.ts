import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keyring, mintingGatewayArtifact } from '@argonprotocol/mainchain';
import { teardown, TestEthereum } from '@argonprotocol/testing';
import {
  createPublicClient,
  defineChain,
  encodeEventTopics,
  erc20Abi,
  http,
  keccak256,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { sign } from 'viem/accounts';
import { MoveToken } from '@argonprotocol/apps-core';
import { EthereumClient } from '../lib/EthereumClient.ts';

const TEST_ACCOUNT = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
  balance: '100ETH',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
} as const;

const getMainchainClientMock = vi.hoisted(() => vi.fn());
const invokeWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: getMainchainClientMock,
}));

vi.mock('../lib/tauriApi.ts', () => ({
  invokeWithTimeout: invokeWithTimeoutMock,
}));

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
        secondsPerSlot: 1,
        waitForFinalization: false,
        prefundedAccounts: {
          [TEST_ACCOUNT.address]: {
            balance: TEST_ACCOUNT.balance,
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
