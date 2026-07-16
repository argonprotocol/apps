import { describe, expect, it, vi } from 'vitest';
import { AccountEventsFilter, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import { type IBlockToProcess, WalletsForArgon } from '../lib/WalletsForArgon.ts';
import { WalletForArgon } from '../lib/WalletForArgon.ts';
import { SyncStateKeys } from '../lib/db/SyncStateTable.ts';
import { bigintCodec } from '../../core/__test__/helpers/codecs.ts';
import { WalletFinancials } from '../lib/financials/WalletBalances.ts';

describe('WalletsForArgon live balance tracking', () => {
  it('does not advance a finalized balance until its transfers are persisted', async () => {
    const insert = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(undefined);
    const wallet = new WalletForArgon(
      '5default',
      'defaultArgon',
      Promise.resolve({ walletTransfersTable: { insert } } as any),
    );
    const initialBlock = blockHeader(0, 'initial-finalized');
    const finalizedBlock = blockHeader(1, 'next-finalized');
    wallet.balanceHistory = [walletBalance(initialBlock, 0n)];
    const balance = {
      ...walletBalance(finalizedBlock, 10n),
      transfers: [
        {
          to: wallet.address,
          from: '5outside',
          transferType: 'transfer' as const,
          currency: 'argon' as const,
          isInternal: false,
          isInbound: true,
          amount: 10n,
          extrinsicIndex: 1,
        },
      ],
    };

    await expect(wallet.onBalanceChange(balance, { USD: 1n, ARGNOT: 2n })).rejects.toThrow('database unavailable');
    expect(wallet.latestBalanceChange?.block.blockHash).toBe(initialBlock.blockHash);

    await expect(wallet.onBalanceChange(balance, { USD: 1n, ARGNOT: 2n })).resolves.toBe(true);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(wallet.latestBalanceChange?.block.blockHash).toBe(finalizedBlock.blockHash);
  });

  it('retries finalized transfer rates and storage before notifying consumers', async () => {
    const api = {
      query: {
        system: {
          account: {
            multi: async (addresses: string[]) =>
              addresses.map((_, index) => ({
                data: { free: bigintCodec(index === 0 ? 10n : 0n), reserved: bigintCodec(0n) },
              })),
          },
        },
        ownership: {
          account: {
            multi: async (addresses: string[]) =>
              addresses.map(() => ({ free: bigintCodec(0n), reserved: bigintCodec(0n) })),
          },
        },
      },
    };
    const blockWatch = {
      getApi: vi.fn(async () => api),
      getEventsWithSpec: vi.fn(async () => ({ api, events: [] })),
    };
    const insertTransfer = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(undefined);
    const fetchMainchainRatesAtBlock = vi
      .fn()
      .mockRejectedValueOnce(new Error('rates unavailable'))
      .mockResolvedValue({ USD: 1n, ARGNOT: 2n });
    const wallets = createWallets({ walletTransfersTable: { insert: insertTransfer } }, blockWatch, {
      fetchMainchainRatesAtBlock,
    });
    const initialBlock = blockHeader(0, 'initial');
    wallets.defaultArgonWallet.balanceHistory = [walletBalance(initialBlock, 0n)];
    wallets.miningBotWallet.balanceHistory = [walletBalance(initialBlock, 0n)];
    wallets.operationalWallet.balanceHistory = [walletBalance(initialBlock, 0n)];
    const processEvents = vi.spyOn(AccountEventsFilter.prototype, 'process').mockImplementation(() => undefined);
    processEvents.mockImplementationOnce(function (this: AccountEventsFilter) {
      this.transfers = [
        {
          to: '5default',
          from: '5outside',
          transferType: 'transfer',
          currency: 'argon',
          isInternal: false,
          isInbound: true,
          amount: 10n,
          extrinsicIndex: 1,
        },
      ];
    });
    const onTransferIn = vi.fn(() => expect(insertTransfer).toHaveBeenCalledTimes(2));
    wallets.events.on('transfer-in', onTransferIn);

    await (wallets as unknown as { processBlock(block: IBlockToProcess): Promise<void> }).processBlock({
      blockNumber: 1,
      blockHash: '0x1',
      blockTime: 1,
      parentHash: '0x0',
      isFinalized: false,
      isProcessed: false,
    });

    expect(insertTransfer).not.toHaveBeenCalled();
    expect(onTransferIn).not.toHaveBeenCalled();

    const finalizePendingTransfers = () => {
      return (
        wallets as unknown as { finalizePendingTransfers(finalizedBlockNumber: number): Promise<void> }
      ).finalizePendingTransfers(1);
    };

    await expect(finalizePendingTransfers()).rejects.toThrow('rates unavailable');
    expect(wallets.defaultArgonWallet.balanceHistory.at(-1)?.block.isFinalized).toBe(false);
    expect(insertTransfer).not.toHaveBeenCalled();

    await expect(finalizePendingTransfers()).rejects.toThrow('database unavailable');
    expect(wallets.defaultArgonWallet.balanceHistory.at(-1)?.block.isFinalized).toBe(false);
    expect(onTransferIn).not.toHaveBeenCalled();

    await finalizePendingTransfers();

    expect(insertTransfer).toHaveBeenCalledTimes(2);
    expect(onTransferIn).toHaveBeenCalledOnce();
    expect(wallets.defaultArgonWallet.balanceHistory.at(-1)?.block.isFinalized).toBe(true);
    expect(onTransferIn).toHaveBeenCalledWith(
      wallets.defaultArgonWallet,
      expect.objectContaining({ transfers: [expect.objectContaining({ amount: 10n, isInbound: true })] }),
    );
    processEvents.mockRestore();
  });

  it('persists a cross-chain send when only account holds changed', async () => {
    const api = {
      query: {
        system: {
          account: {
            multi: async (addresses: string[]) =>
              addresses.map(() => ({ data: { free: bigintCodec(0n), reserved: bigintCodec(0n) } })),
          },
        },
        ownership: {
          account: {
            multi: async (addresses: string[]) =>
              addresses.map(() => ({ free: bigintCodec(0n), reserved: bigintCodec(0n) })),
          },
        },
      },
    };
    const blockWatch = {
      getApi: vi.fn(async () => api),
      getEventsWithSpec: vi.fn(async () => ({ api, events: [] })),
    };
    const insert = vi.fn(async () => undefined);
    const wallets = createWallets({ walletTransfersTable: { insert } }, blockWatch, {
      fetchMainchainRatesAtBlock: vi.fn(async () => ({ USD: 1n, ARGNOT: 2n })),
    });
    const initialBlock = blockHeader(0, 'initial');
    for (const wallet of wallets.wallets) wallet.balanceHistory = [walletBalance(initialBlock, 0n)];

    const processEvents = vi
      .spyOn(AccountEventsFilter.prototype, 'process')
      .mockImplementation(() => undefined)
      .mockImplementationOnce(function (this: AccountEventsFilter) {
        this.transfers = [
          {
            to: 'Ethereum',
            from: '5default',
            transferType: 'ethereum',
            currency: 'argonot',
            isInternal: false,
            isInbound: false,
            amount: 10n,
            extrinsicIndex: 1,
          },
        ];
      });

    await (wallets as unknown as { processBlock(block: IBlockToProcess): Promise<void> }).processBlock({
      blockNumber: 1,
      blockHash: '0x1',
      blockTime: 1,
      parentHash: '0x0',
      isFinalized: true,
      isProcessed: false,
    });

    expect(blockWatch.getEventsWithSpec).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: '5default', amount: -10n, currency: 'argonot' }),
    );
    processEvents.mockRestore();
  });

  it('rebases at advanced finality instead of walking back through a stale best-chain window', async () => {
    const staleFinalized = blockHeader(100, 'stale-finalized');
    const finalized = blockHeader(10_000, 'finalized');
    const next = blockHeader(10_001, 'next');
    const best = blockHeader(10_002, 'best');
    const getParentHeader = vi.fn(async (header: IBlockHeaderInfo) => {
      if (header.blockHash === best.blockHash) return next;
      if (header.blockHash === next.blockHash) return finalized;
      throw new Error(`Unexpected archive walk from ${header.blockNumber}`);
    });
    const blockWatch = {
      finalizedBlockHeader: finalized,
      latestHeaders: [finalized, next, best],
      getParentHeader,
      getApi: vi.fn().mockResolvedValue({
        query: {
          system: {
            account: {
              multi: async (addresses: string[]) =>
                addresses.map(() => ({ data: { free: bigintCodec(0n), reserved: bigintCodec(0n) } })),
            },
          },
          ownership: {
            account: {
              multi: async (addresses: string[]) =>
                addresses.map(() => ({ free: bigintCodec(0n), reserved: bigintCodec(0n) })),
            },
          },
        },
      }),
      clients: {},
    } as any;
    const upsert = vi.fn();
    const fetchMainchainRatesAtBlock = vi.fn();
    const wallets = createWallets({ syncStateTable: { upsert } }, blockWatch, { fetchMainchainRatesAtBlock });
    const staleBalance = walletBalance(staleFinalized, 10n);
    wallets.defaultArgonWallet.balanceHistory = [staleBalance];
    wallets.miningBotWallet.balanceHistory = [walletBalance(staleFinalized, 0n)];
    wallets.operationalWallet.balanceHistory = [walletBalance(staleFinalized, 0n)];
    (wallets as any).bestChainWindow = [{ ...staleFinalized, isProcessed: true } satisfies IBlockToProcess];
    const processBlock = vi.fn(async (block: IBlockToProcess) => {
      block.isProcessed = true;
    });
    (wallets as any).processBlock = processBlock;
    wallets.deferredLoading.resolve();
    const balanceChanges: bigint[] = [];
    const finalizedBlocks: IBlockHeaderInfo[] = [];
    wallets.events.on('balance-change', (balance, type) => {
      if (type === 'defaultArgon') balanceChanges.push(balance.availableMicrogons);
    });
    wallets.events.on('sync:finalized', block => finalizedBlocks.push(block));

    await wallets.loadBalancesAt(best);

    expect(getParentHeader.mock.calls.map(([header]) => header.blockNumber)).toEqual([10_002, 10_001]);
    expect(processBlock.mock.calls.map(([block]) => block.blockNumber)).toEqual([10_001, 10_002]);
    expect(balanceChanges).toEqual([0n]);
    expect(wallets.defaultArgonWallet.finalizedBalance?.block).toMatchObject({
      blockNumber: finalized.blockNumber,
      blockHash: finalized.blockHash,
      isFinalized: true,
    });
    expect(wallets.getLoadEvents('balance-change')).toEqual([]);
    expect(finalizedBlocks).toEqual([finalized]);
    expect(upsert).toHaveBeenCalledWith(
      SyncStateKeys.Wallet,
      expect.objectContaining({ blockHash: finalized.blockHash }),
    );
    expect(fetchMainchainRatesAtBlock).not.toHaveBeenCalled();
  });
});

