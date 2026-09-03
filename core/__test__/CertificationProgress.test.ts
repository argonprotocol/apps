import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countCompletedOperationalCertificationRequirements,
  countCompletedTreasuryCertificationRequirements,
  getCertificationProgressFromOperationalAccount,
  getCertificationThresholds,
  loadCertificationProgress,
} from '../src/CertificationProgress.ts';
import { bigintCodec, numberCodec } from './helpers/codecs.ts';

describe('CertificationProgress', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses operational account thresholds and upstream access to determine certification progress', () => {
    const progress = getCertificationProgressFromOperationalAccount(
      {
        vaultAccount: '//VaultOperator',
        vaultCreated: true,
        upstreamAccount: '//UpstreamOperator',
        isOperationallyCertified: true,
        miningSeatAccrual: 1,
        miningSeatAppliedTotal: 1,
        uniswapArgonTransfersInAmount: 14n,
        vaultBitcoinAccrual: 7n,
        vaultBitcoinAppliedTotal: 6n,
        accountBitcoinAmount: 12n,
        accountVaultBondAmount: 9n,
        rewardsEarnedCount: 0,
        rewardsEarnedAmount: 0n,
        rewardsCollectedAmount: 0n,
      },
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
    expect(progress.treasuryBitcoinAmount).toBe(12n);
    expect(progress.treasuryBondAmount).toBe(9n);
    expect(progress.isUpgradedToOperations).toBe(true);
    expect(progress.hasOperationalVault).toBe(true);
    expect(progress.hasOperationalMiningSeats).toBe(true);
    expect(progress.hasOperationalUniswapTransfer).toBe(true);
    expect(progress.isOperationallyCertified).toBe(true);
    expect(countCompletedTreasuryCertificationRequirements(progress)).toBe(3);
    expect(countCompletedOperationalCertificationRequirements(progress)).toBe(3);
  });

  it('loads certification thresholds from the supported operational account constants', () => {
    const client = {
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

    expect(getCertificationThresholds(client as any)).toEqual({
      treasuryMinimumBitcoin: 10n,
      treasuryMinimumBonds: 8n,
      treasuryMinimumUniswapTransfer: 12n,
      operationalMinimumUniswapTransfer: 13n,
      operationalMinimumVaultSecuritization: 12n,
      miningSeatsForOperational: 2,
    });
  });

  it('loads treasury progress from the default account before operational registration', async () => {
    const client = {
      query: {
        operationalAccounts: {
          operationalAccounts: vi.fn().mockResolvedValue(null),
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
            microgonsIn: 14n,
          }),
        },
        bitcoinFissions: {
          fissionByOwnerAndId: {
            entries: vi.fn().mockResolvedValue([]),
          },
        },
        bitcoinLocks: {
          utxoIdsByOwnerAccount: {
            keys: vi.fn().mockResolvedValue([]),
          },
          locksByUtxoId: {
            multi: vi.fn().mockResolvedValue([]),
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
    expect(progress.treasuryBitcoinAmount).toBe(0n);
    expect(progress.treasuryBondAmount).toBe(0n);
    expect(progress.isUpgradedToOperations).toBe(false);
    expect(progress.isOperationallyCertified).toBe(false);
    expect(client.query.crosschainTransfer.transferTotalsByAccount).toHaveBeenCalledWith('5Default');
  });
});
