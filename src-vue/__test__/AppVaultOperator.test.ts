import { Keyring } from '@argonprotocol/mainchain';
import { describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { AppVaultOperator } from '../../e2e/actors/AppVaultOperator.ts';
import { MainchainClients, NetworkConfig } from '@argonprotocol/apps-core';
import * as mainchainRpc from '@argonprotocol/apps-core/src/MainchainRpcProvider.ts';
import { EventEmitter } from 'node:events';
import * as testDb from './helpers/db.ts';
import { MemoryWalletKeys } from '../lib/MemoryWalletKeys.ts';
import type { Db } from '../lib/Db.ts';

describe('AppVaultOperator', () => {
  it('selects the local network and closes its database when initial RPC loading fails', async () => {
    const failure = new Error('Development RPC unavailable');
    const transport = Object.assign(new EventEmitter(), {
      query: {
        priceIndex: {
          current: async () => {
            throw failure;
          },
        },
      },
      disconnect: async () => {
        transport.removeAllListeners();
      },
    });
    const rpc = vi.spyOn(mainchainRpc, 'getMainchainClient').mockResolvedValue(transport as never);
    const databases = vi.spyOn(testDb, 'createTestDb');
    const clients = new MainchainClients('ws://synthetic-archive', () => false);
    const walletKeys = new MemoryWalletKeys({
      substrateSuri: '//Alice',
      masterMnemonic: 'test test test test test test test test test test test junk',
    });
    const esploraHost = 'http://127.0.0.1:32567';
    NetworkConfig.setNetwork('mainnet');

    try {
      await expect(
        AppVaultOperator.load({
          clients,
          walletKeys,
          networkConfigOverride: { esploraHost },
        }),
      ).rejects.toThrow('Development RPC unavailable');
      expect.soft(NetworkConfig.networkName).toBe('dev-docker');
      expect.soft(NetworkConfig.get().esploraHost).toBe(esploraHost);
      const db = (await databases.mock.results[0].value) as Db;
      await expect(db.walletsTable.count()).rejects.toThrow(/not open/);
    } finally {
      const db = (await databases.mock.results[0]?.value) as Db | undefined;
      await db?.close().catch(() => undefined);
      await clients.disconnect();
      rpc.mockRestore();
      databases.mockRestore();
      NetworkConfig.clearRuntimeOverride('dev-docker');
      NetworkConfig.setNetwork('dev-docker');
    }
  });

  it('keeps a sufficient Argonot commitment unchanged on worker restart', async () => {
    const setCommittedArgonots = vi.fn();
    const actor = Object.assign(Object.create(AppVaultOperator.prototype), {
      ensureVaultReady: vi.fn(),
      myVault: {
        data: {
          argonotCommitment: {
            heldMicronots: 12n,
            committedMicronots: 12n,
            encumberedMicronots: 10n,
          },
        },
        setCommittedArgonots,
      },
    }) as AppVaultOperator;

    await actor.ensureCommittedArgonots({ amount: 8n });

    expect(setCommittedArgonots).not.toHaveBeenCalled();
  });

  it('raises an insufficient commitment to at least its encumbered amount', async () => {
    const waitForPostProcessing = Promise.resolve();
    const setCommittedArgonots = vi.fn(async () => ({ waitForPostProcessing }));
    const actor = Object.assign(Object.create(AppVaultOperator.prototype), {
      ensureVaultReady: vi.fn(),
      myVault: {
        data: {
          argonotCommitment: {
            heldMicronots: 6n,
            committedMicronots: 6n,
            encumberedMicronots: 10n,
          },
        },
        setCommittedArgonots,
      },
    }) as AppVaultOperator;

    await actor.ensureCommittedArgonots({ amount: 8n });

    expect(setCommittedArgonots).toHaveBeenCalledWith(10n);
    await expect(waitForPostProcessing).resolves.toBeUndefined();
  });

  it('approves an Operations upgrade from live certification progress when the invite snapshot is stale', async () => {
    const keyring = new Keyring({ type: 'sr25519' });
    const operationalKeypair = keyring.addFromUri('//Alice');
    const downstreamDefaultAccountId = keyring.addFromUri('//Bob').address;
    const downstreamOperationalAccountId = keyring.addFromUri('//Charlie').address;
    let approvedInviteCode: string | undefined;
    const actor = Object.assign(Object.create(AppVaultOperator.prototype), {
      walletKeys: {
        getOperationalKeypair: async () => operationalKeypair,
      },
      requestRouterJson: async ({ path, init }: { path: string; init?: RequestInit }) => {
        if (path === '/invites') {
          return {
            invites: approvedInviteCode
              ? []
              : [
                  {
                    inviteCode: 'invite-1',
                    defaultAccountId: downstreamDefaultAccountId,
                    operationalAccountId: downstreamOperationalAccountId,
                    operationsUpgradeRequestedAt: new Date(),
                    certificationProgress: {
                      hasOperationalAccount: false,
                      isTreasuryCertified: false,
                      hasTreasuryBitcoin: false,
                      hasTreasuryBonds: false,
                      hasTreasuryUniswapTransfer: false,
                      isUpgradedToOperations: false,
                      hasOperationalVault: false,
                      hasOperationalMiningSeats: false,
                      hasOperationalUniswapTransfer: false,
                      isOperationallyCertified: false,
                    },
                  },
                ],
          };
        }

        if (path === '/invites/invite-1/mark-operations-upgraded' && init?.method === 'POST') {
          approvedInviteCode = 'invite-1';
          return { invite: {} };
        }
        throw new Error(`Unexpected router request: ${path}`);
      },
    }) as AppVaultOperator;
    const client = {
      consts: {
        operationalAccounts: {
          minimumBitcoin: 10n,
          bitcoinLiquidityTolerance: BigNumber(0),
          minimumBonds: 10n,
          minimumUniswapTransfer: 10n,
          operationalMinimumUniswapTransfer: 10n,
          operationalMinimumVaultSecuritization: 10n,
          miningSeatsForOperational: 2,
        },
      },
      query: {
        treasuryPositions: {
          positionsByAccount: async () => ({ quantities: { fissionLiquidity: 10n }, bondPrincipal: 10n }),
        },
        operationalAccounts: {
          operationalAccounts: async () => ({
            vaultAccount: downstreamOperationalAccountId,
            vaultCreated: false,
            vaultBitcoinAccrual: 0n,
            vaultBitcoinAppliedTotal: 0n,
            miningSeatAccrual: 0,
            miningSeatAppliedTotal: 0,
            uniswapArgonTransfersInAmount: 10n,
            accountBitcoinAmount: 10n,
            accountVaultBondAmount: 10n,
            isOperationallyCertified: false,
          }),
        },
        vaults: {
          vaultIdByOperator: async () => null,
        },
      },
    };
    const poller = actor.startOperationsUpgradePoller({
      client: client as never,
      routerHost: 'http://127.0.0.1:3000',
      pollMs: 1,
    });
    try {
      await vi.waitFor(() => expect(approvedInviteCode).toBe('invite-1'), { timeout: 250 });
    } finally {
      await poller.shutdown();
    }
  });
});
