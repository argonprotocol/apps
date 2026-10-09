import { describe, expect, it, vi } from 'vitest';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { decorateConstants } from '@polkadot/types/metadata/decorate';
import { getBundledMetadata, runtimeClient } from '@argonprotocol/runtime-client';
import type { ArgonClient } from '../src/MainchainClients.ts';
import {
  countCompletedOperationalCertificationRequirements,
  countCompletedTreasuryCertificationRequirements,
  getCertificationProgressFromOperationalAccount,
  getCertificationThresholds,
  loadCertificationProgress,
} from '../src/CertificationProgress.ts';

const vaultAccount = new Uint8Array(32).fill(0x11);
const operationalAccount = new Uint8Array(32).fill(0x22);
const registries = new Map(
  [159, 160].map(spec => {
    const registry = new TypeRegistry();
    const metadata = new Metadata(
      registry,
      Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${spec}`))![1],
    );
    registry.setMetadata(metadata);
    return [spec, { registry, consts: decorateConstants(registry, metadata.asLatest, metadata.version) }] as const;
  }),
);

describe('CertificationProgress', () => {
  it.each([159, 160])('loads linked wallet certification and actual vault securitization on runtime %s', async spec => {
    const { registry, consts } = registries.get(spec)!;
    const account = registry.createType('Option<PalletOperationalAccountsOperationalAccount>', {
      vaultAccount,
      miningAccount: vaultAccount,
      encryptionPubkey: vaultAccount,
      vaultCreated: true,
      isOperationallyCertified: true,
      miningSeatAccrual: 1,
      miningSeatAppliedTotal: 1,
      uniswapArgonTransfersInAmount: 3_000_000_000n,
      vaultBitcoinAccrual: 1_999_995_635n,
      accountBitcoinAmount: spec === 159 ? 499_999_000n : 9_000_000_000n,
      accountVaultBondAmount: spec === 159 ? 200_000_000n : 9_000_000_000n,
    });
    let position = registries.get(160)!.registry.createType('Option<PalletTreasuryPositionsPosition>', null);
    if (spec === 160) {
      position = registry.createType('Option<PalletTreasuryPositionsPosition>', {
        bondPrincipal: 2_500_000_000n,
        quantities: { bonds: 9_000, fissionLiquidity: 2_475_000_000n },
        upstream: { vaultId: 4, bitcoinSecuritization: 9_000_000_000n, bondPrincipal: 9_000_000_000n },
      });
    }
    const positionsByAccount = vi.fn(async () => position);
    const raw = {
      consts,
      query: {
        operationalAccounts: { operationalAccounts: async () => account },
        treasuryPositions: spec === 160 ? { positionsByAccount } : {},
        vaults: {
          vaultIdByOperator: async () => registry.createType('Option<u32>', 42),
          vaultsById: async () =>
            registry.createType('Option<ArgonPrimitivesVault>', { securitization: 2_000_000_000n }),
        },
      },
    };
    const client = runtimeClient(raw) as unknown as ArgonClient;
    const progress = await loadCertificationProgress({
      client,
      defaultAccountId: registry.createType('AccountId32', operationalAccount).toString(),
      operationalAccountId: registry.createType('AccountId32', operationalAccount).toString(),
    });

    expect(progress.isTreasuryCertified).toBe(true);
    expect(progress.treasuryBitcoinAmount).toBe(spec === 159 ? 499_999_000n : 2_475_000_000n);
    expect(progress.treasuryBondAmount).toBe(spec === 159 ? 200_000_000n : 2_500_000_000n);
    expect(progress.hasOperationalVault).toBe(true);
    expect(progress.operationalVaultSecuritization).toBe(2_000_000_000n);
    expect(progress.operationalMiningSeatCount).toBe(2);
    expect(countCompletedTreasuryCertificationRequirements(progress)).toBe(3);
    expect(countCompletedOperationalCertificationRequirements(progress)).toBe(3);

    const thresholds = getCertificationThresholds(client);
    expect(thresholds.treasuryMinimumBitcoin).toBe(spec === 159 ? 500_000_000n : 2_500_000_000n);
    expect(thresholds.treasuryMinimumBonds).toBe(spec === 159 ? 200_000_000n : 2_500_000_000n);
    const belowVaultMinimum = getCertificationProgressFromOperationalAccount(
      await client.query.operationalAccounts.operationalAccounts(operationalAccount),
      thresholds,
      1_999_999_999n,
    );
    expect(belowVaultMinimum.hasOperationalVault).toBe(spec === 159);

    if (spec === 160) {
      expect(positionsByAccount).toHaveBeenCalledWith(registry.createType('AccountId32', vaultAccount).toString());
      position = registry.createType('Option<PalletTreasuryPositionsPosition>', {
        bondPrincipal: 2_499_999_999n,
        quantities: { bonds: 9_000, fissionLiquidity: 2_474_999_999n },
      });
      const belowMinimum = await loadCertificationProgress({
        client,
        defaultAccountId: 'unused',
        operationalAccountId: 'operator',
      });
      expect(belowMinimum.hasTreasuryBitcoin).toBe(false);
      expect(belowMinimum.hasTreasuryBonds).toBe(false);
      expect(belowMinimum.isTreasuryCertified).toBe(false);
      position = registry.createType('Option<PalletTreasuryPositionsPosition>', null);
      const missingPosition = await loadCertificationProgress({
        client,
        defaultAccountId: 'unused',
        operationalAccountId: 'operator',
      });
      expect(missingPosition.treasuryBitcoinAmount).toBe(0n);
      expect(missingPosition.treasuryBondAmount).toBe(0n);
      expect(missingPosition.isTreasuryCertified).toBe(false);
    }
  });

  it.each([159, 160])('loads treasury progress before registration on runtime %s', async spec => {
    const { registry, consts } = registries.get(spec)!;
    const raw = {
      consts,
      query: {
        treasuryPositions:
          spec === 160
            ? {
                positionsByAccount: async () =>
                  registry.createType('Option<PalletTreasuryPositionsPosition>', {
                    bondPrincipal: 2_500_000_000n,
                    quantities: { fissionLiquidity: 2_475_000_000n },
                  }),
              }
            : {},
        treasury: { bondLotIdsByAccount: { keys: async () => [] } },
        bitcoinFissions: {
          fissionByOwnerAndId: {
            entries: async () => [
              [
                { args: [registry.createType('AccountId32', vaultAccount), registry.createType('u32', 1)] },
                registry.createType('Option<PalletBitcoinFissionsFission>', { liquidityPromised: 499_999_000n }),
              ],
            ],
          },
        },
        crosschainTransfer: {
          transferTotalsByAccount: async () =>
            registry.createType('PalletCrosschainTransferAccountTransferTotals', { microgonsIn: 300_000_000n }),
        },
      },
    };
    const progress = await loadCertificationProgress({
      client: runtimeClient(raw) as unknown as ArgonClient,
      defaultAccountId: registry.createType('AccountId32', vaultAccount).toString(),
    });
    expect(progress.hasOperationalAccount).toBe(false);
    expect(progress.hasTreasuryBitcoin).toBe(true);
    expect(progress.hasTreasuryBonds).toBe(spec === 160);
    expect(progress.treasuryBitcoinAmount).toBe(spec === 159 ? 499_999_000n : 2_475_000_000n);
    expect(progress.treasuryBondAmount).toBe(spec === 159 ? 0n : 2_500_000_000n);
    expect(progress.isOperationallyCertified).toBe(false);
  });
});
