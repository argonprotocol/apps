import { describe, expect, it } from 'vitest';
import { AccountEventsFilter, type RuntimeSystemEventRecord } from '@argonprotocol/apps-core';
import { createTestDb } from './helpers/db.ts';

describe('wallet transfer parsing', () => {
  it('records direct ARGN and ARGNOT transfers inside proxy and batch event sets', () => {
    const argon = [
      event('proxy', 'ProxyExecuted', []),
      event('balances', 'Transfer', ['5outside', '5default', 25n]),
      event('system', 'ExtrinsicSuccess', []),
    ];
    const argonot = [
      event('utility', 'ItemCompleted', []),
      event('ownership', 'Transfer', ['5default', '5mining', 9n]),
      event('system', 'ExtrinsicSuccess', []),
    ];

    const argonFilter = new AccountEventsFilter('5default', ['5default', '5mining']);
    argonFilter.process(argon);
    expect(argonFilter.transfers).toEqual([
      expect.objectContaining({
        from: '5outside',
        to: '5default',
        amount: 25n,
        currency: 'argon',
        isInbound: true,
        isInternal: false,
      }),
    ]);
    const argonotFilter = new AccountEventsFilter('5default', ['5default', '5mining']);
    argonotFilter.process(argonot);
    expect(argonotFilter.transfers).toEqual([
      expect.objectContaining({
        from: '5default',
        to: '5mining',
        amount: 9n,
        currency: 'argonot',
        isInbound: false,
        isInternal: true,
      }),
    ]);
  });

  it('does not mistake a balance movement from another operation for a user transfer', () => {
    const records = [
      event('vaults', 'VaultCollected', []),
      event('balances', 'Transfer', ['5vault', '5default', 25n]),
      event('system', 'ExtrinsicSuccess', []),
    ];

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process(records);
    expect(filter.transfers).toEqual([]);
  });

  it('combines identical transfers emitted by one batch', () => {
    const records = [
      event('utility', 'ItemCompleted', []),
      event('balances', 'Transfer', ['5default', '5outside', 25n]),
      event('balances', 'Transfer', ['5default', '5outside', 25n]),
      event('system', 'ExtrinsicSuccess', []),
    ];

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process(records);
    expect(filter.transfers).toEqual([
      expect.objectContaining({ from: '5default', to: '5outside', amount: 50n, isInbound: false }),
    ]);
  });

  it('keeps a transfer item when another batch item emits domain events', () => {
    const records = [
      event('vaults', 'VaultModified', []),
      event('utility', 'ItemCompleted', []),
      event('balances', 'Transfer', ['5default', '5outside', 25n]),
      event('utility', 'ItemCompleted', []),
      event('utility', 'BatchCompleted', []),
      event('system', 'ExtrinsicSuccess', []),
    ];

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process(records);
    expect(filter.transfers).toEqual([
      expect.objectContaining({ from: '5default', to: '5outside', amount: 25n, isInbound: false }),
    ]);
  });

  it('records faucet funding and current cross-chain settlement', () => {
    const records = [
      event('balances', 'BalanceSet', ['5default', 100n]),
      event('ownership', 'BalanceSet', ['5default', 7n]),
      event('crosschainTransfer', 'TransferToArgonSettled', [
        {},
        {
          to: '5default',
          from: '0xsender',
          amount: 40n,
          asset: { type: 'Argonot' },
        },
      ]),
    ];

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process(records);
    expect(filter.transfers).toEqual([
      expect.objectContaining({ transferType: 'faucet', currency: 'argon', amount: 100n }),
      expect.objectContaining({ transferType: 'faucet', currency: 'argonot', amount: 7n }),
      expect.objectContaining({
        transferType: 'ethereum',
        currency: 'argonot',
        amount: 40n,
      }),
    ]);
  });

  it('records current cross-chain sends from the lifecycle event', () => {
    const outbound = event('crosschainTransfer', 'TransferOutStarted', [
      { type: 'Ethereum' },
      '0xtransfer',
      '5default',
      { type: 'Argonot' },
      40n,
      0n,
    ]);

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process([outbound]);

    expect(filter.transfers).toEqual([
      expect.objectContaining({
        to: 'Ethereum',
        from: '5default',
        transferType: 'ethereum',
        currency: 'argonot',
        amount: 40n,
        isInbound: false,
        tokenGatewayCommitmentHash: '0xtransfer',
      }),
    ]);
  });

  it('retains only the fee event group paid by this account', () => {
    const ownFee = [event('transactionPayment', 'TransactionFeePaid', ['5default', 2n, 0n])];
    const otherFee = [event('transactionPayment', 'TransactionFeePaid', ['5other', 2n, 0n], 3)];
    const filter = new AccountEventsFilter('5default', ['5default']);

    filter.process([...ownFee, ...otherFee]);

    expect(filter.transfers).toEqual([]);
    expect(filter.eventsByExtrinsic).toHaveLength(1);
    expect(filter.eventsByExtrinsic[0][1]).toMatchObject({
      pallet: 'transactionPayment',
      method: 'TransactionFeePaid',
    });
  });

  it('records historical token-gateway receipts and sends', () => {
    const received = [event('ownership', 'Minted', []), event('tokenGateway', 'AssetReceived', ['5default', 60n, {}])];
    const sent = [
      event('ownership', 'Burned', ['5default', 30n]),
      event('tokenGateway', 'AssetTeleported', ['5default', '0xrecipient', 30n, {}, '0xcommitment']),
    ];

    const receivedFilter = new AccountEventsFilter('5default', ['5default']);
    receivedFilter.process(received);
    expect(receivedFilter.transfers).toEqual([
      expect.objectContaining({
        transferType: 'tokenGateway',
        currency: 'argonot',
        amount: 60n,
        isInbound: true,
      }),
    ]);
    const sentFilter = new AccountEventsFilter('5default', ['5default']);
    sentFilter.process(sent);
    expect(sentFilter.transfers).toEqual([
      expect.objectContaining({
        transferType: 'tokenGateway',
        currency: 'argonot',
        amount: 30n,
        isInbound: false,
        tokenGatewayCommitmentHash: '0xcommitment',
      }),
    ]);
  });

  it('updates recovered transfer classification without duplicating a missing counterparty', async () => {
    const db = await createTestDb();
    const transfer = {
      walletAddress: '5default',
      walletName: 'argon',
      amount: 25n,
      currency: 'argon' as const,
      transferType: 'ethereum' as const,
      isInternal: true,
      extrinsicIndex: 2,
      microgonsForArgonot: 1n,
      microgonsForUsd: 1n,
      blockNumber: 10,
      blockHash: '0xblock',
    };

    try {
      await db.walletTransfersTable.insert(transfer);
      await db.walletTransfersTable.insert({ ...transfer, isInternal: false });

      const records = await db.walletTransfersTable.fetchAll();
      expect(records).toHaveLength(1);
      expect(records[0].isInternal).toBe(false);
    } finally {
      await db.close();
    }
  });
});

