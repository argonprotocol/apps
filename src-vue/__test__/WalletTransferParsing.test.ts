import { describe, expect, it, vi } from 'vitest';
import { AccountEventsFilter } from '@argonprotocol/apps-core';
import type { ApiDecoration, FrameSystemEventRecord, GenericEvent } from '@argonprotocol/mainchain';
import { bigintCodec, hexCodec, humanCodec, numberCodec } from '../../core/__test__/helpers/codecs.ts';
import { WalletForArgon } from '../lib/WalletForArgon.ts';
import { createTestDb } from './helpers/db.ts';

const api = {
  events: {
    balances: {
      BalanceSet: eventGuard('balances', 'BalanceSet'),
      Transfer: eventGuard('balances', 'Transfer'),
    },
    ownership: {
      BalanceSet: eventGuard('ownership', 'BalanceSet'),
      Transfer: eventGuard('ownership', 'Transfer'),
    },
    crosschainTransfer: {
      TransferOutStarted: eventGuard('crosschainTransfer', 'TransferOutStarted'),
      TransferToArgonSettled: eventGuard('crosschainTransfer', 'TransferToArgonSettled'),
    },
    transactionPayment: {
      TransactionFeePaid: eventGuard('transactionPayment', 'TransactionFeePaid'),
    },
  },
} as unknown as ApiDecoration<'promise'>;

