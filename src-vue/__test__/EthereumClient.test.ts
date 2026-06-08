import { NetworkConfig } from '@argonprotocol/apps-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import {
  createEthereumPublicClient,
  getEthereumUserErrorMessage,
  submitEthereumTransaction,
} from '../lib/EthereumClient.ts';

const { tauriFetchMock } = vi.hoisted(() => {
  return {
    tauriFetchMock: vi.fn(),
  };
});

vi.mock('@tauri-apps/plugin-http', () => {
  return {
    fetch: tauriFetchMock,
  };
});

describe('EthereumClient', () => {
  beforeEach(() => {
    tauriFetchMock.mockReset();
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        executionRpcUrl: 'https://ethereum.test',
      },
    });
  });

  afterEach(() => {
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
    tauriFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2a' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const publicClient = createEthereumPublicClient();

    await expect(publicClient.getBalance({ address: '0x0000000000000000000000000000000000000001' })).resolves.toBe(42n);
    expect(String(tauriFetchMock.mock.calls[0][0])).toBe('https://ethereum.test/');
    const requestBody = JSON.parse(String(tauriFetchMock.mock.calls[0][1]?.body));
    expect(requestBody.method).toBe('eth_getBalance');
    expect(requestBody.params).toEqual(['0x0000000000000000000000000000000000000001', 'latest']);
  });
});