function event(section: string, method: string, values: unknown[], extrinsicIndex = 2): RuntimeSystemEventRecord {
  const fieldNames: Record<string, string[]> = {
    'balances.BalanceSet': ['who', 'free'],
    'balances.Transfer': ['from', 'to', 'amount'],
    'ownership.BalanceSet': ['who', 'free'],
    'ownership.Transfer': ['from', 'to', 'amount'],
    'crosschainTransfer.TransferOutStarted': [
      'destinationChain',
      'transferId',
      'accountId',
      'asset',
      'amount',
      'mintingAuthorityTip',
    ],
    'crosschainTransfer.TransferToArgonSettled': ['transferId', 'transfer'],
    'transactionPayment.TransactionFeePaid': ['who', 'actualFee', 'tip'],
    'tokenGateway.AssetReceived': ['beneficiary', 'amount', 'source'],
    'tokenGateway.AssetTeleported': ['from', 'to', 'amount', 'dest', 'commitment'],
    'ownership.Burned': ['who', 'amount'],
  };
  const names = fieldNames[`${section}.${method}`] ?? [];
  return {
    event: {
      section,
      method,
      data: Object.fromEntries(names.map((name, index) => [name, values[index]])),
    } as RuntimeSystemEventRecord['event'],
    phase: { type: 'ApplyExtrinsic', value: extrinsicIndex },
    topics: [],
  };
}
