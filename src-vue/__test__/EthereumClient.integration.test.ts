import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeEthereumTransferToArgonStartedLog,
  Keyring,
  MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
} from '@argonprotocol/mainchain';
import { mintingGatewayArtifact, teardown, TestEthereum } from '@argonprotocol/testing';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type Signature,
} from 'viem';
import { privateKeyToAccount, sign, signTypedData } from 'viem/accounts';
import { MoveToken } from '@argonprotocol/apps-core';
import { EthereumClient } from '../lib/EthereumClient.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';

const TEST_ACCOUNT = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
  balance: '100ETH',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
} as const;

const getMainchainClientMock = vi.hoisted(() => vi.fn());

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: getMainchainClientMock,
}));

vi.mock('@argonprotocol/mainchain', async () => {
  const actual = await vi.importActual<typeof import('@argonprotocol/mainchain')>('@argonprotocol/mainchain');
  return {
    ...actual,
    findEthereumTransferToArgonStartedLogIndexes(
      receipt: { logs: Array<{ address: Address; topics: readonly Hex[] }> },
      gatewayAddress: Address,
    ): number[] {
      return receipt.logs.flatMap((log, index) => {
        if (log.address.toLowerCase() !== gatewayAddress.toLowerCase()) {
          return [];
        }

        try {
          const decoded = decodeEventLog({
            abi: mintingGatewayArtifact.abi,
            eventName: 'TransferToArgonStarted',
            data: (log as any).data,
            topics: log.topics as [Hex, ...Hex[]],
          });
          return decoded.eventName === 'TransferToArgonStarted' ? [index] : [];
        } catch {
          return [];
        }
      });
    },
  };
});

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

