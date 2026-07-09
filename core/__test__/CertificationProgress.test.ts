import { describe, expect, it, vi } from 'vitest';
import {
  countCompletedOperationalCertificationRequirements,
  countCompletedTreasuryCertificationRequirements,
  getCertificationProgressFromOperationalAccount,
  getCertificationThresholds,
  loadCertificationProgress,
} from '../src/CertificationProgress.ts';
import { bigintCodec, boolCodec, numberCodec } from './helpers/codecs.ts';

describe('CertificationProgress', () => {
  it('uses operational account thresholds and upstream access to determine certification progress', () => {
    const progress = getCertificationProgressFromOperationalAccount(
      some({
        vaultCreated: boolCodec(true),
        upstreamAccount: someOption('//UpstreamOperator'),
        isOperationallyCertified: boolCodec(true),
        miningSeatAccrual: numberCodec(1),
        miningSeatAppliedTotal: numberCodec(1),
        uniswapArgonTransfersInAmount: bigintCodec(14n),
        vaultBitcoinAccrual: bigintCodec(7n),
        vaultBitcoinAppliedTotal: bigintCodec(6n),
        accountBitcoinAmount: bigintCodec(12n),
        accountVaultBondAmount: bigintCodec(9n),
      }),
      {
        treasuryMinimumBitcoin: 10n,
        treasuryMinimumBonds: 8n,
        treasuryMinimumUniswapTransfer: 12n,
        operationalMinimumVaultSecuritization: 12n,
        operationalMinimumUniswapTransfer: 13n,
        miningSeatsForOperational: 2,
      },
    );

    expect(progress.hasOperationalAccount).toBe(true);
    expect(progress.isTreasuryCertified).toBe(true);
    expect(progress.hasTreasuryBitcoin).toBe(true);
    expect(progress.hasTreasuryBonds).toBe(true);
    expect(progress.hasTreasuryUniswapTransfer).toBe(true);
    expect(progress.isUpgradedToOperations).toBe(true);
    expect(progress.hasOperationalVault).toBe(true);
    expect(progress.hasOperationalMiningSeats).toBe(true);
    expect(progress.hasOperationalUniswapTransfer).toBe(true);
    expect(progress.isOperationallyCertified).toBe(true);
    expect(countCompletedTreasuryCertificationRequirements(progress)).toBe(3);
    expect(countCompletedOperationalCertificationRequirements(progress)).toBe(3);
  });

  it('uses the deployed v1.4.9 operational account fields when they are present', () => {
    const progress = getCertificationProgressFromOperationalAccount(
      some({
        vaultCreated: boolCodec(false),
        hasUniswapTransfer: boolCodec(true),
        isOperational: boolCodec(true),
        miningSeatAccrual: numberCodec(0),
        miningSeatAppliedTotal: numberCodec(1),
        accountBitcoinAmount: bigintCodec(0n),
        accountVaultBondAmount: bigintCodec(0n),
        bitcoinAccrual: bigintCodec(1n),
        bitcoinAppliedTotal: bigintCodec(0n),
        hasTreasuryPoolParticipation: boolCodec(true),
      }),
      {
        treasuryMinimumBitcoin: 10n,
        treasuryMinimumBonds: 8n,
        treasuryMinimumUniswapTransfer: 12n,
        operationalMinimumVaultSecuritization: 12n,
        operationalMinimumUniswapTransfer: 13n,
        miningSeatsForOperational: 2,
      },
    );

    expect(progress.hasOperationalAccount).toBe(true);
    expect(progress.isTreasuryCertified).toBe(true);
    expect(progress.hasTreasuryBitcoin).toBe(true);
    expect(progress.hasTreasuryBonds).toBe(true);
    expect(progress.hasTreasuryUniswapTransfer).toBe(true);
    expect(progress.isUpgradedToOperations).toBe(false);
    expect(progress.hasOperationalVault).toBe(false);
    expect(progress.hasOperationalMiningSeats).toBe(false);
    expect(progress.hasOperationalUniswapTransfer).toBe(true);
    expect(progress.isOperationallyCertified).toBe(true);
    expect(countCompletedTreasuryCertificationRequirements(progress)).toBe(3);
    expect(countCompletedOperationalCertificationRequirements(progress)).toBe(1);
  });

  it('falls back to the deployed boolean treasury requirements before the runtime upgrade', () => {
    const client = {
      consts: {
        operationalAccounts: {
          operationalMinimumVaultSecuritization: bigintCodec(12n),
          miningSeatsForOperational: numberCodec(2),
        },
        vaults: {
          operationalMinimumVaultSecuritization: bigintCodec(12n),
        },
      },
    };

    expect(getCertificationThresholds(client as any)).toEqual({
      treasuryMinimumBitcoin: 1n,
      treasuryMinimumBonds: 1n,
      treasuryMinimumUniswapTransfer: 1n,
      operationalMinimumUniswapTransfer: 1n,
      operationalMinimumVaultSecuritization: 12n,
      miningSeatsForOperational: 2,
    });
  });

  it('loads treasury progress from the default account before operational registration', async () => {
    const client = {
      query: {
        operationalAccounts: {
          operationalAccounts: vi.fn().mockResolvedValue(none()),
        },
        treasury: {
          bondLotIdsByAccount: {
            keys: vi.fn().mockResolvedValue([]),
          },
          bondLotById: {
            multi: vi.fn(),
          },
        },
        crosschainTransfer: {
          transferTotalsByAccount: vi.fn().mockResolvedValue({
            microgonsIn: bigintCodec(14n),
          }),
        },
        bitcoinLocks: {
          utxoIdsByOwnerAccount: {
            keys: vi.fn().mockResolvedValue([]),
          },
        },
      },
      consts: {
        operationalAccounts: {
          minimumBitcoin: bigintCodec(10n),
          minimumBonds: bigintCodec(8n),
          minimumUniswapTransfer: bigintCodec(12n),
          operationalMinimumUniswapTransfer: bigintCodec(13n),
          operationalMinimumVaultSecuritization: bigintCodec(12n),
          miningSeatsForOperational: numberCodec(2),
        },
      },
    };

    const progress = await loadCertificationProgress({
      client: client as any,
      defaultAccountId: '5Default',
    });

    expect(progress.hasOperationalAccount).toBe(false);
    expect(progress.isTreasuryCertified).toBe(false);
    expect(progress.hasTreasuryBitcoin).toBe(false);
    expect(progress.hasTreasuryBonds).toBe(false);
    expect(progress.hasTreasuryUniswapTransfer).toBe(true);
    expect(progress.isUpgradedToOperations).toBe(false);
    expect(progress.isOperationallyCertified).toBe(false);
    expect(client.query.crosschainTransfer.transferTotalsByAccount).toHaveBeenCalledWith('5Default');
  });
});

function some<T>(value: T): any {
  return {
    isSome: true,
    unwrap: () => value,
  };
}

function none(): any {
  return {
    isSome: false,
  };
}

function someOption(value: unknown): any {
  return {
    isSome: true,
    unwrap: () => value,
  };
}
