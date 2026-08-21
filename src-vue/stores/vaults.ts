import { Vaults } from '../lib/Vaults';
import { getDbPromise } from './helpers/dbPromise';
import { MyVault } from '../lib/MyVault.ts';
import { reactive, watch } from 'vue';
import { getConfig, NETWORK_NAME } from './config.ts';
import { getMiningFrames } from './mainchain.ts';
import { getCurrency } from './currency.ts';
import { getTransactionTracker } from './transactions.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getWalletKeys } from './wallets.ts';
import { GlobalCouncil } from '../lib/GlobalCouncil.ts';
import { MintingAuthorities } from '../lib/MintingAuthorities.ts';
import { getServerApiClient } from './server.ts';
import { getUpstreamOperatorClient } from './upstreamOperator.ts';
import { CrosschainHistory } from '../lib/CrosschainHistory.ts';
import { createKnownCrosschainSourceIdentities, getCrosschainAccessState } from '../lib/CrosschainTransferView.ts';

export { type Vaults };

let vaults: Vaults;
let myVault: MyVault;
let crosschainHistory: CrosschainHistory;

export function getVaults(): Vaults {
  if (!vaults) {
    vaults = new Vaults(NETWORK_NAME, getCurrency(), getMiningFrames());
    vaults.operatorNamesByVaultId = reactive(vaults.operatorNamesByVaultId);

    const config = getConfig();
    watch(
      () => (config.isLoaded ? config.upstreamOperator?.vaultId : undefined),
      (vaultId, _, onCleanup) => {
        let isCurrent = true;
        let unsubscribe: VoidFunction | undefined;
        onCleanup(() => {
          isCurrent = false;
          unsubscribe?.();
        });
        if (!vaultId) return;

        void vaults
          .subscribeToOperatorName(vaultId, name => {
            if (!isCurrent) return;

            const upstreamOperator = config.upstreamOperator;
            if (!upstreamOperator || upstreamOperator.vaultId !== vaultId) return;

            const currentName = name ?? '';
            if (upstreamOperator.name === currentName) return;

            config.upstreamOperator = { ...upstreamOperator, name: currentName };
            void config.save();
          })
          .then(nextUnsubscribe => {
            unsubscribe = nextUnsubscribe;
            if (!isCurrent) unsubscribe();
          })
          .catch(error => console.warn(`[Vaults] Unable to subscribe to upstream vault ${vaultId}`, error));
      },
      { immediate: true },
    );
  }

  return vaults;
}

export function getMyVault(): MyVault {
  if (!myVault) {
    const config = getConfig();
    const dbPromise = getDbPromise();
    const vaults = getVaults();
    const transactionTracker = getTransactionTracker();
    const bitcoinLocks = getBitcoinLocks();
    const keys = getWalletKeys();
    const miningFrames = getMiningFrames();
    const globalCouncil = new GlobalCouncil(dbPromise, keys, miningFrames, () => config.ethereumExecutionRpcUrl);
    globalCouncil.data = reactive(globalCouncil.data) as any;

    const mintingAuthorities = new MintingAuthorities(dbPromise, keys, miningFrames, transactionTracker, async () => {
      await config.isLoadedPromise;
      return {
        serverApiClient: config.serverDetails.ipAddress ? getServerApiClient() : undefined,
        upstreamOperatorClient: getUpstreamOperatorClient(),
      };
    });
    mintingAuthorities.data = reactive(mintingAuthorities.data) as any;
    watch(
      () =>
        [
          config.isLoaded,
          mintingAuthorities.data.authorities.length,
          globalCouncil.data.isActiveCouncilMember,
        ] as const,
      ([isConfigLoaded, authorityCount, isActiveCouncilMember]) => {
        if (!isConfigLoaded) return;

        if (
          !getCrosschainAccessState({
            hasActivatedCrosschain: config.hasActivatedCrosschain,
            authorityCount,
            isActiveCouncilMember,
          }).hasAccess
        ) {
          return;
        }

        void config.isLoadedPromise
          .then(async () => {
            if (config.hasActivatedCrosschain) return;

            config.hasActivatedCrosschain = true;
            config.hasExtensionTreasury = true;
            config.hasExtensionOperations = true;
            await config.save();
          })
          .catch(error => console.error('[CrosschainTransfers] Unable to preserve navigation access', error));
      },
      { immediate: true },
    );

    myVault = new MyVault(
      dbPromise,
      vaults,
      keys,
      transactionTracker,
      bitcoinLocks,
      miningFrames,
      globalCouncil,
      mintingAuthorities,
    );
    myVault.data = reactive(myVault.data) as any;
  }

  return myVault;
}

export function getCrosschainHistory(): CrosschainHistory {
  if (!crosschainHistory) {
    const financialCache = getDbPromise().then(db => db.financialCacheTable);
    crosschainHistory = new CrosschainHistory(getWalletKeys(), getMiningFrames().blockWatch, financialCache);
    crosschainHistory.data = reactive(crosschainHistory.data) as typeof crosschainHistory.data;
  }

  return crosschainHistory;
}

export function getKnownCrosschainSourceIdentities() {
  const config = getConfig();
  const vault = getMyVault();
  const walletKeys = getWalletKeys();

  return createKnownCrosschainSourceIdentities({
    networkName: NETWORK_NAME,
    createdVault: vault.createdVault ?? undefined,
    vaultsById: vault.vaults.vaultsById,
    operatorNamesByVaultId: vault.vaults.operatorNamesByVaultId,
    localAccountIds: [walletKeys.defaultArgonAddress, walletKeys.vaultingAddress, walletKeys.operationalAddress],
    upstreamOperator: config.upstreamOperator,
    sourceUpstreamVaultAccountsByAccount: vault.mintingAuthorities.data.sourceUpstreamVaultAccountsByAccount,
  });
}
