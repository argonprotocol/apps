import * as Vue from 'vue';
import { defineStore } from 'pinia';
import {
  type IMiningSeat,
  type IMiningSeatMiner,
  type IMiningSlot,
  MICRONOTS_PER_ARGONOT,
  NetworkConfig,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import type { Vault } from '@argonprotocol/mainchain';
import { getMainchainClient, getMining, getMiningFrames } from './mainchain.ts';
import { getVaults } from './vaults.ts';
import { getCurrency } from './currency.ts';
import {
  getOperationalChainProgressFromAccount,
  getOperationalRewardConfig,
  type IOperationalChainProgress,
} from '../lib/OperationalAccount.ts';
import { MICROGONS_PER_ARGON } from '../lib/Currency.ts';

export type IActiveMiningSeat = IMiningSeat & {
  miner: NonNullable<IMiningSeat['miner']>;
};

export type IOperationalAccount = {
  address: string;
  progress: IOperationalChainProgress;
};

export type IActiveMiningNode = {
  valueLabel: 'blocks';
  value: number;
  miner: IMiningSeatMiner;
};

export type IActiveVaultNode = {
  valueLabel: 'satoshis';
  value: number;
  vault: Vault;
};

export type IActiveNode = IActiveMiningNode | IActiveVaultNode;

export const useNetworkStats = defineStore('networkStats', () => {
  let updatePromise: Promise<void> | undefined = undefined;
  const mining = getMining();
  const miningFrames = getMiningFrames();
  const vaults = getVaults();
  const currency = getCurrency();

  const miningSlots = Vue.ref<IMiningSlot[]>([]);
  const activeMiningSeats = Vue.ref<IActiveMiningSeat[]>([]);
  const activeVaults = Vue.shallowRef<Vault[]>([]);
  const operationalAccounts = Vue.ref<IOperationalAccount[]>([]);
  const activeOperationalAccounts = Vue.ref<IOperationalAccount[]>([]);
  const totalEconomicValue = Vue.ref(0n);

  const miningNodes = Vue.computed(() =>
    activeMiningSeats.value.map(
      ({ miner }) =>
        ({
          valueLabel: 'blocks',
          value: estimateBlocksCollected(miner.startingFrameId),
          miner,
        }) satisfies IActiveMiningNode,
    ),
  );

  const vaultNodes = Vue.computed(() =>
    activeVaults.value.map(
      vault =>
        ({
          valueLabel: 'satoshis',
          value: Number(vaults.vaultSatoshisById[vault.vaultId]?.lockedSatoshis ?? 0n),
          vault,
        }) satisfies IActiveVaultNode,
    ),
  );

  const activeNodes = Vue.computed<IActiveNode[]>(() => {
    return [...miningNodes.value, ...vaultNodes.value];
  });

  async function update() {
    if (updatePromise) return await updatePromise;

    updatePromise = (async () => {
      console.log('FETCHING MINING SLOTS!!!!!!:');
      const [slots, accounts, economicValue] = await Promise.all([
        mining.fetchCurrentMiningSeats(''),
        loadOperationalAccounts(),
        loadTotalEconomicValue(),
        miningFrames.load(),
        vaults.load(),
      ]);
      miningSlots.value = slots;
      activeMiningSeats.value = slots.flatMap(slot =>
        slot.seats.filter((seat): seat is IActiveMiningSeat => seat.miner !== null),
      );
      activeVaults.value = Object.values(vaults.vaultsById)
        .filter(vault => vault.availableSecuritization() > 0n)
        .sort((left, right) => {
          const leftAvailableBitcoinSpace = left.availableBitcoinSpace();
          const rightAvailableBitcoinSpace = right.availableBitcoinSpace();
          if (rightAvailableBitcoinSpace !== leftAvailableBitcoinSpace) {
            return rightAvailableBitcoinSpace > leftAvailableBitcoinSpace ? 1 : -1;
          }
          return left.vaultId - right.vaultId;
        });
      operationalAccounts.value = accounts;
      activeOperationalAccounts.value = accounts.filter(account => account.progress.isOperational);
      totalEconomicValue.value = economicValue;
    })();

    try {
      await updatePromise;
    } finally {
      updatePromise = undefined;
    }
  }

  function estimateBlocksCollected(startingFrameId: number): number {
    const frameSpan = 10;
    const endExclusiveFrameId = startingFrameId + frameSpan;

    if (miningFrames.currentFrameId < startingFrameId) return 0;
    if (miningFrames.currentFrameId >= endExclusiveFrameId) return NetworkConfig.ticksPerCohort;

    const completedFrames = miningFrames.currentFrameId - startingFrameId;
    const currentFrameProgress = miningFrames.getCurrentFrameProgress() / 100;
    const elapsedFrames = completedFrames + currentFrameProgress;

    return Math.round(elapsedFrames * NetworkConfig.rewardTicksPerFrame);
  }

  async function loadTotalEconomicValue(): Promise<bigint> {
    await currency.load();
    const [microgonsInCirculation, micronotsInCirculation] = await Promise.all([
      currency.fetchMicrogonsInCirculation(),
      currency.fetchMicronotsInCirculation(),
    ]);

    const microgonValueOfArgonots = currency.convertMicronotTo(micronotsInCirculation, UnitOfMeasurement.Microgon);

    return microgonsInCirculation + microgonValueOfArgonots;
  }

  const isLoadedPromise = update();

  return {
    isLoadedPromise,
    miningNodes,
    vaultNodes,
    activeNodes,
    miningSlots,
    activeMiningSeats,
    activeVaults,
    operationalAccounts,
    activeOperationalAccounts,
    totalEconomicValue,
    update,
  };
});

async function loadOperationalAccounts(): Promise<IOperationalAccount[]> {
  const [client, rewardConfig] = await Promise.all([getMainchainClient(false), getOperationalRewardConfig()]);
  const entries = await client.query.operationalAccounts.operationalAccounts.entries();

  return entries
    .map(([accountIdRaw, accountRaw]) => ({
      address: accountIdRaw.args[0].toString(),
      progress: getOperationalChainProgressFromAccount(accountRaw, rewardConfig),
    }))
    .sort((left, right) => left.address.localeCompare(right.address));
}
