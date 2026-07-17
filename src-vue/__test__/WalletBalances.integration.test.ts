import { teardown } from '@argonprotocol/testing';
import {
  AccountActivityKind,
  createDeferred,
  Currency,
  MainchainClients,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { createTestDb } from './helpers/db.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import Path from 'path';
import { WalletsForArgon } from '../lib/WalletsForArgon.ts';
import { type IIndexedWalletActivityBlock, WalletHistoryRecovery } from '../lib/recovery/WalletHistory.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { Keyring, TxResult, TxSubmitter } from '@argonprotocol/mainchain';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { SyncStateKeys } from '../lib/db/SyncStateTable.ts';
import { WalletForArgon } from '../lib/WalletForArgon.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));
const REORG_DELETION_WAIT_MS = 10_000;
const custodyFlowActivityMask = AccountActivityKind.Transfer | AccountActivityKind.Crosschain;
const defaultWalletActivityMask = custodyFlowActivityMask | AccountActivityKind.AccountBalance;

async function addIndexedBlocks(
  blockWatch: BlockWatch,
  indexedBlocks: Map<number, IIndexedWalletActivityBlock>,
  blockNumbers: number[],
): Promise<void> {
  for (const blockNumber of blockNumbers) {
    const header = await blockWatch.getHeader(blockNumber);
    const api = await blockWatch.getApi(header);
    indexedBlocks.set(blockNumber, {
      blockNumber,
      blockHash: header.blockHash,
      specVersion: api.runtimeVersion.specVersion.toNumber(),
      activityMask: AccountActivityKind.Transfer,
    });
  }
}

describe
  .skipIf(skipE2E)
  .sequential('Wallet balances monitoring tests', { timeout: 120e3, shuffle: false, retry: 0 }, () => {
    let clients: MainchainClients;
    let mainchainUrl: string;
    let transferBlocks: number[] = [];
    const { walletKeys, operationalAccount } = createTestWallet('//Alice');

    beforeAll(async () => {
      const network = await startArgonTestNetwork(Path.basename(import.meta.filename), {
        profiles: ['miners'],
        chainStartTimeoutMs: 120_000,
        chainStartPollMs: 250,
      });

      mainchainUrl = network.archiveUrl;
      clients = new MainchainClients(mainchainUrl);
      setMainchainClients(clients);
      NetworkConfig.setNetwork('dev-docker');
    }, 120e3);

    afterAll(async () => {
      await clients.disconnect();
      await teardown();
    });

    it.sequential('should track balances', async () => {
      const client = await clients.get(false);
      const db = await createTestDb();
      const blockWatch = new BlockWatch(clients);
      const walletsForArgon = new WalletsForArgon({
        walletKeys,
        dbPromise: Promise.resolve(db),
        blockWatch,
        currency: new Currency(clients),
      });
      try {
        await walletsForArgon.load();
        const onBalanceChange = vi.fn();
        const onBlockDeleted = vi.fn();
        const didBlockGetDeleted = createDeferred<string>();
        walletsForArgon.events.on('block-deleted', block => {
          console.log('Block deleted:', block);
          didBlockGetDeleted.resolve(block.blockHash);
          onBlockDeleted(block);
        });
        const didGetBalanceChange = createDeferred();
        walletsForArgon.events.on('balance-change', (balanceChange, type) => {
          console.log('Balance Change:', balanceChange);
          onBalanceChange(type);
          didGetBalanceChange.resolve();
        });
        expect(walletsForArgon.operationalWallet.totalMicrogons).toBe(0n);
        expect(walletsForArgon.defaultArgonWallet.totalMicrogons).toBe(0n);

        const alice = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice');
        const result = await new TxSubmitter(
          client,
          client.tx.balances.transferKeepAlive(operationalAccount.address, 5_000_000n),
          alice,
        ).submit();
        await result.waitForInFirstBlock;
        await expect(didGetBalanceChange.promise).resolves.toBeUndefined();
        expect(walletsForArgon.operationalWallet.availableMicrogons).toBe(5_000_000n);
        expect(walletsForArgon.operationalWallet.finalizedBalance?.availableMicrogons ?? 0n).toBe(0n);
        expect(onBalanceChange).toHaveBeenCalledTimes(1 + onBlockDeleted.mock.calls.length);
        expect(onBalanceChange).toHaveBeenCalledWith('operational');
        expect(walletsForArgon.defaultArgonWallet.totalMicrogons).toBe(0n);
        await result.waitForFinalizedBlock;
        const finalizedBlock = result.blockNumber!;
        if (!walletsForArgon.finalizedBlock || walletsForArgon.finalizedBlock.blockNumber < finalizedBlock) {
          await new Promise(resolve => {
            const unsub = walletsForArgon.events.on('sync:finalized', h => {
              if (h.blockNumber >= finalizedBlock) {
                resolve(null);
                unsub();
              }
            });
          });
        }
        expect(walletsForArgon.operationalWallet.finalizedBalance?.availableMicrogons ?? 0n).toBe(5_000_000n);
        // send a bunch of transfers
        let nextNonce = (await client.rpc.system.accountNextIndex(alice.address)).toNumber();
        let finalizedTxs = 0;
        const waitForTxs = createDeferred();
        const txResults: TxResult[] = [];
        let txSubmissions = 0;
        let lastBlockNumber = 0;
        let lastTxBlockNumber = 0;
        const unsubscribe = await client.rpc.chain.subscribeNewHeads(async h => {
          const blockNumber = h.number.toNumber();
          if (blockNumber <= lastBlockNumber) return;
          lastBlockNumber = blockNumber;

          if (waitForTxs.isSettled) {
            return;
          }
          await Promise.all(txResults.map(txResult => txResult.waitForInFirstBlock));
          if (txSubmissions >= 10) {
            return;
          }
          txSubmissions++;
          const txResult = await new TxSubmitter(
            client,
            client.tx.balances.transferKeepAlive(operationalAccount.address, 1_000_000n),
            alice,
          ).submit({ nonce: nextNonce++ });
          txResults.push(txResult);
          await txResult.waitForFinalizedBlock;
          lastTxBlockNumber = Math.max(txResult.blockNumber!, lastTxBlockNumber);
          finalizedTxs++;

          if (finalizedTxs >= 10) {
            unsubscribe();
            waitForTxs.resolve();
          }
        });

        await waitForTxs.promise;

        const deletedBlockHash = await Promise.race([
          didBlockGetDeleted.promise,
          new Promise<string | null>(resolve => {
            setTimeout(() => resolve(null), REORG_DELETION_WAIT_MS);
          }),
        ]);

        if (!walletsForArgon.finalizedBlock || walletsForArgon.finalizedBlock.blockNumber < lastTxBlockNumber) {
          await new Promise(resolve => {
            const unsub = walletsForArgon.events.on('sync:finalized', h => {
              if (h.blockNumber >= lastTxBlockNumber) {
                resolve(null);
                unsub();
              }
            });
          });
        }
        if (deletedBlockHash) {
          expect(walletsForArgon.operationalWallet.balanceHistory.map(x => x.block.blockHash)).not.toContain(
            deletedBlockHash,
          );
        } else {
          console.log(
            '[WalletsForArgon] No block deletion observed before assertions; skipping reorg cleanup assertion',
          );
        }

        const transfers = await db.walletTransfersTable.fetchAll();
        transferBlocks = Array.from(new Set(transfers.map(entry => entry.blockNumber)));
        expect(transfers.length).toBeGreaterThan(0);
        expect(transfers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              walletAddress: walletKeys.operationalAddress,
              amount: 1_000_000n,
              currency: 'argon',
              transferType: 'transfer',
              isInternal: false,
            }),
          ]),
        );
      } finally {
        await walletsForArgon.close();
        blockWatch.stop();
        await db.close();
      }
    });

    it.sequential('should recover wallet balances on restart', async () => {
      const db = await createTestDb();
      const blockWatch = new BlockWatch(clients);
      const currency = new Currency(clients);
      const walletsForArgon = new WalletsForArgon({
        walletKeys,
        dbPromise: Promise.resolve(db),
        blockWatch,
        currency,
      });
      const legacyMiningHoldWallet = new WalletForArgon(
        walletKeys.legacyMiningHoldAddress,
        'miningBot',
        Promise.resolve(db),
      );
      const onRecovered = vi.fn();
      const walletHistoryRecovery = new WalletHistoryRecovery({
        dbPromise: Promise.resolve(db),
        blockWatch,
        currency,
        recoveryWallets: [
          walletsForArgon.defaultArgonWallet,
          legacyMiningHoldWallet,
          walletsForArgon.operationalWallet,
        ],
        ownedAddresses: [...walletsForArgon.addresses, walletKeys.legacyMiningHoldAddress],
        onRecovered,
      });
      const fetchMainchainRatesAtBlock = vi.spyOn(Currency.prototype, 'fetchMainchainRatesAtBlock');
      try {
        const spy = vi
          .spyOn(walletHistoryRecovery, 'findActivityBlocks')
          .mockImplementation(async (address, blocks) => {
            if (address === walletKeys.operationalAddress) await addIndexedBlocks(blockWatch, blocks, transferBlocks);
            return { asOfBlock: blockWatch.finalizedBlockHeader.blockNumber, definitionVersion: 1 };
          });
        await blockWatch.start();
        await walletHistoryRecovery.prepare();
        await walletHistoryRecovery.recoverNow(blockWatch.finalizedBlockHeader.blockNumber);

        expect(spy).toHaveBeenCalledTimes(3);
        await expect(db.syncStateTable.get(SyncStateKeys.WalletHistory)).resolves.toEqual({
          asOfBlock: blockWatch.finalizedBlockHeader.blockNumber,
          addresses: [...new Set([...walletsForArgon.addresses, walletKeys.legacyMiningHoldAddress])].sort(),
          activityMasks: {
            [walletKeys.defaultArgonAddress]: defaultWalletActivityMask,
            [walletKeys.legacyMiningHoldAddress]: custodyFlowActivityMask,
            [walletKeys.operationalAddress]: custodyFlowActivityMask,
          },
          definitionVersion: 1,
        });
        const transfers = await db.walletTransfersTable.fetchAll();
        expect(transfers.length).toBeGreaterThan(0);
        expect(onRecovered).toHaveBeenCalledOnce();
        expect(onRecovered).toHaveBeenCalledWith({
          transfers: db.walletTransfersTable.revision,
          argonotCustody: db.walletTransfersTable.argonotCustodyRevision,
          asOfBlock: blockWatch.finalizedBlockHeader.blockNumber,
        });
        expect(transfers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              walletAddress: walletKeys.operationalAddress,
              amount: 1_000_000n,
              currency: 'argon',
              transferType: 'transfer',
              isInternal: false,
            }),
          ]),
        );
        expect(fetchMainchainRatesAtBlock).toHaveBeenCalled();
      } finally {
        fetchMainchainRatesAtBlock.mockRestore();
        await walletHistoryRecovery.close();
        await walletsForArgon.close();
        blockWatch.stop();
        await db.close();
      }
    });

    it.sequential('should keep the current wallet balance visible while catching up history', async () => {
      const db = await createTestDb();
      const blockWatch = new BlockWatch(clients);
      const currency = new Currency(clients);
      const walletsForArgon = new WalletsForArgon({
        walletKeys,
        dbPromise: Promise.resolve(db),
        blockWatch,
        currency,
      });
      const legacyMiningHoldWallet = new WalletForArgon(
        walletKeys.legacyMiningHoldAddress,
        'miningBot',
        Promise.resolve(db),
      );
      const walletHistoryRecovery = new WalletHistoryRecovery({
        dbPromise: Promise.resolve(db),
        blockWatch,
        currency,
        recoveryWallets: [
          walletsForArgon.defaultArgonWallet,
          legacyMiningHoldWallet,
          walletsForArgon.operationalWallet,
        ],
        ownedAddresses: [...walletsForArgon.addresses, walletKeys.legacyMiningHoldAddress],
      });
      const resumeRecovery = createDeferred<void>();
      try {
        const spy = vi
          .spyOn(walletHistoryRecovery, 'findActivityBlocks')
          .mockImplementation(async (address, blocks) => {
            await resumeRecovery.promise;
            if (address === walletKeys.operationalAddress) await addIndexedBlocks(blockWatch, blocks, transferBlocks);
            return { asOfBlock: blockWatch.finalizedBlockHeader.blockNumber, definitionVersion: 1 };
          });
        const visibleOperationalBalances: bigint[] = [];
        walletsForArgon.events.on('balance-change', (balanceChange, type) => {
          if (type === 'operational') {
            visibleOperationalBalances.push(balanceChange.availableMicrogons);
          }
        });

        await walletsForArgon.load();
        await walletHistoryRecovery.prepare();
        void walletHistoryRecovery.recoverNow(blockWatch.finalizedBlockHeader.blockNumber);

        await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
        expect(visibleOperationalBalances).toEqual([15_000_000n]);
        expect(walletsForArgon.operationalWallet.totalMicrogons).toBe(15_000_000n);

        resumeRecovery.resolve();
        await vi.waitFor(async () => {
          const state = await db.syncStateTable.get(SyncStateKeys.WalletHistory);
          expect(state?.asOfBlock).toBe(blockWatch.finalizedBlockHeader.blockNumber);
        });
        const visibleHistory = walletsForArgon
          .getLoadEvents('balance-change')
          .filter(([, type]) => type === 'operational');
        expect(visibleHistory).toHaveLength(1);
      } finally {
        resumeRecovery.resolve();
        await walletHistoryRecovery.close();
        await walletsForArgon.close();
        blockWatch.stop();
        await db.close();
      }
    });

    it.sequential('keeps current balances ready and retries a failed wallet history range', async () => {
      const db = await createTestDb();
      const blockWatch = new BlockWatch(clients);
      const currency = new Currency(clients);
      const walletsForArgon = new WalletsForArgon({
        walletKeys,
        dbPromise: Promise.resolve(db),
        blockWatch,
        currency,
      });
      const legacyMiningHoldWallet = new WalletForArgon(
        walletKeys.legacyMiningHoldAddress,
        'miningBot',
        Promise.resolve(db),
      );
      const walletHistoryRecovery = new WalletHistoryRecovery({
        dbPromise: Promise.resolve(db),
        blockWatch,
        currency,
        recoveryWallets: [
          walletsForArgon.defaultArgonWallet,
          legacyMiningHoldWallet,
          walletsForArgon.operationalWallet,
        ],
        ownedAddresses: [...walletsForArgon.addresses, walletKeys.legacyMiningHoldAddress],
      });
      try {
        let shouldFail = true;
        const lookup = vi.spyOn(walletHistoryRecovery, 'findActivityBlocks').mockImplementation(async address => {
          if (shouldFail && address === walletKeys.operationalAddress) throw new Error('indexer unavailable');
          return { asOfBlock: blockWatch.finalizedBlockHeader.blockNumber, definitionVersion: 1 };
        });

        await walletsForArgon.load();
        await walletHistoryRecovery.prepare();
        const targetBlock = blockWatch.finalizedBlockHeader.blockNumber;
        await expect(walletHistoryRecovery.recoverNow(targetBlock)).rejects.toThrow('indexer unavailable');

        expect(walletsForArgon.operationalWallet.totalMicrogons).toBe(15_000_000n);
        expect(lookup.mock.calls.map(([, , blockRange]) => blockRange)).toEqual([
          [0, targetBlock],
          [0, targetBlock],
          [0, targetBlock],
        ]);
        await expect(db.syncStateTable.get(SyncStateKeys.WalletHistory)).resolves.toEqual({
          asOfBlock: 0,
          addresses: [...new Set([...walletsForArgon.addresses, walletKeys.legacyMiningHoldAddress])].sort(),
          activityMasks: {
            [walletKeys.defaultArgonAddress]: defaultWalletActivityMask,
            [walletKeys.legacyMiningHoldAddress]: custodyFlowActivityMask,
            [walletKeys.operationalAddress]: custodyFlowActivityMask,
          },
        });

        shouldFail = false;
        await walletHistoryRecovery.recoverNow(targetBlock, true);

        expect(lookup.mock.calls.slice(3).map(([, , blockRange]) => blockRange)).toEqual([
          [0, targetBlock],
          [0, targetBlock],
          [0, targetBlock],
        ]);
        await expect(db.syncStateTable.get(SyncStateKeys.WalletHistory)).resolves.toEqual({
          asOfBlock: targetBlock,
          addresses: [...new Set([...walletsForArgon.addresses, walletKeys.legacyMiningHoldAddress])].sort(),
          activityMasks: {
            [walletKeys.defaultArgonAddress]: defaultWalletActivityMask,
            [walletKeys.legacyMiningHoldAddress]: custodyFlowActivityMask,
            [walletKeys.operationalAddress]: custodyFlowActivityMask,
          },
          definitionVersion: 1,
        });
      } finally {
        await walletHistoryRecovery.close();
        await walletsForArgon.close();
        blockWatch.stop();
        await db.close();
      }
    });

    it.sequential('uses the lowest safe indexer checkpoint across owned accounts', async () => {
      const db = await createTestDb();
      const blockWatch = new BlockWatch(clients);
      const currency = new Currency(clients);
      const walletsForArgon = new WalletsForArgon({
        walletKeys,
        dbPromise: Promise.resolve(db),
        blockWatch,
        currency,
      });
      const legacyMiningHoldWallet = new WalletForArgon(
        walletKeys.legacyMiningHoldAddress,
        'miningBot',
        Promise.resolve(db),
      );
      const walletHistoryRecovery = new WalletHistoryRecovery({
        dbPromise: Promise.resolve(db),
        blockWatch,
        currency,
        recoveryWallets: [
          walletsForArgon.defaultArgonWallet,
          legacyMiningHoldWallet,
          walletsForArgon.operationalWallet,
        ],
        ownedAddresses: [...walletsForArgon.addresses, walletKeys.legacyMiningHoldAddress],
      });
      try {
        await blockWatch.start();
        const targetBlock = blockWatch.finalizedBlockHeader.blockNumber;
        const safeBlocks = new Map([
          [walletKeys.defaultArgonAddress, targetBlock],
          [walletKeys.operationalAddress, targetBlock - 1],
          [walletKeys.legacyMiningHoldAddress, targetBlock - 2],
        ]);
        const lookup = vi.spyOn(walletHistoryRecovery, 'findActivityBlocks').mockImplementation(async address => {
          return { asOfBlock: safeBlocks.get(address)!, definitionVersion: 1 };
        });

        await walletHistoryRecovery.prepare();
        await walletHistoryRecovery.recoverNow(targetBlock);

        expect(lookup).toHaveBeenCalledTimes(3);
        await expect(db.syncStateTable.get(SyncStateKeys.WalletHistory)).resolves.toEqual({
          asOfBlock: targetBlock - 2,
          addresses: [...new Set([...walletsForArgon.addresses, walletKeys.legacyMiningHoldAddress])].sort(),
          activityMasks: {
            [walletKeys.defaultArgonAddress]: defaultWalletActivityMask,
            [walletKeys.legacyMiningHoldAddress]: custodyFlowActivityMask,
            [walletKeys.operationalAddress]: custodyFlowActivityMask,
          },
          definitionVersion: 1,
        });
      } finally {
        await walletHistoryRecovery.close();
        await walletsForArgon.close();
        blockWatch.stop();
        await db.close();
      }
    });
  });