describe('WalletsForArgon ARGNOT holdings', () => {
  it('marks ARGNOT outside known FIFO lots as unavailable holding basis', async () => {
    const fetchArgonotCustody = vi.fn().mockResolvedValue([transfer(1, '5default', 4n, false, undefined, 2_000_000n)]);
    const wallets = createWallets({ walletTransfersTable: { revision: 1, fetchArgonotCustody } });

    const positions = await new WalletFinancials(wallets).loadPositions({
      accounts: [account(wallets.defaultArgonWallet, 6n)],
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 3_000_000n,
    });

    expect(positions).toEqual([
      expect.objectContaining({
        kind: 'wallet-balance',
        asset: 'ARGNOT',
        nativeAmount: 2n,
        currentValue: 6n,
      }),
      expect.objectContaining({
        kind: 'wallet-holding',
        lifecycle: 'active',
        nativeAmount: 4n,
        investedCost: 8n,
        currentValue: 12n,
      }),
      expect.objectContaining({
        kind: 'wallet-holding',
        lifecycle: 'unavailable',
        nativeAmount: 2n,
      }),
    ]);
  });

  it('keeps an unavailable marker after unknown-basis ARGNOT leaves the wallet', async () => {
    const faucet = {
      ...transfer(1, '5default', 5n, false, undefined, 0n),
      transferType: 'faucet' as const,
    };
    const outbound = transfer(2, '5default', -5n, false, '5outside', 3_000_000n);
    const fetchArgonotCustody = vi.fn().mockResolvedValue([faucet, outbound]);
    const wallets = createWallets({ walletTransfersTable: { revision: 1, fetchArgonotCustody } });

    const positions = await new WalletFinancials(wallets).loadPositions({
      accounts: [account(wallets.defaultArgonWallet, 0n)],
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 3_000_000n,
    });

    expect(positions).toEqual([
      expect.objectContaining({
        kind: 'wallet-holding',
        lifecycle: 'unavailable',
        accountId: '5default',
        nativeAmount: 0n,
      }),
    ]);
  });

  it('preserves FIFO basis across owned custody moves and removes tracked quantity from liquid residuals', async () => {
    const transfers = [
      transfer(1, '5default', 4n, false, undefined, 2_000_000n),
      transfer(2, '5default', 6n, false, undefined, 3_000_000n),
      transfer(3, '5default', -6n, true, '5operational', 3_000_000n),
      transfer(4, '5operational', 6n, true, '5default', 3_000_000n),
      transfer(5, '5operational', -2n, false, '5outside', 3_000_000n),
    ];
    const fetchArgonotCustody = vi.fn().mockResolvedValue(transfers);
    const db = {
      walletTransfersTable: { revision: 1, argonotCustodyRevision: 1, fetchArgonotCustody },
    };
    const wallets = createWallets(db);
    const accounts = [
      account(wallets.defaultArgonWallet, 4n),
      account(wallets.operationalWallet, 4n),
      account(wallets.miningBotWallet, 5n),
    ];

    const positionArgs = {
      accounts,
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 4_000_000n,
    } as const;
    const financials = new WalletFinancials(wallets);
    const [positions] = await Promise.all([
      financials.loadPositions(positionArgs),
      financials.loadPositions(positionArgs),
    ]);

    expect(fetchArgonotCustody).toHaveBeenCalledOnce();
    expect(
      positions
        .filter(position => position.kind === 'wallet-holding')
        .map(position => [
          position.lifecycle,
          position.accountId,
          position.nativeAmount,
          position.investedCost,
          position.currentValue,
          position.settledPrincipalValue,
        ]),
    ).toEqual([
      ['completed', '5operational', 2n, 4n, 0n, 6n],
      ['active', '5default', 4n, 12n, 16n, 0n],
      ['active', '5operational', 2n, 4n, 8n, 0n],
      ['active', '5operational', 2n, 6n, 8n, 0n],
      ['unavailable', '5miner', 5n, undefined, undefined, undefined],
    ]);
    expect(
      positions
        .filter(position => position.kind === 'wallet-balance' && position.asset === 'ARGNOT')
        .map(position => [position.accountId, position.nativeAmount]),
    ).toEqual([['5miner', 5n]]);

    db.walletTransfersTable.revision = 2;
    await financials.loadPositions(positionArgs);
    expect(fetchArgonotCustody).toHaveBeenCalledOnce();

    db.walletTransfersTable.argonotCustodyRevision = 2;
    await financials.loadPositions(positionArgs);
    expect(fetchArgonotCustody).toHaveBeenCalledTimes(2);
  });

  it('opens ordinary ARGNOT basis at the handoff mark when mining custody returns', async () => {
    const fetchArgonotCustody = vi.fn().mockResolvedValue([transfer(1, '5default', 5n, true, '5miner', 2_000_000n)]);
    const wallets = createWallets({ walletTransfersTable: { revision: 1, fetchArgonotCustody } });

    const positions = await new WalletFinancials(wallets).loadPositions({
      accounts: [account(wallets.defaultArgonWallet, 5n)],
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 3_000_000n,
    });

    expect(positions).toEqual([
      expect.objectContaining({
        kind: 'wallet-holding',
        lifecycle: 'active',
        accountId: '5default',
        nativeAmount: 5n,
        investedCost: 10n,
        currentValue: 15n,
      }),
    ]);
  });

  it('closes ordinary ARGNOT basis at the mark where mining custody begins', async () => {
    const fetchArgonotCustody = vi
      .fn()
      .mockResolvedValue([
        transfer(1, '5default', 5n, false, undefined, 2_000_000n),
        transfer(2, '5default', -5n, true, '5miner', 3_000_000n),
      ]);
    const wallets = createWallets({ walletTransfersTable: { revision: 1, fetchArgonotCustody } });

    const positions = await new WalletFinancials(wallets).loadPositions({
      accounts: [account(wallets.defaultArgonWallet, 0n)],
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 4_000_000n,
    });

    expect(positions).toEqual([
      expect.objectContaining({
        kind: 'wallet-holding',
        lifecycle: 'completed',
        accountId: '5default',
        nativeAmount: 5n,
        investedCost: 10n,
        settledPrincipalValue: 15n,
      }),
    ]);
  });

  it('preserves basis when the legacy mining hold returns ARGNOT to the default account', async () => {
    const fetchArgonotCustody = vi
      .fn()
      .mockResolvedValue([
        transfer(1, '5legacy', 5n, false, undefined, 2_000_000n),
        transfer(2, '5legacy', -5n, true, '5default', 3_000_000n),
        transfer(3, '5default', 5n, true, '5legacy', 3_000_000n),
      ]);
    const wallets = createWallets({ walletTransfersTable: { revision: 1, fetchArgonotCustody } });

    const positions = await new WalletFinancials(wallets).loadPositions({
      accounts: [account(wallets.defaultArgonWallet, 5n)],
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 4_000_000n,
    });

    expect(positions).toEqual([
      expect.objectContaining({
        kind: 'wallet-holding',
        lifecycle: 'active',
        accountId: '5default',
        nativeAmount: 5n,
        investedCost: 10n,
        currentValue: 20n,
      }),
    ]);
  });

  it('removes all modeled mining custody from the mining bot liquid residual', async () => {
    const wallets = createWallets({
      walletTransfersTable: { revision: 1, fetchArgonotCustody: vi.fn().mockResolvedValue([]) },
    });

    const positions = await new WalletFinancials(wallets).loadPositions({
      accounts: [account(wallets.miningBotWallet, 10n)],
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      claimedMicronotsByAccount: new Map([['5miner', 10n]]),
      liveArgonotRateMicrogons: 3_000_000n,
    });

    expect(positions).toEqual([]);
  });
});

