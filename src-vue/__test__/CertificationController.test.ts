import { afterEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, shallowRef, type ShallowRef } from 'vue';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { Vault } from '@argonprotocol/apps-core';
import { OperationalStepId, useCertificationController } from '../stores/certificationController.ts';
import { VaultingSetupStatus } from '../interfaces/IConfig.ts';

let currentVault: ShallowRef<Vault | null>;
const config = {
  isLoadedPromise: new Promise<void>(() => {}),
  certificationDetails: { hasSavedMnemonic: true },
  vaultingSetupStatus: VaultingSetupStatus.Finished,
};
vi.mock('../stores/config.ts', async importOriginal => ({
  ...(await importOriginal()),
  getConfig: () => config,
}));
vi.mock('../stores/vaults.ts', async importOriginal => ({
  ...(await importOriginal()),
  getMyVault: () => ({
    get createdVault() {
      return currentVault.value;
    },
  }),
}));
vi.mock('../stores/helpers/dbPromise.ts', () => ({ getDbPromise: () => new Promise(() => {}) }));
vi.mock('../stores/bitcoin.ts', async importOriginal => ({
  ...(await importOriginal()),
  getBitcoinLocks: () => ({}),
  getBitcoinFissions: () => ({}),
}));
vi.mock('../stores/argonBonds.ts', async importOriginal => ({
  ...(await importOriginal()),
  getArgonBonds: () => ({}),
}));
vi.mock('../stores/myMiningSeats.ts', async importOriginal => ({
  ...(await importOriginal()),
  getMyMiningSeats: () => ({}),
}));
vi.mock('../stores/transactions.ts', async importOriginal => ({
  ...(await importOriginal()),
  getTransactionTracker: () => ({}),
}));
vi.mock('../stores/wallets.ts', async importOriginal => ({
  ...(await importOriginal()),
  getWalletKeys: () => ({}),
  useWallets: () => ({}),
}));
vi.mock('../overlays/certification/BootstrapToNode.vue', () => ({ default: {} }));
vi.mock('../overlays/certification/BackupMnemonic.vue', () => ({ default: {} }));
vi.mock('../overlays/certification/ActivateVault.vue', () => ({ default: {} }));
vi.mock('../overlays/certification/LiquidLock.vue', () => ({ default: {} }));
vi.mock('../overlays/certification/AcquireBonds.vue', () => ({ default: {} }));
vi.mock('../overlays/certification/TransferArgons.vue', () => ({ default: {} }));
vi.mock('../overlays/certification/WinMiningSeats.vue', () => ({ default: {} }));
vi.mock('../overlays/certification/WinMoreMiningSeats.vue', () => ({ default: {} }));

afterEach(() => {
  useCertificationController().$dispose();
});

it('rechecks vault certification when the minimum and current funding change', async () => {
  setActivePinia(createPinia());
  currentVault = shallowRef(null);

  const controller = useCertificationController();
  controller.rewardConfig.operationalMinimumVaultSecuritization = 2_000_000_000n;
  controller.rewardConfig.operationalVaultTolerance = 0n;
  controller.chainProgress = {
    ...controller.chainProgress,
    hasOperationalAccount: true,
    hasVault: true,
    hasUniswapTransfer: true,
    hasTreasuryUniswapTransfer: true,
    hasTreasuryBondParticipation: true,
    hasFirstMiningSeat: true,
    hasSecondMiningSeat: true,
    hasBitcoinLock: true,
    isUpgradedToOperations: true,
  };

  const registry = getOfflineRegistry();
  let vaultSecuritization = 2_000_000_000n;
  const client = runtimeClient({
    consts: { vaults: {} },
    query: {
      vaults: {
        vaultsById: async () =>
          registry.createType('Option<ArgonPrimitivesVault>', { securitization: vaultSecuritization }),
      },
    },
  });
  currentVault.value = Vault.fromRuntime(7, (await client.query.vaults.vaultsById(7))!, 60_000, client.consts);
  expect(controller.isCertificationStepComplete(OperationalStepId.ActivateVault)).toBe(true);
  expect(controller.isOperationalActivationReady).toBe(true);

  controller.rewardConfig.operationalMinimumVaultSecuritization = 2_500_000_000n;
  await nextTick();
  expect(controller.isCertificationStepComplete(OperationalStepId.ActivateVault)).toBe(false);
  expect(controller.isOperationalActivationReady).toBe(false);
  expect(controller.chainProgress.hasVault).toBe(true);
  expect(controller.getCertificationStepStatus(OperationalStepId.ActivateVault)).toBe('not_started');

  vaultSecuritization = 2_500_000_000n;
  currentVault.value = Vault.fromRuntime(7, (await client.query.vaults.vaultsById(7))!, 60_000, client.consts);
  await nextTick();
  expect(controller.isCertificationStepComplete(OperationalStepId.ActivateVault)).toBe(true);
  expect(controller.isOperationalActivationReady).toBe(true);

  currentVault.value = null;
  await nextTick();
  expect(controller.isCertificationStepComplete(OperationalStepId.ActivateVault)).toBe(false);
  expect(controller.isOperationalActivationReady).toBe(false);

  controller.chainProgress = { ...controller.chainProgress, isOperational: true };
  await nextTick();
  expect(controller.isCertificationStepComplete(OperationalStepId.ActivateVault)).toBe(true);
  expect(controller.isOperationalActivationReady).toBe(false);
});
