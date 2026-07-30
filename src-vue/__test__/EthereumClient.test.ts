import { NetworkConfig, setFetchImplementation, type FetchImplementation } from '@argonprotocol/apps-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import {
  createEthereumPublicClient,
  EthereumClient,
  EthereumTransactionRevertedError,
  getEthereumUserErrorMessage,
  submitEthereumTransaction,
} from '../lib/EthereumClient.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

const runtimeFetchMock = vi.fn();

describe('EthereumClient', () => {
  beforeEach(() => {
    runtimeFetchMock.mockReset();
    setFetchImplementation();
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        executionRpcUrls: ['https://ethereum.test'],
      },
    });
  });

  afterEach(() => {
    setFetchImplementation();
    NetworkConfig.clearRuntimeOverride('dev-docker');
  });

  it('prefers the short viem error message over raw RPC request details', () => {
    const error = Object.assign(
      new Error(
        [
          'Missing or invalid parameters.',
          'Double check you have provided the correct parameters.',
          '',
          'URL: https://ethereum-sepolia-rpc.publicnode.com',
          'Request body: {"method":"eth_sendRawTransaction"}',
        ].join('\n'),
      ),
      {
        shortMessage: 'Missing or invalid parameters. Double check you have provided the correct parameters.',
      },
    );

    expect(getEthereumUserErrorMessage(error, 'fallback')).toBe(
      'Missing or invalid parameters. Double check you have provided the correct parameters.',
    );
  });

  it('falls back to the first paragraph when no short message exists', () => {
    const error = new Error(
      ['Ethereum RPC rejected the transaction.', '', 'URL: https://ethereum-sepolia-rpc.publicnode.com'].join('\n'),
    );

    expect(getEthereumUserErrorMessage(error, 'fallback')).toBe('Ethereum RPC rejected the transaction.');
  });

  it('recovers the derived hash when sendRawTransaction errored after propagation', async () => {
    const serializedTransaction = '0x1234';
    const publicClient = {
      sendRawTransaction: async () => {
        throw new Error('Missing or invalid parameters.\n\nRequest body: {"method":"eth_sendRawTransaction"}');
      },
      getTransaction: async ({ hash }: { hash: string }) => ({ hash }),
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: keccak256(serializedTransaction) });
      },
    };

    await expect(
      submitEthereumTransaction({
        publicClient,
        serializedTransaction,
        fallbackErrorMessage: 'fallback',
      }),
    ).resolves.toBe(keccak256(serializedTransaction));
  });

  it('surfaces a sanitized error when the transaction never becomes visible', async () => {
    const serializedTransaction = '0x1234';
    const publicClient = {
      sendRawTransaction: async () => {
        throw Object.assign(
          new Error('Missing or invalid parameters.\n\nRequest body: {"method":"eth_sendRawTransaction"}'),
          {
            shortMessage: 'Missing or invalid parameters. Double check you have provided the correct parameters.',
          },
        );
      },
      getTransaction: async () => {
        throw new TransactionNotFoundError({ hash: keccak256(serializedTransaction) });
      },
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: keccak256(serializedTransaction) });
      },
    };

    await expect(
      submitEthereumTransaction({
        publicClient,
        serializedTransaction,
        fallbackErrorMessage: 'fallback',
      }),
    ).rejects.toThrow('Missing or invalid parameters. Double check you have provided the correct parameters.');
  });

  it('routes Ethereum balance requests through plugin-http', async () => {
    runtimeFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2a' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    setFetchImplementation(runtimeFetchMock as unknown as FetchImplementation);

    const publicClient = createEthereumPublicClient();

    await expect(publicClient.getBalance({ address: '0x0000000000000000000000000000000000000001' })).resolves.toBe(42n);
    expect(String(runtimeFetchMock.mock.calls[0][0])).toBe('https://ethereum.test/');
    const requestBody = JSON.parse(String(runtimeFetchMock.mock.calls[0][1]?.body));
    expect(requestBody.method).toBe('eth_getBalance');
    expect(requestBody.params).toEqual(['0x0000000000000000000000000000000000000001', 'latest']);
  });

  it('uses the configured RPC before the built-in fallbacks', async () => {
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        executionRpcUrls: ['https://ethereum-fallback.test'],
      },
    });
    runtimeFetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 })).mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2a' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    setFetchImplementation(runtimeFetchMock as unknown as FetchImplementation);

    const publicClient = createEthereumPublicClient(undefined, 'https://ethereum-configured.test');

    await expect(publicClient.getBalance({ address: '0x0000000000000000000000000000000000000001' })).resolves.toBe(42n);
    expect(runtimeFetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'https://ethereum-configured.test/',
      'https://ethereum-fallback.test/',
    ]);
  });

  it('rejects a reverted receipt instead of counting its confirmations', async () => {
    const txHash = `0x${'11'.repeat(32)}` as const;
    const ethereumClient = new EthereumClient(createMockWalletKeys(), 'https://ethereum.test');
    const getBlockNumber = vi.fn(async () => 100n);

    Object.assign(ethereumClient, {
      createExecutionClient: async () => ({
        publicClient: {
          getTransactionReceipt: vi.fn(async () => ({
            blockNumber: 90n,
            blockHash: `0x${'22'.repeat(32)}`,
            transactionHash: txHash,
            status: 'reverted',
          })),
          getBlockNumber,
        },
      }),
    });

    await expect(ethereumClient.getTransactionProgress({ txHash })).rejects.toThrow(EthereumTransactionRevertedError);
    expect(getBlockNumber).not.toHaveBeenCalled();
  });
});
