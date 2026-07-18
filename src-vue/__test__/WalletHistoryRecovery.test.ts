import { AccountActivityKind, NetworkConfig, setFetchImplementation } from '@argonprotocol/apps-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bigintCodec, hexCodec, humanCodec, numberCodec } from '../../core/__test__/helpers/codecs.ts';
import { WalletForArgon } from '../lib/WalletForArgon.ts';
import { WalletHistoryRecovery } from '../lib/recovery/WalletHistory.ts';
import { SyncStateKeys } from '../lib/db/SyncStateTable.ts';

describe('WalletHistoryRecovery', () => {
  afterEach(() => {
    setFetchImplementation();
    NetworkConfig.clearRuntimeOverride('dev-docker');
  });

  it('keeps every account activity kind when owned accounts share a block', async () => {
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', { indexerHost: 'https://indexer.test' });
    setFetchImplementation(async input => {
      const address = new URL(String(input)).pathname.split('/').at(-1);
      const activityMask = address === '5default' ? AccountActivityKind.Transfer : AccountActivityKind.Crosschain;
      return new Response(
        JSON.stringify({
          blocks: [{ blockNumber: 10, blockHash: '0x10', specVersion: 141, activityMask }],
          asOfBlock: 10,
          definitionVersion: 1,
          coverage: { fromBlock: 0, toBlock: 10, gaps: [] },
        }),
      );
    });
    const dbPromise = Promise.resolve({} as any);
    const recovery = new WalletHistoryRecovery({
      dbPromise,
      blockWatch: { clients: { events: { on: vi.fn() } } } as any,
      currency: {} as any,
      recoveryWallets: [
        new WalletForArgon('5default', 'defaultArgon', dbPromise),
        new WalletForArgon('5operational', 'operational', dbPromise),
      ],
      ownedAddresses: ['5default', '5operational'],
    });
    const blocks = new Map();

    await recovery.findActivityBlocks('5default', blocks, [0, 10]);
    await recovery.findActivityBlocks('5operational', blocks, [0, 10]);

    expect(blocks.get(10)?.activityMask).toBe(AccountActivityKind.Transfer | AccountActivityKind.Crosschain);
    await recovery.close();
  });

  it('advances the checkpoint when the indexer reports no transfer blocks', async () => {
    const state = new Map<string, unknown>();
    const db = {
      syncStateTable: {
        get: vi.fn(async key => state.get(key)),
        upsert: vi.fn(async (key, value) => state.set(key, value)),
      },
      walletTransfersTable: { revision: 0 },
    };
    const blockWatch = {
      clients: { events: { on: vi.fn() } },
      getEventsWithSpec: vi.fn(),
    };
    const dbPromise = Promise.resolve(db as any);
    const onRecovered = vi.fn();
    const fetchMainchainRatesAtBlock = vi.fn();
    const recovery = new WalletHistoryRecovery({
      dbPromise,
      blockWatch: blockWatch as any,
      currency: { fetchMainchainRatesAtBlock } as any,
      recoveryWallets: [new WalletForArgon('5default', 'defaultArgon', dbPromise)],
      ownedAddresses: ['5default'],
      onRecovered,
    });
    vi.spyOn(recovery, 'findActivityBlocks').mockImplementation(async () => {
      return { asOfBlock: 1, definitionVersion: 1 };
    });

    await expect(recovery.prepare()).resolves.toBe(true);
    await recovery.recoverNow(1);

    expect(blockWatch.getEventsWithSpec).not.toHaveBeenCalled();
    expect(fetchMainchainRatesAtBlock).not.toHaveBeenCalled();
    expect(onRecovered).toHaveBeenCalledWith({ transfers: 0, argonotCustody: 0, asOfBlock: 1 });
    expect(state.get(SyncStateKeys.WalletHistory)).toMatchObject({ asOfBlock: 1, definitionVersion: 1 });
    await expect(recovery.prepare()).resolves.toBe(false);
    await expect(recovery.hasCompleteCoverage(1)).resolves.toBe(true);
    await expect(recovery.hasCompleteCoverage(2)).resolves.toBe(false);

    state.set(SyncStateKeys.WalletHistory, {
      ...(state.get(SyncStateKeys.WalletHistory) as object),
      addresses: ['5other'],
    });
    await expect(recovery.hasCompleteCoverage(1)).resolves.toBe(false);
    await recovery.close();
  });

  it('recovers a cross-chain send that changed only account holds', async () => {
    const state = new Map<string, unknown>();
    const insert = vi.fn(async () => undefined);
    const db = {
      syncStateTable: {
        get: vi.fn(async key => state.get(key)),
        upsert: vi.fn(async (key, value) => state.set(key, value)),
      },
      walletTransfersTable: { insert, revision: 0, argonotCustodyRevision: 0 },
    };
    const eventData = Object.assign(
      [
        humanCodec('Ethereum'),
        hexCodec('0xtransfer'),
        humanCodec('5default'),
        { isArgon: false },
        bigintCodec(40n),
        bigintCodec(0n),
      ],
      {
        destinationChain: humanCodec('Ethereum'),
        transferId: hexCodec('0xtransfer'),
        accountId: humanCodec('5default'),
        asset: { isArgon: false },
        amount: bigintCodec(40n),
        toHuman: () => ({}),
      },
    );
    const api = {
      events: {
        balances: { BalanceSet: { is: () => false }, Transfer: { is: () => false } },
        ownership: { BalanceSet: { is: () => false }, Transfer: { is: () => false } },
        crosschainTransfer: {
          TransferOutStarted: {
            is: (event: { section: string; method: string }) => {
              return event.section === 'crosschainTransfer' && event.method === 'TransferOutStarted';
            },
          },
          TransferToArgonSettled: { is: () => false },
        },
        transactionPayment: { TransactionFeePaid: { is: () => false } },
      },
    };
    const blockWatch = {
      clients: { events: { on: vi.fn() } },
      getHeader: vi.fn(async blockNumber => ({
        blockNumber,
        blockHash: `0x${blockNumber}`,
        blockTime: blockNumber,
        parentHash: `0x${Math.max(0, blockNumber - 1)}`,
      })),
      getEventsWithSpec: vi.fn(async () => ({
        api,
        specVersion: 157,
        events: [
          {
            event: { section: 'crosschainTransfer', method: 'TransferOutStarted', data: eventData },
            phase: { isApplyExtrinsic: true, asApplyExtrinsic: numberCodec(2) },
          },
        ],
      })),
    };
    const dbPromise = Promise.resolve(db as any);
    const recovery = new WalletHistoryRecovery({
      dbPromise,
      blockWatch: blockWatch as any,
      currency: { fetchMainchainRatesAtBlock: vi.fn(async () => ({ USD: 1n, ARGNOT: 2n })) } as any,
      recoveryWallets: [new WalletForArgon('5default', 'defaultArgon', dbPromise)],
      ownedAddresses: ['5default'],
    });
    vi.spyOn(recovery, 'findActivityBlocks').mockImplementation(async (_address, blocks) => {
      blocks.set(1, {
        blockNumber: 1,
        blockHash: '0x1',
        specVersion: 157,
        activityMask: AccountActivityKind.Crosschain,
      });
      return { asOfBlock: 1, definitionVersion: 1 };
    });

    await recovery.prepare();
    await recovery.recoverNow(1);

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: '5default',
        amount: -40n,
        currency: 'argonot',
        transferType: 'ethereum',
        tokenGatewayCommitmentHash: '0xtransfer',
      }),
    );
    await recovery.close();
  });
});
