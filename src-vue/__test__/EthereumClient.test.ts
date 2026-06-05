import { describe, expect, it } from 'vitest';
import { getEthereumUserErrorMessage, submitEthereumTransaction } from '../lib/EthereumClient.ts';
import { keccak256, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';

describe('EthereumClient', () => {
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
});
