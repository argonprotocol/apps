import { ServerApiClient } from '../lib/ServerApiClient.ts';
import { ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { getConfig } from './config.ts';
import { getWalletKeys } from './wallets.ts';

let serverApiClient: ServerApiClient | undefined;
let serverAuthClient: ServerAuthClient | undefined;
let upstreamOperatorAuthClient: ServerAuthClient | undefined;

export function getServerApiClient(): ServerApiClient {
  serverApiClient ??= new ServerApiClient(() => getConfig().serverDetails, getServerAuthClient());
  return serverApiClient;
}

export function getServerAuthClient(): ServerAuthClient {
  serverAuthClient ??= new ServerAuthClient(getWalletKeys);
  return serverAuthClient;
}

export function getUpstreamOperatorAuthClient(): ServerAuthClient {
  upstreamOperatorAuthClient ??= new ServerAuthClient(getWalletKeys, {
    getRestorePackage: () => {
      const config = getConfig();
      if (!config.isLoaded) return;

      return config.upstreamOperator?.restorePackage;
    },
    applyRestoreResult: async restore => {
      const config = getConfig();
      const vaultId = restore.bitcoinLockCoupons[0]?.coupon.vaultId;

      config.upstreamOperator = {
        ...config.upstreamOperator,
        name: restore.fromName,
        accountId: restore.operatorAccountId,
        ...(vaultId !== undefined ? { vaultId } : {}),
        restorePackage: restore.restorePackage,
      };
      config.hasExtensionTreasury = true;
      await config.save();

      const { getBitcoinLockCoupons } = await import('./bitcoin.ts');
      getBitcoinLockCoupons().applyRestore(restore.bitcoinLockCoupons);
    },
  });
  return upstreamOperatorAuthClient;
}
