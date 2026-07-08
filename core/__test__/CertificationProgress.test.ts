import { describe, expect, it, vi } from 'vitest';
import {
  countCompletedOperationalCertificationRequirements,
  countCompletedTreasuryCertificationRequirements,
  getCertificationProgressFromOperationalAccount,
  loadCertificationProgress,
} from '../src/CertificationProgress.ts';

describe('CertificationProgress', () => {
  it('uses current operational account fields to determine certification progress', () => {
    const progress = getCertificationProgressFromOperationalAccount(
      some({
        vaultCreated: boolCodec(true),
        isTreasuryCertified: boolCodec(true),
        isUpgradedToOperations: boolCodec(true),
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

  it('uses legacy operational account fields when they are present', () => {
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
    expect(progress.isTreasuryCertified).toBe(false);
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
          treasuryMinimumBitcoin: bigintCodec(10n),
          treasuryMinimumBonds: bigintCodec(8n),
          treasuryMinimumUniswapTransfer: bigintCodec(12n),
          operationalMinimumUniswapTransfer: bigintCodec(13n),
          operationalMinimumVaultSecuritization: bigintCodec(12n),
          miningSeatsForOperational: numberCodec(2),
        },
        vaults: {
          operationalMinimumVaultSecuritization: bigintCodec(12n),
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

function boolCodec(value: boolean) {
  return {
    toPrimitive: () => value,
  };
}

function bigintCodec(value: bigint) {
  return {
    toBigInt: () => value,
  };
}

function numberCodec(value: number) {
  return {
    toNumber: () => value,
  };
}
