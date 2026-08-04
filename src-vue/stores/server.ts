import { ServerApiClient } from '../lib/ServerApiClient.ts';
import { ServerAuthClient } from '../lib/ServerAuthClient.ts';
import {
  decryptBootstrapRecovery,
  encryptBootstrapRecovery,
  getBootstrapEndpointPubkey,
} from '@argonprotocol/apps-core';
import { hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import { enrollUpstreamRecovery } from './bootstrapRecovery.ts';
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

      const restorePackage = config.upstreamOperator?.restorePackage;
      if (!restorePackage) return;

      return {
        restorePackage,
        restorePackageRevision: config.upstreamOperator?.restorePackageRevision ?? '1.0',
      };
    },
    getBootstrapEndpointPubkey: async () => {
      const encryptedBootstrapRecovery = getConfig().upstreamOperator?.encryptedBootstrapRecovery;
      if (!encryptedBootstrapRecovery) return;

      const recoverySeed = await getWalletKeys().getUpstreamEndpointRecoverySeed();
      const recovery = await decryptBootstrapRecovery(hexToU8a(encryptedBootstrapRecovery), recoverySeed);
      return u8aToHex(getBootstrapEndpointPubkey(recovery.endpointSecret));
    },
    applyBootstrapEndpointSecret: async bootstrapEndpointSecret => {
      const config = getConfig();
      if (!config.upstreamOperator) return;

      const recoverySeed = await getWalletKeys().getUpstreamEndpointRecoverySeed();
      const encryptedBootstrapRecovery = await encryptBootstrapRecovery(
        {
          version: 1,
          endpointSecret: bootstrapEndpointSecret,
        },
        recoverySeed,
      );
      config.upstreamOperator = {
        ...config.upstreamOperator,
        encryptedBootstrapRecovery: u8aToHex(encryptedBootstrapRecovery),
      };
      await config.save();
      void enrollUpstreamRecovery().catch(error => {
        console.warn('Unable to enroll upstream endpoint recovery', error);
      });
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
        restorePackageRevision: restore.restorePackageRevision,
      };
      config.hasExtensionTreasury = true;
      if (restore.hasOperationsAccess) {
        config.hasExtensionOperations = true;
      }
      await config.save();

      const { getBitcoinLockCoupons } = await import('./bitcoin.ts');
      getBitcoinLockCoupons().applyRestore(restore.bitcoinLockCoupons);
    },
  });
  return upstreamOperatorAuthClient;
}
