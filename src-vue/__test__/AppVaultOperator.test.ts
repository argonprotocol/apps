import { Keyring } from '@argonprotocol/mainchain';
import { describe, expect, it, vi } from 'vitest';
import { AppVaultOperator } from '../../e2e/actors/AppVaultOperator.ts';

describe('AppVaultOperator', () => {
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
          minimumBonds: 10n,
          minimumUniswapTransfer: 10n,
          operationalMinimumUniswapTransfer: 10n,
          operationalMinimumVaultSecuritization: 10n,
          miningSeatsForOperational: 2,
        },
      },
      query: {
        treasuryPositions: {},
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