describe
  .skipIf(skipE2E || !TestEthereum.isInstalled())
  .sequential('EthereumClient integration', { timeout: 240e3 }, () => {
    let ethereum: TestEthereum;
    let publicClient: ReturnType<typeof createPublicClient>;
    let chainId: number;
    let gatewayAddress: Address;
    let argonTokenAddress: Address;
    let argonotTokenAddress: Address;
    let destinationAddress: string;
    let destinationHex: Hex;
    let walletKeys: Pick<WalletKeys, 'ethereumAddress' | 'signEthereumPermit' | 'signEthereumTransaction'>;

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
        },
      });
      const fixture = await ethereum.deployMintingGatewayFixture({
        deployerPrivateKey: TEST_ACCOUNT.privateKey,
      });

      chainId = Number.parseInt(endpoints.chainId, 16);
      const chain = defineChain({
        id: chainId,
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
      const ethereumAccount = privateKeyToAccount(TEST_ACCOUNT.privateKey);
      const walletClient = createWalletClient({
        account: ethereumAccount,
        chain,
        transport: http(endpoints.executionRpcUrl),
      });
      gatewayAddress = fixture.gatewayAddress;
      argonTokenAddress = fixture.argonTokenAddress;
      argonotTokenAddress = fixture.argonotTokenAddress;

      const seedAmountBaseUnits = 1_000n * MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
      const migrateHash = await walletClient.sendTransaction({
        account: ethereumAccount,
        to: gatewayAddress,
        data: encodeFunctionData({
          abi: mintingGatewayArtifact.abi,
          functionName: 'migrate',
          args: [
            {
              recipients: [TEST_ACCOUNT.address],
              amounts: [seedAmountBaseUnits],
            },
            {
              recipients: [TEST_ACCOUNT.address],
              amounts: [seedAmountBaseUnits],
            },
          ],
        }),
      });
      const migrateReceipt = await publicClient.waitForTransactionReceipt({ hash: migrateHash });
      if (migrateReceipt.status !== 'success') {
        throw new Error('MintingGateway migrate failed in EthereumClient integration test setup.');
      }

      const destinationAccount = new Keyring({ type: 'sr25519' }).createFromUri('//Bob');
      destinationAddress = destinationAccount.address;
      destinationHex = toHex(destinationAccount.publicKey, { size: 32 });

      getMainchainClientMock.mockResolvedValue(
        createMainchainClientMock({ destinationHex, gatewayAddress, argonTokenAddress, argonotTokenAddress }),
      );
    }, 240e3);

    beforeEach(() => {
      vi.clearAllMocks();
      walletKeys = {
        ethereumAddress: TEST_ACCOUNT.address,
        async signEthereumTransaction(unsignedTransaction: Hex) {
          const signature = await sign({
            hash: keccak256(unsignedTransaction),
            privateKey: TEST_ACCOUNT.privateKey,
            to: 'object',
          });

          return {
            yParity: signature.yParity!,
            r: signature.r,
            s: signature.s,
          } satisfies Signature;
        },
        async signEthereumPermit({ tokenAddress, tokenName, value, nonce, deadline }) {
          return await signPermit({
            tokenAddress,
            tokenName,
            value,
            nonce,
            deadline,
            chainId,
            spender: gatewayAddress,
          });
        },
      };
      getMainchainClientMock.mockResolvedValue(
        createMainchainClientMock({ destinationHex, gatewayAddress, argonTokenAddress, argonotTokenAddress }),
      );
    });

    afterAll(async () => {
      await teardown();
    });

    it('submits startTransferToArgon for ARGN and confirms the emitted gateway nonce details', async () => {
      const client = new EthereumClient(walletKeys, ethereum.executionRpcUrl!);
      const amountBaseUnits = 250n * MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;

      const submitted = await client.startTransferToArgon({
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

      const confirmed = await client.confirmTransferToArgon(submitted);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: submitted.sourceTxHash,
      });

      expect(receipt.status).toBe('success');
      expect(confirmed.sourceTxHash).toBe(submitted.sourceTxHash);
      expect(confirmed.sourceBlockNumber).toBe(Number(receipt.blockNumber));
      expect(confirmed.sourceBlockHash).toBe(receipt.blockHash);
      expect(confirmed.sourceLogIndex).toBeGreaterThanOrEqual(0);
      expect(confirmed.gatewayActivityNonce).toBeGreaterThan(0n);
    });

    it('targets the ARGNOT contract when starting an ARGNOT transfer', async () => {
      const client = new EthereumClient(walletKeys, ethereum.executionRpcUrl!);
      const amountBaseUnits = 123n * MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;

      const submitted = await client.startTransferToArgon({
        moveToken: MoveToken.ARGNOT,
        amountBaseUnits,
        destinationAddress,
      });
      const confirmed = await client.confirmTransferToArgon(submitted);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: submitted.sourceTxHash,
      });
      const transferLog = receipt.logs[confirmed.sourceLogIndex!];
      const decoded = decodeEthereumTransferToArgonStartedLog({
        data: transferLog.data,
        topics: [...transferLog.topics],
      });

      expect(getAddress(decoded.token as Address)).toBe(getAddress(argonotTokenAddress));
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

async function signPermit(args: {
  tokenAddress: string;
  tokenName: string;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
  chainId: number;
  spender: Address;
}): Promise<{ v: number; r: Hex; s: Hex }> {
  const signature = await signTypedData({
    privateKey: TEST_ACCOUNT.privateKey,
    domain: {
      name: args.tokenName,
      version: '1',
      chainId: args.chainId,
      verifyingContract: getAddress(args.tokenAddress),
    },
    primaryType: 'Permit',
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: {
      owner: TEST_ACCOUNT.address,
      spender: args.spender,
      value: args.value,
      nonce: args.nonce,
      deadline: args.deadline,
    },
  });
  const r: Hex = `0x${signature.slice(2, 66)}`;
  const s: Hex = `0x${signature.slice(66, 130)}`;
  const v = Number.parseInt(signature.slice(130, 132), 16);

  return { v, r, s };
}
