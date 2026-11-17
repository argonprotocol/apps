import { describe, expect, it, vi } from 'vitest';
import {
  AccountEventsFilter,
  createDeferred,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import { WalletsForArgon } from '../lib/WalletsForArgon.ts';
import { WalletForArgon } from '../lib/WalletForArgon.ts';
import { SyncStateKeys } from '../lib/db/SyncStateTable.ts';
import { WalletFinancials } from '../lib/financials/WalletBalances.ts';

describe('WalletsForArgon live balance tracking', () => {
  it('loads only the default wallet when operational wallet metadata is unavailable', async () => {
    const wallets = new WalletsForArgon({
      walletKeys: {
        defaultArgonAddress: '5default',
        miningBotAddress: '',
        operationalAddress: '',
        legacyMiningHoldAddress: '',
      } as any,
      dbPromise: Promise.resolve({} as any),
      blockWatch: {} as any,
      currency: {} as any,
    });

    expect(wallets.wallets).toEqual([wallets.defaultArgonWallet]);
    expect(wallets.addresses).toEqual(['5default']);
    expect(wallets.ownedAddresses).toEqual(['5default']);
  });

  it('publishes the current best balance without loading intermediate blocks', async () => {
    const finalized = blockHeader(0, 'finalized');
    const interim = blockHeader(1, 'interim');
    const best = blockHeader(2, 'best');
    const nextBest = blockHeader(3, 'next-best');
    const blockWatch = {
      finalizedBlockHeader: finalized,
      bestBlockHeader: best,
      latestHeaders: [finalized, interim, best],
      getApi: vi.fn(async (block: IBlockHeaderInfo) => {
        const balance = block.blockHash === nextBest.blockHash ? 2n : BigInt(block.blockNumber);
        return balanceApi(balance);
      }),
      getParentHeader: vi.fn(async (header: IBlockHeaderInfo) =>
        header.blockHash === best.blockHash ? interim : finalized,
      ),
      getEventsWithSpec: vi.fn(async (block: IBlockHeaderInfo) => ({
        api: balanceApi(BigInt(block.blockNumber)),
        events: [],
      })),
    };
    const upsert = vi.fn(async () => undefined);
    const wallets = createWallets({ syncStateTable: { upsert } }, blockWatch, {
      fetchMainchainRatesAtBlock: vi.fn(),
    });
    for (const wallet of wallets.wallets) wallet.balanceHistory = [walletBalance(finalized, 0n)];
    const balanceHashes: string[] = [];
    wallets.events.on('balance-change', balance => balanceHashes.push(balance.block.blockHash));

    await wallets.loadBalancesAt(best);

    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(2n);
    expect(wallets.defaultArgonWallet.balanceHistory.map(balance => balance.block.blockNumber)).toEqual([2]);
    expect(wallets.bestBlock).toEqual(best);
    expect(balanceHashes).toEqual([best.blockHash]);
    expect(blockWatch.getApi).toHaveBeenCalledOnce();
    expect(blockWatch.getApi).toHaveBeenCalledWith(best);
    expect(blockWatch.getParentHeader).not.toHaveBeenCalled();
    expect(blockWatch.getEventsWithSpec).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();

    blockWatch.bestBlockHeader = nextBest;
    blockWatch.latestHeaders = [finalized, interim, best, nextBest];
    await wallets.loadBalancesAt(nextBest);

    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(2n);
    expect(wallets.defaultArgonWallet.balanceHistory.map(balance => balance.block.blockHash)).toEqual([
      nextBest.blockHash,
    ]);
    expect(wallets.bestBlock).toEqual(nextBest);
    expect(balanceHashes).toEqual([best.blockHash, nextBest.blockHash]);
    expect(blockWatch.getApi).toHaveBeenCalledTimes(2);
  });

  it('publishes a completed balance read before catching up to a queued newer head', async () => {
    const finalized = blockHeader(0, 'finalized');
    const firstBest = blockHeader(2, 'same-height-a');
    const replacementBest = blockHeader(2, 'same-height-b');
    const latestBest = blockHeader(3, 'latest-best');
    const releaseFirstRead = createDeferred<void>();
    const blockWatch = {
      bestBlockHeader: firstBest,
      latestHeaders: [finalized, firstBest],
      getApi: vi.fn(async (header: IBlockHeaderInfo) => {
        if (header.blockHash === firstBest.blockHash) await releaseFirstRead.promise;
        return balanceApi(BigInt(header.blockNumber));
      }),
    };
    const wallets = createWallets({}, blockWatch);
    for (const wallet of wallets.wallets) wallet.balanceHistory = [walletBalance(finalized, 0n)];
    const balanceHashes: string[] = [];
    wallets.events.on('balance-change', balance => balanceHashes.push(balance.block.blockHash));

    const firstLoad = wallets.loadBalancesAt(firstBest);
    await vi.waitFor(() => expect(blockWatch.getApi).toHaveBeenCalledWith(firstBest));

    blockWatch.bestBlockHeader = replacementBest;
    blockWatch.latestHeaders = [finalized, replacementBest];
    const replacementLoad = wallets.loadBalancesAt(replacementBest);
    blockWatch.bestBlockHeader = latestBest;
    blockWatch.latestHeaders = [finalized, latestBest];
    const latestLoad = wallets.loadBalancesAt(latestBest);
    releaseFirstRead.resolve();
    await Promise.all([firstLoad, replacementLoad, latestLoad]);

    expect(blockWatch.getApi.mock.calls.map(([header]) => header.blockHash)).toEqual([
      firstBest.blockHash,
      latestBest.blockHash,
    ]);
    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(3n);
    expect(wallets.defaultArgonWallet.balanceHistory.map(balance => balance.block.blockHash)).toEqual([
      latestBest.blockHash,
    ]);
    expect(wallets.bestBlock).toEqual(latestBest);
    expect(balanceHashes).toEqual([firstBest.blockHash, latestBest.blockHash]);
  });

  it('keeps funded wallets current from transfers, initialization mints and ARGNOT holds without polling idle blocks', async () => {
    const headers = Array.from({ length: 6 }, (_, index) => ({
      ...blockHeader(index, String(index)),
      parentHash: `0x${index - 1}`,
      frameId: 1,
    }));
    const events: RuntimeSystemEventRecord[][] = [
      [],
      [
        {
          event: { section: 'balances', method: 'Transfer', data: { from: '5outside', to: '5other', amount: 20n } },
          phase: { type: 'ApplyExtrinsic', value: 0 },
          topics: [],
        },
      ],
      [
        {
          event: { section: 'balances', method: 'Transfer', data: { from: '5outside', to: '5default', amount: 20n } },
          phase: { type: 'ApplyExtrinsic', value: 0 },
          topics: [],
        },
      ],
      [],
      [
        {
          event: { section: 'balances', method: 'Minted', data: { who: '5default', amount: 5n } },
          phase: { type: 'Initialization' },
          topics: [],
        },
      ],
      [
        {
          event: { section: 'ownership', method: 'Reserved', data: { who: '5operational', amount: 10n } },
          phase: { type: 'ApplyExtrinsic', value: 0 },
          topics: [],
        },
      ],
    ];
    const blockWatch = {
      bestBlockHeader: headers[0],
      latestHeaders: headers,
      getEvents: vi.fn(async (header: IBlockHeaderInfo) => events[header.blockNumber]),
      getApi: vi.fn(async (header: IBlockHeaderInfo) => {
        const balance = [100n, 100n, 120n, 120n, 125n, 125n][header.blockNumber];
        const api = balanceApi(balance);
        api.query.ownership.account.multi = async addresses =>
          addresses.map(address => ({
            free: 0n,
            reserved: header.blockNumber === 5 && address === '5operational' ? 10n : 0n,
          }));
        return api;
      }),
    };
    const wallets = createWallets({}, blockWatch);
    wallets.deferredLoading.resolve();
    const changes: string[] = [];
    wallets.events.on('balance-change', (balance, type) => changes.push(`${type}:${balance.block.blockHash}`));
    await wallets.loadBalancesAt(headers[0]);

    blockWatch.bestBlockHeader = headers[1];
    blockWatch.latestHeaders = headers.slice(0, 2);
    await wallets.loadBalancesAt(headers[1]);
    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(100n);
    expect(blockWatch.getApi).toHaveBeenCalledOnce();
    expect(wallets.bestBlock).toEqual(headers[1]);

    // A coalesced head must include a transfer in its intermediate block.
    blockWatch.bestBlockHeader = headers[3];
    blockWatch.latestHeaders = headers.slice(0, 4);
    await wallets.loadBalancesAt(headers[3]);
    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(120n);

    blockWatch.bestBlockHeader = headers[4];
    blockWatch.latestHeaders = headers.slice(0, 5);
    await wallets.loadBalancesAt(headers[4]);
    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(125n);

    blockWatch.bestBlockHeader = headers[5];
    blockWatch.latestHeaders = headers;
    await wallets.loadBalancesAt(headers[5]);
    expect(wallets.operationalWallet.reservedMicronots).toBe(10n);
    expect(changes).toEqual(['argon:0x0', 'argon:0x3', 'argon:0x4', 'operational:0x5']);
    expect(blockWatch.getApi.mock.calls.map(([header]) => header.blockNumber)).toEqual([0, 3, 4, 5]);
  });

  it('retains the balance cursor on unreadable events and reconciles replacements, gaps and frame turns', async () => {
    const headers = Array.from({ length: 6 }, (_, index) => ({
      ...blockHeader(index, String(index)),
      parentHash: `0x${index - 1}`,
      frameId: 1,
    }));
    const blockWatch = {
      bestBlockHeader: headers[0],
      latestHeaders: headers.slice(0, 1),
      getEvents: vi.fn(async (): Promise<RuntimeSystemEventRecord[]> => []),
      getApi: vi.fn(async (header: IBlockHeaderInfo) => balanceApi(BigInt(header.blockNumber))),
    };
    const wallets = createWallets({}, blockWatch);
    wallets.deferredLoading.resolve();
    await wallets.loadBalancesAt(headers[0]);

    blockWatch.bestBlockHeader = headers[1];
    blockWatch.latestHeaders = headers.slice(0, 2);
    blockWatch.getEvents.mockRejectedValueOnce(new Error('Events unavailable'));
    await expect(wallets.loadBalancesAt(headers[1])).rejects.toThrow('Events unavailable');
    expect(wallets.bestBlock).toEqual(headers[0]);
    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(0n);

    await wallets.loadBalancesAt(headers[1]);
    expect(wallets.bestBlock).toEqual(headers[1]);
    expect(blockWatch.getApi).toHaveBeenCalledOnce();

    const replacement = { ...headers[1], blockHash: '0xreplacement' };
    blockWatch.bestBlockHeader = replacement;
    blockWatch.latestHeaders = [headers[0], replacement];
    await wallets.loadBalancesAt(replacement);
    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(1n);

    blockWatch.bestBlockHeader = headers[4];
    blockWatch.latestHeaders = headers.slice(3, 5);
    await wallets.loadBalancesAt(headers[4]);
    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(4n);

    const nextFrame = { ...headers[5], frameId: 2 };
    blockWatch.bestBlockHeader = nextFrame;
    blockWatch.latestHeaders.push(nextFrame);
    await wallets.loadBalancesAt(nextFrame);
    expect(wallets.defaultArgonWallet.availableMicrogons).toBe(5n);
    expect(wallets.bestBlock).toEqual(nextFrame);
    expect(blockWatch.getApi.mock.calls.map(([header]) => header.blockHash)).toEqual([
      '0x0',
      '0xreplacement',
      '0x4',
      '0x5',
    ]);
  });

  it('reuses financial balances and holds only across proven quiet blocks, preserving observation and retry boundaries', async () => {
    const headers = Array.from({ length: 4 }, (_, index) => ({
      ...blockHeader(index, String(index)),
      parentHash: `0x${index - 1}`,
      frameId: index === 3 ? 2 : 1,
    }));
    const blockWatch = {
      latestHeaders: headers,
      getEvents: vi.fn(async (header: IBlockHeaderInfo): Promise<RuntimeSystemEventRecord[]> => {
        if (header.blockNumber !== 2) return [];
        return [
          {
            event: {
              section: 'balances',
              method: 'Held',
              data: { who: '5default', amount: 25n, reason: { type: 'Vaults', value: { type: 'EnterVault' } } },
            },
            phase: { type: 'ApplyExtrinsic', value: 0 },
            topics: [],
          },
        ];
      }),
    };
    const wallets = createWallets({}, blockWatch);
    const stabilizerHold = {
      id: { type: 'StabilizerBuys', value: { type: 'PurchasePrincipal' } },
      amount: 25n,
    } as const;
    const vaultHold = { id: { type: 'Vaults', value: { type: 'EnterVault' } }, amount: 25n } as const;
    const api = balanceApi(75n);
    let released = false;
    api.query.system.account.multi = async addresses =>
      addresses.map((_, index) => {
        if (index !== 0) return { data: { free: 0n, reserved: 0n } };
        if (released) return { data: { free: 100n, reserved: 0n } };
        return { data: { free: 75n, reserved: 25n } };
      });
    const holds = vi.fn(async () => [[stabilizerHold], [], []] as (typeof stabilizerHold | typeof vaultHold)[][]);
    const chainApi = {
      ...api,
      query: {
        ...api.query,
        balances: { holds: { multi: holds } },
        ownership: { ...api.query.ownership, holds: { multi: async () => [] } },
      },
    } as unknown as import('@argonprotocol/apps-core').ArgonQueryClient;

    await wallets.readAccountSnapshot({ api: chainApi, header: headers[0], includeHolds: false });
    expect(holds).not.toHaveBeenCalled();
    const initial = await wallets.readAccountSnapshot({ api: chainApi, header: headers[0] });
    expect(initial.accounts[0].microgonHolds).toEqual([stabilizerHold]);

    const quiet = await wallets.readAccountSnapshot({ api: chainApi, header: headers[1] });
    expect(holds).toHaveBeenCalledOnce();
    expect(quiet.accounts[0].availableMicrogons).toBe(75n);
    expect(quiet.accounts[0].microgonHolds).toEqual([stabilizerHold]);
    expect(quiet.observation.blockHash).toBe(headers[1].blockHash);
    expect(initial.observation.blockHash).toBe(headers[0].blockHash);

    holds.mockRejectedValueOnce(new Error('Holds unavailable'));
    await expect(wallets.readAccountSnapshot({ api: chainApi, header: headers[2] })).rejects.toThrow(
      'Holds unavailable',
    );
    expect(quiet.accounts[0].microgonHolds).toEqual([stabilizerHold]);
    holds.mockResolvedValue([[vaultHold], [], []]);
    const changed = await wallets.readAccountSnapshot({ api: chainApi, header: headers[2] });
    expect(changed.accounts[0].microgonHolds).toEqual([vaultHold]);
    expect(changed.accounts[0].availableMicrogons).toBe(75n);

    released = true;
    holds.mockResolvedValue([[], [], []]);
    const matured = await wallets.readAccountSnapshot({ api: chainApi, header: headers[3] });
    expect(matured.accounts[0].microgonHolds).toEqual([]);
    expect(matured.accounts[0].availableMicrogons).toBe(100n);
    expect(matured.accounts[0].reservedMicrogons).toBe(0n);
    expect(matured.observation.blockHash).toBe(headers[3].blockHash);

    // An older explicit snapshot cannot replace the current cached observation.
    released = false;
    holds.mockResolvedValue([[stabilizerHold], [], []]);
    await wallets.readAccountSnapshot({ api: chainApi, header: headers[0] });
    const current = await wallets.readAccountSnapshot({ api: chainApi, header: headers[3] });
    expect(current.accounts[0].microgonHolds).toEqual([]);
    expect(current.accounts[0].availableMicrogons).toBe(100n);

    wallets.configureDefaultArgonWallet('5new-default');
    const reconfigured = await wallets.readAccountSnapshot({ api: chainApi, header: headers[3] });
    expect(reconfigured.accounts[0].address).toBe('5new-default');
    expect(reconfigured.accounts[0].microgonHolds).toEqual([stabilizerHold]);
  });

  it('reports finalized blocks missed since the persisted wallet cursor', async () => {
    const savedFinalized = blockHeader(90, 'saved-finalized');
    const currentFinalized = blockHeader(100, 'current-finalized');
    const currentBest = blockHeader(102, 'current-best');
    const api = {
      query: {
        system: {
          account: {
            multi: async (addresses: string[]) => addresses.map(() => ({ data: { free: 0n, reserved: 0n } })),
          },
        },
        ownership: {
          account: {
            multi: async (addresses: string[]) => addresses.map(() => ({ free: 0n, reserved: 0n })),
          },
        },
      },
    };
    const blockWatch = {
      start: vi.fn(async () => undefined),
      finalizedBlockHeader: currentFinalized,
      bestBlockHeader: currentBest,
      latestHeaders: [currentFinalized, currentBest],
      events: { on: vi.fn(() => () => undefined) },
      getApi: vi.fn(async (_header: IBlockHeaderInfo) => api),
    };
    const syncStateTable = {
      get: vi.fn(async () => ({ ...savedFinalized, isProcessed: true })),
      upsert: vi.fn(async () => undefined),
    };
    const wallets = createWallets({ syncStateTable }, blockWatch);
    const gaps: { afterBlock: number; toBlock: number }[] = [];
    const balanceBlocks: string[] = [];
    wallets.events.on('history:gap', gap => gaps.push(gap));
    wallets.events.on('balance-change', balance => balanceBlocks.push(balance.block.blockHash));

    await wallets.load();

    const unchangedBest = blockHeader(103, 'unchanged-best');
    blockWatch.bestBlockHeader = unchangedBest;
    blockWatch.latestHeaders = [currentFinalized, unchangedBest];
    await wallets.loadBalancesAt(unchangedBest);

    expect(gaps).toEqual([{ afterBlock: 90, toBlock: 100 }]);
    expect(balanceBlocks).toEqual([currentBest.blockHash]);
    expect(blockWatch.getApi).toHaveBeenCalledTimes(2);
    expect(blockWatch.getApi).toHaveBeenCalledWith(currentBest);
    expect(blockWatch.getApi).toHaveBeenCalledWith(unchangedBest);
    await vi.waitFor(() => expect(syncStateTable.upsert).toHaveBeenCalled());
  });

  it('persists a cross-chain send when only account holds changed', async () => {
    const api = {
      query: {
        system: {
          account: {
            multi: async (addresses: string[]) => addresses.map(() => ({ data: { free: 0n, reserved: 0n } })),
          },
        },
        ownership: {
          account: {
            multi: async (addresses: string[]) => addresses.map(() => ({ free: 0n, reserved: 0n })),
          },
        },
      },
    };
    const blockWatch = {
      getApi: vi.fn(async () => api),
      getEventsWithSpec: vi.fn(async () => ({ api, events: [] })),
    };
    const insert = vi.fn(async () => undefined);
    const upsert = vi.fn(async () => undefined);
    const wallets = createWallets({ walletTransfersTable: { insert }, syncStateTable: { upsert } }, blockWatch, {
      fetchMainchainRatesAtBlock: vi.fn(async () => ({ USD: 1n, ARGNOT: 2n })),
    });
    const initialBlock = blockHeader(0, 'initial');
    for (const wallet of wallets.wallets) wallet.balanceHistory = [walletBalance(initialBlock, 0n)];
    (wallets as any).finalizedHistoryBlock = initialBlock;

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

    const finalizedBlock = {
      blockNumber: 1,
      blockHash: '0x1',
      blockTime: 1,
      parentHash: '0x0',
      isFinalized: true,
      author: '5author',
      tick: 1,
    } satisfies IBlockHeaderInfo;
    await (
      wallets as unknown as { processFinalizedBlocks(headers: IBlockHeaderInfo[]): Promise<void> }
    ).processFinalizedBlocks([finalizedBlock]);

    expect(blockWatch.getEventsWithSpec).toHaveBeenCalledOnce();
    expect(blockWatch.getApi).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: '5default', amount: -10n, currency: 'argonot' }),
    );
    expect(upsert).toHaveBeenCalledWith(
      SyncStateKeys.Wallet,
      expect.objectContaining({ blockHash: finalizedBlock.blockHash }),
    );
    processEvents.mockRestore();
  });

  it('reports a recovery gap instead of replaying missing finalized blocks', async () => {
    const staleFinalized = blockHeader(100, 'stale-finalized');
    const finalized = blockHeader(10_000, 'finalized');
    const blockWatch = {
      finalizedBlockHeader: finalized,
      getApi: vi.fn().mockResolvedValue({
        query: {
          system: {
            account: {
              multi: async (addresses: string[]) => addresses.map(() => ({ data: { free: 0n, reserved: 0n } })),
            },
          },
          ownership: {
            account: {
              multi: async (addresses: string[]) => addresses.map(() => ({ free: 0n, reserved: 0n })),
            },
          },
        },
      }),
    } as any;
    const upsert = vi.fn();
    const fetchMainchainRatesAtBlock = vi.fn();
    const wallets = createWallets({ syncStateTable: { upsert } }, blockWatch, { fetchMainchainRatesAtBlock });
    (wallets as any).finalizedHistoryBlock = staleFinalized;
    const finalizedBlocks: IBlockHeaderInfo[] = [];
    const gaps: { afterBlock: number; toBlock: number }[] = [];
    wallets.events.on('sync:finalized', block => finalizedBlocks.push(block));
    wallets.events.on('history:gap', gap => gaps.push(gap));

    await (
      wallets as unknown as { processFinalizedBlocks(headers: IBlockHeaderInfo[]): Promise<void> }
    ).processFinalizedBlocks([finalized]);

    expect(finalizedBlocks).toEqual([finalized]);
    expect(gaps).toEqual([{ afterBlock: 100, toBlock: 10_000 }]);
    expect(upsert).toHaveBeenCalledWith(
      SyncStateKeys.Wallet,
      expect.objectContaining({ blockHash: finalized.blockHash }),
    );
    expect(fetchMainchainRatesAtBlock).not.toHaveBeenCalled();
  });
});