describe('wallet transfer parsing', () => {
  it('records direct ARGN and ARGNOT transfers inside proxy and batch event sets', () => {
    const argon = [
      event('proxy', 'ProxyExecuted', []),
      event('balances', 'Transfer', [humanCodec('5outside'), humanCodec('5default'), bigintCodec(25n)]),
      event('system', 'ExtrinsicSuccess', []),
    ];
    const argonot = [
      event('utility', 'ItemCompleted', []),
      event('ownership', 'Transfer', [humanCodec('5default'), humanCodec('5mining'), bigintCodec(9n)]),
      event('system', 'ExtrinsicSuccess', []),
    ];

    const argonFilter = new AccountEventsFilter('5default', ['5default', '5mining']);
    argonFilter.process(api, argon);
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
    argonotFilter.process(api, argonot);
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
      event('balances', 'Transfer', [humanCodec('5vault'), humanCodec('5default'), bigintCodec(25n)]),
      event('system', 'ExtrinsicSuccess', []),
    ];

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process(api, records);
    expect(filter.transfers).toEqual([]);
  });

  it('combines identical transfers emitted by one batch', () => {
    const records = [
      event('utility', 'ItemCompleted', []),
      event('balances', 'Transfer', [humanCodec('5default'), humanCodec('5outside'), bigintCodec(25n)]),
      event('balances', 'Transfer', [humanCodec('5default'), humanCodec('5outside'), bigintCodec(25n)]),
      event('system', 'ExtrinsicSuccess', []),
    ];

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process(api, records);
    expect(filter.transfers).toEqual([
      expect.objectContaining({ from: '5default', to: '5outside', amount: 50n, isInbound: false }),
    ]);
  });

  it('keeps a transfer item when another batch item emits domain events', () => {
    const records = [
      event('vaults', 'VaultModified', []),
      event('utility', 'ItemCompleted', []),
      event('balances', 'Transfer', [humanCodec('5default'), humanCodec('5outside'), bigintCodec(25n)]),
      event('utility', 'ItemCompleted', []),
      event('utility', 'BatchCompleted', []),
      event('system', 'ExtrinsicSuccess', []),
    ];

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process(api, records);
    expect(filter.transfers).toEqual([
      expect.objectContaining({ from: '5default', to: '5outside', amount: 25n, isInbound: false }),
    ]);
  });

  it('records faucet funding and current cross-chain settlement', () => {
    const records = [
      event('balances', 'BalanceSet', [humanCodec('5default'), bigintCodec(100n)]),
      event('ownership', 'BalanceSet', [humanCodec('5default'), bigintCodec(7n)]),
      event('crosschainTransfer', 'TransferToArgonSettled', [
        {},
        {
          to: humanCodec('5default'),
          from: hexCodec('0xsender'),
          amount: bigintCodec(40n),
          asset: { isArgon: false },
        },
      ]),
    ];

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process(api, records);
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
      humanCodec('Ethereum'),
      hexCodec('0xtransfer'),
      humanCodec('5default'),
      { isArgon: false },
      bigintCodec(40n),
      bigintCodec(0n),
    ]);
    Object.assign(outbound.event.data, {
      destinationChain: humanCodec('Ethereum'),
      transferId: hexCodec('0xtransfer'),
      accountId: humanCodec('5default'),
      asset: { isArgon: false },
      amount: bigintCodec(40n),
    });

    const filter = new AccountEventsFilter('5default', ['5default']);
    filter.process(api, [outbound]);

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
    const ownFee = [
      event('transactionPayment', 'TransactionFeePaid', [humanCodec('5default'), bigintCodec(2n), bigintCodec(0n)]),
    ];
    const otherFee = [
      event('transactionPayment', 'TransactionFeePaid', [humanCodec('5other'), bigintCodec(2n), bigintCodec(0n)], 3),
    ];
    const filter = new AccountEventsFilter('5default', ['5default']);

    filter.process(api, [...ownFee, ...otherFee]);

    expect(filter.transfers).toEqual([]);
    expect(filter.eventsByExtrinsic).toHaveLength(1);
    expect(filter.eventsByExtrinsic[0][1]).toMatchObject({
      pallet: 'transactionPayment',
      method: 'TransactionFeePaid',
    });
  });

  it('records historical token-gateway receipts and sends', () => {
    const received = [
      event('ownership', 'Minted', []),
      event('tokenGateway', 'AssetReceived', [humanCodec('5default'), bigintCodec(60n), {}]),
    ];
    const sent = [
      event('ownership', 'Burned', [humanCodec('5default'), bigintCodec(30n)]),
      event('tokenGateway', 'AssetTeleported', [
        humanCodec('5default'),
        hexCodec('0xrecipient'),
        bigintCodec(30n),
        {},
        hexCodec('0xcommitment'),
      ]),
    ];

    const receivedFilter = new AccountEventsFilter('5default', ['5default']);
    receivedFilter.process(api, received);
    expect(receivedFilter.transfers).toEqual([
      expect.objectContaining({
        transferType: 'tokenGateway',
        currency: 'argonot',
        amount: 60n,
        isInbound: true,
      }),
    ]);
    const sentFilter = new AccountEventsFilter('5default', ['5default']);
    sentFilter.process(api, sent);
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

  it('stores the finalized BalanceSet delta instead of its absolute free balance', async () => {
    const insertTransfer = vi.fn(async () => undefined);
    const wallet = new WalletForArgon(
      '5default',
      'defaultArgon',
      Promise.resolve({
        walletTransfersTable: { insert: insertTransfer },
      } as any),
    );
    wallet.balanceHistory = [
      {
        block: { blockNumber: 1, blockHash: '0x1', blockTime: 1, isFinalized: true },
        availableMicrogons: 100n,
        reservedMicrogons: 0n,
        availableMicronots: 0n,
        reservedMicronots: 0n,
        microgonsAdded: 100n,
        micronotsAdded: 0n,
        extrinsicEvents: [],
        transfers: [],
      },
    ];
    const balance = {
      block: { blockNumber: 2, blockHash: '0x2', blockTime: 2, isFinalized: false },
      availableMicrogons: 150n,
      reservedMicrogons: 0n,
      availableMicronots: 0n,
      reservedMicronots: 0n,
      microgonsAdded: 0n,
      micronotsAdded: 0n,
      extrinsicEvents: [],
      transfers: [
        {
          to: '5default',
          transferType: 'faucet' as const,
          currency: 'argon' as const,
          isInternal: false,
          isInbound: true,
          amount: 150n,
          extrinsicIndex: 2,
        },
      ],
    };

    wallet.addDiffs(balance);
    await wallet.onBalanceChange(balance, { USD: 1n, ARGNOT: 1n });
    expect(insertTransfer).not.toHaveBeenCalled();

    balance.block.isFinalized = true;
    await wallet.saveFinalizedTransfers(balance, { USD: 1n, ARGNOT: 1n });
    expect(insertTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 50n }));
  });

  it('updates recovered transfer classification without duplicating a missing counterparty', async () => {
    const db = await createTestDb();
    const transfer = {
      walletAddress: '5default',
      walletName: 'defaultArgon',
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

function event(section: string, method: string, values: unknown[], extrinsicIndex = 2): FrameSystemEventRecord {
  const fieldNames: Record<string, string[]> = {
    'crosschainTransfer.TransferOutStarted': [
      'destinationChain',
      'transferId',
      'accountId',
      'asset',
      'amount',
      'mintingAuthorityTip',
    ],
    'tokenGateway.AssetReceived': ['beneficiary', 'amount', 'source'],
    'tokenGateway.AssetTeleported': ['from', 'to', 'amount', 'dest', 'commitment'],
    'ownership.Burned': ['who', 'amount'],
  };
  const names = fieldNames[`${section}.${method}`] ?? [];
  const data = Object.assign(values, {
    names,
    toHuman: () => ({}),
  });
  return {
    event: { section, method, data } as GenericEvent,
    phase: {
      isApplyExtrinsic: true,
      asApplyExtrinsic: numberCodec(extrinsicIndex),
    },
  } as FrameSystemEventRecord;
}

function eventGuard(section: string, method: string) {
  return {
    is: (event: GenericEvent) => event.section === section && event.method === method,
  };
}
