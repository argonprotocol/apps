import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, erc20Abi, getAddress } from 'viem';

const state = vi.hoisted(() => {
  const gatewayAddress = `0x${'11'.repeat(20)}`;
  const argonTokenAddress = `0x${'22'.repeat(20)}`;
  const argonotTokenAddress = `0x${'33'.repeat(20)}`;
  const sendDevEthereumAdminTransaction = vi.fn();

  return {
    gatewayAddress,
    argonTokenAddress,
    argonotTokenAddress,
    sendDevEthereumAdminTransaction,
    publicClient: {
      getChainId: vi.fn(async () => 3_151_908),
      readContract: vi.fn(async (_request: { address: string }) => 10_000n * 10n ** 18n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    },
    argonClient: {
      query: {
        crosschainTransfer: {
          chainConfigBySourceChain: vi.fn(async () => ({
            isNone: false,
            unwrap: () => ({
              isEvm: true,
              asEvm: {
                gateway: { toHex: () => gatewayAddress },
                argonToken: { toHex: () => argonTokenAddress },
                argonotToken: { toHex: () => argonotTokenAddress },
              },
            }),
          })),
        },
      },
      disconnect: vi.fn(async () => undefined),
    },
  };
});

vi.mock('@argonprotocol/mainchain', async importOriginal => ({
  ...(await importOriginal<typeof import('@argonprotocol/mainchain')>()),
  getClient: vi.fn(async () => state.argonClient),
}));

vi.mock('viem', async importOriginal => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: vi.fn(() => state.publicClient),
}));

vi.mock('../devEthereum.ts', () => ({
  DEV_ETHEREUM_ADMIN_ACCOUNT: {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    balance: '100ETH',
  },
  resolveDevEthereumRpcUrl: vi.fn(async () => 'http://127.0.0.1:32003'),
  sendDevEthereumAdminTransaction: state.sendDevEthereumAdminTransaction,
}));

import { fundDevEthereumTokens } from '../../dev/funding/tokens.ts';
import { fundDevAccount } from '../../dev/funding.ts';

describe('dev Ethereum token funding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.publicClient.readContract.mockResolvedValue(10_000n * 10n ** 18n);
    state.sendDevEthereumAdminTransaction
      .mockResolvedValueOnce({
        hash: `0x${'44'.repeat(32)}`,
        sender: getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'),
      })
      .mockResolvedValueOnce({
        hash: `0x${'55'.repeat(32)}`,
        sender: getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'),
      });
  });

  it('transfers requested ARGN and ARGNOT from the root reserve', async () => {
    const recipient = getAddress(`0x${'66'.repeat(20)}`);
    await fundDevAccount({
      options: { network: 'dev-docker', ethArgons: '25', ethArgonots: '5' },
      walletKeys: { defaultArgonAddress: '//Alice', coreEthereumAddress: recipient },
      archiveUrl: 'ws://127.0.0.1:9944',
      executionRpcUrl: 'http://127.0.0.1:32003',
      progress: () => undefined,
    });

    expect(state.sendDevEthereumAdminTransaction).toHaveBeenCalledTimes(2);
    const [argonTransfer, argonotTransfer] = state.sendDevEthereumAdminTransaction.mock.calls;
    expect(argonTransfer[0].to).toBe(getAddress(state.argonTokenAddress));
    expect(argonotTransfer[0].to).toBe(getAddress(state.argonotTokenAddress));
    expect(
      decodeFunctionData({
        abi: erc20Abi,
        data: argonTransfer[0].data,
      }),
    ).toEqual({
      functionName: 'transfer',
      args: [recipient, 25_000_000n * 10n ** 12n],
    });
    expect(
      decodeFunctionData({
        abi: erc20Abi,
        data: argonotTransfer[0].data,
      }),
    ).toEqual({
      functionName: 'transfer',
      args: [recipient, 5_000_000n * 10n ** 12n],
    });
  });

  it('waits for dev startup to publish the Ethereum chain config', async () => {
    state.argonClient.query.crosschainTransfer.chainConfigBySourceChain.mockResolvedValueOnce({
      isNone: true,
      unwrap: () => {
        throw new Error('Cannot unwrap None');
      },
    });

    await fundDevEthereumTokens({
      to: getAddress(`0x${'66'.repeat(20)}`),
      argnRuntimeAmount: 25_000_000n,
    });

    expect(state.argonClient.query.crosschainTransfer.chainConfigBySourceChain).toHaveBeenCalledTimes(2);
    expect(state.sendDevEthereumAdminTransaction).toHaveBeenCalledTimes(1);
  });

  it('checks both token reserves before funding either asset', async () => {
    const recipient = getAddress(`0x${'66'.repeat(20)}`);
    state.publicClient.readContract.mockImplementation(async ({ address }) => {
      if (address === getAddress(state.argonotTokenAddress)) return 0n;
      return 10_000n * 10n ** 18n;
    });

    await expect(
      fundDevAccount({
        options: { network: 'dev-docker', ethArgons: '25', ethArgonots: '5' },
        walletKeys: { defaultArgonAddress: '//Alice', coreEthereumAddress: recipient },
        archiveUrl: 'ws://127.0.0.1:9944',
        executionRpcUrl: 'http://127.0.0.1:32003',
        progress: () => undefined,
      }),
    ).rejects.toThrow('ARGNOT reserve is insufficient');
    expect(state.sendDevEthereumAdminTransaction).not.toHaveBeenCalled();
  });
});
