import { getOfflineRegistry, type SpRuntimeDispatchError } from '@argonprotocol/mainchain';
import { expect, it } from 'vitest';
import { runtimeDispatchErrorToExtrinsicError } from '../src/RuntimeDispatchError.ts';
import { TxResult } from '../src/TxResult.ts';
import type { ArgonClient } from '../src/MainchainClients.ts';

it.each([
  {
    name: 'AccountWouldGoBelowMinimumBalance',
    message: 'Your account needs to keep a minimum balance. Reduce the amount and try again.',
  },
  { name: 'BitcoinReleaseChangeBelowMinimum' },
])('shows a readable $name error and preserves metadata for codec and historical errors', ({ name, message }) => {
  const registry = getOfflineRegistry();
  const pallet = registry.metadata.pallets.find(pallet => pallet.name.eq('BitcoinLocks'))!;
  const variant = registry.lookup
    .getSiType(pallet.errors.unwrap().type)
    .def.asVariant.variants.find(error => error.name.eq(name))!;
  const codec = registry.createType<SpRuntimeDispatchError>('SpRuntimeDispatchError', {
    Module: { index: pallet.index, error: Uint8Array.of(variant.index.toNumber(), 0, 0, 0) },
  });
  const historical = {
    type: 'Module' as const,
    value: { index: pallet.index.toNumber(), error: codec.asModule.error.toHex() },
  };

  for (const error of [codec, historical]) {
    const decoded = runtimeDispatchErrorToExtrinsicError({ registry }, error, 2, 35_000n);
    expect(decoded.message).toBe(message ?? variant.docs.join(' '));
    expect(decoded.details).toBe(variant.docs.join(' '));
    expect(decoded).toMatchObject({
      errorCode: `bitcoinLocks.${name}`,
      batchInterruptedIndex: 2,
      txFee: 35_000n,
    });
  }
});

it.each([
  {
    error: { type: 'Token' as const, value: { type: 'FundsUnavailable' as const } },
    codecError: { Token: 'FundsUnavailable' },
    errorCode: 'Token.FundsUnavailable',
    message:
      'Not enough available funds to cover the transaction and its fees. Reduce the amount or add funds, then try again.',
  },
  {
    error: { type: 'Arithmetic' as const, value: { type: 'Overflow' as const } },
    codecError: { Arithmetic: 'Overflow' },
    errorCode: 'Arithmetic.Overflow',
    message:
      'The transaction could not be completed. Please try again or contact support if the problem continues. (Error code: Arithmetic.Overflow)',
  },
])(
  'rejects inclusion and finalization with a readable $errorCode error and preserves diagnostics',
  async ({ error, codecError, errorCode, message }) => {
    const registry = getOfflineRegistry();
    const codec = registry.createType<SpRuntimeDispatchError>('SpRuntimeDispatchError', codecError);
    const decoded = runtimeDispatchErrorToExtrinsicError({ registry }, codec);
    const txResult = new TxResult({ registry } as unknown as ArgonClient, {
      accountAddress: 'sender',
      signedHash: '0x01',
      nonce: 0,
      method: {},
      submittedTime: new Date('2026-09-01T12:00:00Z'),
      submittedAtBlockNumber: 10,
    });
    await txResult.setSeenInBlock({
      blockHash: Uint8Array.of(1),
      blockNumber: 11,
      extrinsicIndex: 0,
      events: [
        {
          section: 'utility',
          method: 'BatchInterrupted',
          data: { index: 2, error },
        },
        {
          section: 'transactionPayment',
          method: 'TransactionFeePaid',
          data: { who: 'sender', actualFee: 35_000n, tip: 5_000n },
        },
      ],
    });
    await txResult.setFinalized();

    expect(decoded).toMatchObject({ errorCode, message });
    expect(txResult.extrinsicError).toMatchObject({
      errorCode,
      message,
      batchInterruptedIndex: 2,
      txFee: 35_000n,
    });
    await expect(txResult.waitForInFirstBlock).rejects.toThrow(message);
    await expect(txResult.waitForFinalizedBlock).rejects.toThrow(message);
  },
);
