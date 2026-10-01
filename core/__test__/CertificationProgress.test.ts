import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countCompletedOperationalCertificationRequirements,
  countCompletedTreasuryCertificationRequirements,
  getCertificationProgressFromOperationalAccount,
  loadCertificationProgress,
} from '../src/CertificationProgress.ts';
import { bigintCodec, numberCodec } from './helpers/codecs.ts';

describe('CertificationProgress', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the registered vault securitization rather than bitcoin accrual for operational certification', async () => {
    const account = {
      vaultAccount: '//VaultOperator',
      vaultCreated: true,
      upstreamAccount: '//UpstreamOperator',
      isOperationallyCertified: true,
      miningSeatAccrual: 1,
      miningSeatAppliedTotal: 1,
      uniswapArgonTransfersInAmount: 3_000_000_000n,
      vaultBitcoinAccrual: 1_999_995_635n,
      vaultBitcoinAppliedTotal: 0n,
      accountBitcoinAmount: 499_999_000n,
      accountVaultBondAmount: 200_000_000n,
      rewardsEarnedCount: 0,
      rewardsEarnedAmount: 0n,
      rewardsCollectedAmount: 0n,
    };
    const thresholds = {
      treasuryMinimumBitcoin: 500_000_000n,
      treasuryMinimumBonds: 200_000_000n,
      treasuryMinimumUniswapTransfer: 250_000_000n,
      operationalMinimumVaultSecuritization: 2_000_000_000n,
      operationalMinimumUniswapTransfer: 3_000_000_000n,
      miningSeatsForOperational: 2,
    };
    const client = {
      consts: {
        operationalAccounts: {
          minimumBitcoin: bigintCodec(thresholds.treasuryMinimumBitcoin),
          minimumBonds: bigintCodec(thresholds.treasuryMinimumBonds),
          minimumUniswapTransfer: bigintCodec(thresholds.treasuryMinimumUniswapTransfer),
          operationalMinimumUniswapTransfer: bigintCodec(thresholds.operationalMinimumUniswapTransfer),
          operationalMinimumVaultSecuritization: bigintCodec(thresholds.operationalMinimumVaultSecuritization),
          miningSeatsForOperational: numberCodec(thresholds.miningSeatsForOperational),
        },
      },
      query: {
        operationalAccounts: { operationalAccounts: async () => account },
        vaults: {
          vaultIdByOperator: async () => 42,
          vaultsById: async () => ({ securitization: 2_000_000_000n }),
        },
      },
    };
    const progress = await loadCertificationProgress({
      client: client as any,
      defaultAccountId: '//VaultOperator',
      operationalAccountId: '//Operational',
    });

    expect(progress.hasOperationalAccount).toBe(true);
    expect(progress.isTreasuryCertified).toBe(true);
    expect(progress.hasTreasuryBitcoin).toBe(true);
    expect(progress.hasTreasuryBonds).toBe(true);
    expect(progress.hasTreasuryUniswapTransfer).toBe(true);
    expect(progress.uniswapArgonTransfersInAmount).toBe(3_000_000_000n);
    expect(progress.treasuryBitcoinAmount).toBe(499_999_000n);
    expect(progress.treasuryBondAmount).toBe(200_000_000n);
    expect(progress.isUpgradedToOperations).toBe(true);
    expect(progress.hasOperationalVault).toBe(true);
    expect(progress.operationalVaultSecuritization).toBe(2_000_000_000n);
    expect(progress.hasOperationalMiningSeats).toBe(true);
    expect(progress.operationalMiningSeatCount).toBe(2);
    expect(progress.hasOperationalUniswapTransfer).toBe(true);
    expect(progress.isOperationallyCertified).toBe(true);
    expect(countCompletedTreasuryCertificationRequirements(progress)).toBe(3);
    expect(countCompletedOperationalCertificationRequirements(progress)).toBe(3);

    expect(
      getCertificationProgressFromOperationalAccount(account, thresholds, 1_999_000_000n).hasOperationalVault,
    ).toBe(true);
    expect(
      getCertificationProgressFromOperationalAccount(account, thresholds, 1_998_999_999n).hasOperationalVault,
    ).toBe(false);
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
            microgonsIn: 300_000_000n,
          }),
        },
        bitcoinFissions: {
          fissionByOwnerAndId: {
            entries: vi.fn().mockResolvedValue([
              [
                { args: ['5Default', 1] },
                {
                  liquidId: 1,
                  lockId: 1,
                  satoshis: 10_000_000n,
                  microgonsAtTargetPerBtc: 5_000_000_000n,
                  liquidityPromised: 499_999_000n,
                  ratchetNumber: 0,
                },
              ],
            ]),
          },
        },
      },
      consts: {
        operationalAccounts: {
          minimumBitcoin: bigintCodec(500_000_000n),
          minimumBonds: bigintCodec(200_000_000n),
          minimumUniswapTransfer: bigintCodec(250_000_000n),
          operationalMinimumUniswapTransfer: bigintCodec(3_000_000_000n),
          operationalMinimumVaultSecuritization: bigintCodec(2_000_000_000n),
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
    expect(progress.hasTreasuryBitcoin).toBe(true);
    expect(progress.hasTreasuryBonds).toBe(false);
    expect(progress.hasTreasuryUniswapTransfer).toBe(true);
    expect(progress.uniswapArgonTransfersInAmount).toBe(300_000_000n);
    expect(progress.treasuryBitcoinAmount).toBe(499_999_000n);
    expect(progress.treasuryBondAmount).toBe(0n);
    expect(progress.isUpgradedToOperations).toBe(false);
    expect(progress.isOperationallyCertified).toBe(false);
    expect(client.query.crosschainTransfer.transferTotalsByAccount).toHaveBeenCalledWith('5Default');
  });
});
