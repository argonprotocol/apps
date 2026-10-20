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
const registry = new TypeRegistry();
const metadata = new Metadata(registry, Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-160'))![1]);
registry.setMetadata(metadata);
const consts = decorateConstants(registry, metadata.asLatest, metadata.version);

describe('CertificationProgress', () => {
  it('loads linked wallet certification and actual vault securitization', async () => {
    const vaultSecuritization = runtimeClient({ query: {}, consts }).consts.operationalAccounts
      .operationalMinimumVaultSecuritization;
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
      accountBitcoinAmount: 9_000_000_000n,
      accountVaultBondAmount: 9_000_000_000n,
    });
    let position = registry.createType('Option<PalletTreasuryPositionsPosition>', {
      bondPrincipal: 2_500_000_000n,
      quantities: { bonds: 9_000, fissionLiquidity: 2_475_000_000n },
      upstream: { vaultId: 4, bitcoinSecuritization: 9_000_000_000n, bondPrincipal: 9_000_000_000n },
    });
    const positionsByAccount = vi.fn(async () => position);
    const raw = {
      consts,
      query: {
        operationalAccounts: { operationalAccounts: async () => account },
        treasuryPositions: { positionsByAccount },
        vaults: {
          vaultIdByOperator: async () => registry.createType('Option<u32>', 42),
          vaultsById: async () =>
            registry.createType('Option<ArgonPrimitivesVault>', { securitization: vaultSecuritization }),
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
    expect(progress.treasuryBitcoinAmount).toBe(2_475_000_000n);
    expect(progress.treasuryBondAmount).toBe(2_500_000_000n);
    expect(progress.hasOperationalVault).toBe(true);
    expect(progress.operationalVaultSecuritization).toBe(vaultSecuritization);
    expect(progress.operationalMiningSeatCount).toBe(2);
    expect(countCompletedTreasuryCertificationRequirements(progress)).toBe(3);
    expect(countCompletedOperationalCertificationRequirements(progress)).toBe(3);

    const thresholds = getCertificationThresholds(client);
    expect(thresholds.treasuryMinimumBitcoin).toBe(2_500_000_000n);
    expect(thresholds.treasuryMinimumBonds).toBe(2_500_000_000n);
    expect(thresholds.operationalMinimumVaultSecuritization).toBe(2_500_000_000n);
    const belowVaultMinimum = getCertificationProgressFromOperationalAccount(
      await client.query.operationalAccounts.operationalAccounts(operationalAccount),
      thresholds,
      vaultSecuritization - 1n,
    );
    expect(belowVaultMinimum.hasOperationalVault).toBe(false);

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
  });

  it('loads treasury progress before registration', async () => {
    const raw = {
      consts,
      query: {
        treasuryPositions: {
          positionsByAccount: async () =>
            registry.createType('Option<PalletTreasuryPositionsPosition>', {
              bondPrincipal: 2_500_000_000n,
              quantities: { fissionLiquidity: 2_475_000_000n },
            }),
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
    expect(progress.hasTreasuryBonds).toBe(true);
    expect(progress.treasuryBitcoinAmount).toBe(2_475_000_000n);
    expect(progress.treasuryBondAmount).toBe(2_500_000_000n);
    expect(progress.isOperationallyCertified).toBe(false);
  });
});