function account(wallet: WalletForArgon, availableMicronots: bigint) {
  return {
    address: wallet.address,
    wallet,
    availableMicrogons: 0n,
    reservedMicrogons: 0n,
    availableMicronots,
    reservedMicronots: 0n,
    microgonHolds: [],
    micronotHolds: [],
  };
}

function createWallets(db: object, blockWatch: object = {}, currency: object = {}) {
  return new WalletsForArgon({
    walletKeys: {
      defaultArgonAddress: '5default',
      miningBotAddress: '5miner',
      operationalAddress: '5operational',
      legacyMiningHoldAddress: '5legacy',
    } as any,
    dbPromise: Promise.resolve(db as any),
    blockWatch: blockWatch as any,
    currency: currency as any,
  });
}

function transfer(
  id: number,
  walletAddress: string,
  amount: bigint,
  isInternal: boolean,
  otherParty: string | undefined,
  microgonsForArgonot: bigint,
) {
  const blockTime = new Date(`2026-07-${String(id).padStart(2, '0')}T00:00:00Z`);
  return {
    id,
    walletAddress,
    walletName: walletAddress,
    amount,
    currency: 'argonot' as const,
    otherParty,
    transferType: 'transfer' as const,
    isInternal,
    extrinsicIndex: 0,
    microgonsForArgonot,
    microgonsForUsd: 1_000_000n,
    blockNumber: id,
    blockHash: `0x${id}`,
    blockTime,
    createdAt: blockTime,
    updatedAt: blockTime,
  };
}

function blockHeader(blockNumber: number, name: string): IBlockHeaderInfo {
  return {
    blockNumber,
    blockHash: `0x${name}`,
    blockTime: blockNumber * 1_000,
    parentHash: `0x${name}-parent`,
    isFinalized: name.includes('finalized'),
    author: '5author',
    tick: blockNumber,
  };
}

function walletBalance(block: IBlockHeaderInfo, availableMicrogons: bigint) {
  return {
    block: {
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      blockTime: block.blockTime,
      isFinalized: block.isFinalized,
    },
    availableMicrogons,
    reservedMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicronots: 0n,
    microgonsAdded: 0n,
    micronotsAdded: 0n,
    extrinsicEvents: [],
    transfers: [],
  };
}
