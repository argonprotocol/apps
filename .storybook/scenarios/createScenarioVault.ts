import { Vault } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';

export function createScenarioVault(overrides: Partial<Vault> = {}): Vault {
  return Object.assign(Object.create(Vault.prototype) as Vault, {
    tickDuration: 60_000,
    securitization: 2_000_000_000n,
    securitizationLocked: 0n,
    securitizationPendingActivation: 0n,
    securitizationReleaseSchedule: new Map<number, bigint>(),
    terms: {
      bitcoinAnnualPercentRate: BigNumber(0.08),
      bitcoinBaseFee: 0n,
      treasuryProfitSharing: BigNumber(0.2),
    },
    operatorAccountId: '5SyntheticVaultOperator',
    isClosed: false,
    vaultId: 7,
    openedDate: new Date('2026-08-01T16:00:00.000Z'),
    openedTick: 9_000,
    securitizationRatio: 1,
    lockedSatoshis: 0,
    securitizedSatoshis: 0,
    flexibleSecuritizationLocked: 0n,
    reservedSecuritizationSpace: 0n,
    flexibleSecuritizedSatoshis: 0,
    ...overrides,
  });
}
