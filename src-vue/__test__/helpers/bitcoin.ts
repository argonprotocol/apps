import type { IBitcoinLockConfig } from '@argonprotocol/mainchain';

export function createBitcoinLockConfig(overrides: Partial<IBitcoinLockConfig> = {}): IBitcoinLockConfig {
  const defaults = buildDefaultBitcoinLockConfig();
  return {
    ...defaults,
    ...overrides,
    bitcoinNetwork: overrides.bitcoinNetwork ?? defaults.bitcoinNetwork,
  };
}

export const DEFAULT_BITCOIN_LOCK_CONFIG = createBitcoinLockConfig();

function buildDefaultBitcoinLockConfig(): IBitcoinLockConfig {
  return {
    lockReleaseCosignDeadlineFrames: 1,
    pendingConfirmationExpirationBlocks: 6,
    tickDurationMillis: 1_000,
    bitcoinNetwork: buildDefaultBitcoinNetwork(),
    lockSatoshiAllowedVariance: 1_000,
  };
}

function buildDefaultBitcoinNetwork(): IBitcoinLockConfig['bitcoinNetwork'] {
  return {
    isBitcoin: true,
    isTestnet: false,
    isSignet: false,
    isRegtest: false,
    type: 'Bitcoin',
  } as IBitcoinLockConfig['bitcoinNetwork'];
}
