import { getOfflineRegistry, type SpRuntimeDispatchError } from '@argonprotocol/mainchain';
import type { HistoricalEvent } from '@argonprotocol/runtime-client';
import { expect, it } from 'vitest';
import { runtimeDispatchErrorToExtrinsicError } from '../src/RuntimeDispatchError.ts';
import { TxResult } from '../src/TxResult.ts';
import type { ArgonClient } from '../src/MainchainClients.ts';

const extrinsicSuccess: HistoricalEvent = {
  section: 'system',
  method: 'ExtrinsicSuccess',
  data: {
    dispatchInfo: {
      weight: { refTime: 1n, proofSize: 0n },
      class: { type: 'Normal' },
      paysFee: { type: 'Yes' },
    },
  },
};

it.each([
  {
    name: 'AccountWouldGoBelowMinimumBalance',
    message: 'Your account needs to keep a minimum balance. Reduce the amount and try again.',
  },
  { name: 'BitcoinReleaseChangeBelowMinimum' },
  { name: 'InsufficientVaultFunds', docsPallet: 'Vaults' },
])('shows a readable $name error and preserves metadata for codec and historical errors', args => {
  const { name, message, docsPallet } = args;
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
  let runtimeDescription = variant.docs.join(' ');
  if (docsPallet) {
    const sourcePallet = registry.metadata.pallets.find(pallet => pallet.name.eq(docsPallet))!;
    const sourceVariant = registry.lookup
      .getSiType(sourcePallet.errors.unwrap().type)
      .def.asVariant.variants.find(error => error.name.eq(name))!;
    runtimeDescription = sourceVariant.docs.join(' ');
  }
  expect(runtimeDescription).not.toBe('');

  for (const error of [codec, historical]) {
    const decoded = runtimeDispatchErrorToExtrinsicError({ registry }, error, 2, 35_000n);
    expect(decoded.message).toBe(message ?? runtimeDescription);
    expect(decoded.details).toBe(runtimeDescription);
    expect(decoded).toMatchObject({
      errorCode: `bitcoinLocks.${name}`,
      batchInterruptedIndex: 2,
      txFee: 35_000n,
    });
  }
});

it.each(
  [
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
  ].flatMap(args => (['BatchInterrupted', 'Sudid', 'SudoAsDone'] as const).map(method => ({ ...args, method }))),
)(
  'rejects inclusion and finalization for $method with a readable $errorCode error and preserves diagnostics',
  async ({ error, codecError, errorCode, message, method }) => {
    const registry = getOfflineRegistry();
    const codec = registry.createType<SpRuntimeDispatchError>('SpRuntimeDispatchError', codecError);
    const decoded = runtimeDispatchErrorToExtrinsicError({ registry }, codec);
    const client = { registry } as unknown as ArgonClient;
    const txResult = new TxResult({
      accountAddress: 'sender',
      signedHash: '0x01',
      nonce: 0,
      method: {},
      submittedTime: new Date('2026-09-01T12:00:00Z'),
      submittedAtBlockNumber: 10,
    });
    const failureEvents = {
      BatchInterrupted: { section: 'utility', method: 'BatchInterrupted', data: { index: 2, error } },
      Sudid: { section: 'sudo', method: 'Sudid', data: { sudoResult: { type: 'Err', value: error } } },
      SudoAsDone: { section: 'sudo', method: 'SudoAsDone', data: { sudoResult: { type: 'Err', value: error } } },
    } satisfies Record<typeof method, HistoricalEvent>;

    await txResult.setSeenInBlock(client, {
      blockHash: Uint8Array.of(1),
      blockNumber: 11,
      extrinsicIndex: 0,
      events: [
        failureEvents[method],
        {
          section: 'transactionPayment',
          method: 'TransactionFeePaid',
          data: { who: 'sender', actualFee: 35_000n, tip: 5_000n },
        },
        extrinsicSuccess,
      ],
    });
    await txResult.setFinalized(client);

    expect(decoded).toMatchObject({ errorCode, message });
    expect(txResult.extrinsicError).toMatchObject({
      errorCode,
      message,
      batchInterruptedIndex: method === 'BatchInterrupted' ? 2 : undefined,
      txFee: 35_000n,
    });
    await expect(txResult.waitForInFirstBlock).rejects.toThrow(message);
    await expect(txResult.waitForFinalizedBlock).rejects.toThrow(message);
  },
);

it.each(['Sudid', 'SudoAsDone'] as const)(
  'accepts inclusion and finalization for a successful sudo.%s',
  async method => {
    const client = { registry: getOfflineRegistry() } as unknown as ArgonClient;
    const txResult = new TxResult({
      accountAddress: 'sender',
      signedHash: '0x01',
      nonce: 0,
      method: {},
      submittedTime: new Date('2026-09-01T12:00:00Z'),
      submittedAtBlockNumber: 10,
    });
    const blockHash = Uint8Array.of(1);
    const successEvents = {
      Sudid: { section: 'sudo', method: 'Sudid', data: { sudoResult: { type: 'Ok', value: null } } },
      SudoAsDone: { section: 'sudo', method: 'SudoAsDone', data: { sudoResult: { type: 'Ok', value: null } } },
    } satisfies Record<typeof method, HistoricalEvent>;

    await txResult.setSeenInBlock(client, {
      blockHash,
      blockNumber: 11,
      extrinsicIndex: 0,
      events: [successEvents[method], extrinsicSuccess],
    });

    expect(txResult.extrinsicError).toBeUndefined();
    await expect(txResult.waitForInFirstBlock).resolves.toEqual(blockHash);
    await txResult.setFinalized(client);
    await expect(txResult.waitForFinalizedBlock).resolves.toEqual(blockHash);
  },
);