describe('WalletsForArgon ARGNOT holdings', () => {
  it('uses the recorded receipt price as the basis for faucet ARGNOT', async () => {
    const faucet = {
      ...transfer(1, '5default', 5n, false, undefined, 2_000_000n),
      transferType: 'faucet' as const,
    };
    const fetchArgonotCustody = vi.fn().mockResolvedValue([faucet]);
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
        nativeAmount: 5n,
        investedCost: 10n,
        currentValue: 15n,
      }),
    ]);
  });

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
        currentValue: 0n,
      }),
    ]);
  });

  it('keeps the remaining receipt basis when some ARGNOT has left the liquid balance', async () => {
    const fetchArgonotCustody = vi.fn().mockResolvedValue([transfer(1, '5default', 5n, false, undefined, 2_000_000n)]);
    const wallets = createWallets({ walletTransfersTable: { revision: 1, fetchArgonotCustody } });

    const positions = await new WalletFinancials(wallets).loadPositions({
      accounts: [account(wallets.defaultArgonWallet, 3n)],
      claimedHolds: { treasury: true, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 3_000_000n,
    });

    expect(positions).toEqual([
      expect.objectContaining({
        kind: 'wallet-holding',
        lifecycle: 'active',
        nativeAmount: 3n,
        investedCost: 6n,
        currentValue: 9n,
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
      ['unavailable', '5miner', 5n, undefined, 0n, undefined],
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

  it('removes vault-staked ARGNOT from ordinary wallet holdings', async () => {
    const fetchArgonotCustody = vi.fn().mockResolvedValue([transfer(1, '5default', 5n, false, undefined, 2_000_000n)]);
    const wallets = createWallets({ walletTransfersTable: { revision: 1, fetchArgonotCustody } });

    const positions = await new WalletFinancials(wallets).loadPositions({
      accounts: [account(wallets.defaultArgonWallet, 5n)],
      claimedHolds: { treasury: false, miningSlot: false, vaults: true },
      claimedMicronotsByAccount: new Map([['5default', 3n]]),
      liveArgonotRateMicrogons: 3_000_000n,
    });

    expect(positions).toEqual([
      expect.objectContaining({
        kind: 'wallet-holding',
        accountId: '5default',
        nativeAmount: 2n,
        currentValue: 6n,
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

function balanceApi(defaultAvailableMicrogons: bigint) {
  return {
    query: {
      system: {
        account: {
          multi: async (addresses: string[]) =>
            addresses.map((_, index) => ({
              data: {
                free: index === 0 ? defaultAvailableMicrogons : 0n,
                reserved: 0n,
              },
            })),
        },
      },
      ownership: {
        account: {
          multi: async (addresses: string[]) => addresses.map(() => ({ free: 0n, reserved: 0n })),
        },
      },
    },
  };
}
